import type { DocumentDetail, NovelSave } from '@lingma/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.js';
import { DraftStore } from '../src/editor/drafts.js';

const id = '11111111-1111-4111-8111-111111111111';
function detail(
  content = '初稿',
  version = '22222222-2222-4222-8222-222222222222',
): DocumentDetail {
  return {
    document: {
      id,
      projectId: id,
      volumeId: null,
      kind: 'chapter',
      chapterId: null,
      title: '第一章',
      sortOrder: 0,
      currentVersionId: version,
      deletedAt: null,
    },
    version: {
      id: version,
      documentId: id,
      versionNo: 1,
      content,
      metadata: {},
      contentHash: 'a'.repeat(64),
      source: 'manual',
      createdAt: new Date().toISOString(),
    },
  };
}
function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}
const stores: DraftStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});
describe('serial document drafts', () => {
  it('recovers a pending document even when another chapter is selected, and deduplicates concurrent loads', async () => {
    const storage = memoryStorage();
    const api = {
      document: vi.fn(async () => detail()),
      save: async () => {
        throw new Error('offline');
      },
    };
    const previous = new DraftStore(api, storage);
    stores.push(previous);
    previous.open(detail());
    previous.edit(id, { content: '另一章的待保存草稿' });
    const reopened = new DraftStore(api, storage);
    stores.push(reopened);
    await Promise.all([reopened.recover([id]), reopened.load(id)]);
    expect(api.document).toHaveBeenCalledTimes(1);
    expect(reopened.get(id)?.content).toBe('另一章的待保存草稿');
    expect(reopened.get(id)?.status).toBe('dirty');
  });
  it('never has two saves in flight for a document and saves edits made while waiting', async () => {
    const calls: NovelSave[] = [];
    const resolvers: ((value: DocumentDetail) => void)[] = [];
    const store = new DraftStore({
      document: async () => detail(),
      save: async (_id, input) => {
        calls.push(input);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    });
    stores.push(store);
    store.open(detail());
    store.edit(id, { content: '第一次输入' });
    const flight = store.flush(id);
    store.edit(id, { content: '保存期间继续输入' });
    expect(store.flush(id)).toBe(flight);
    expect(calls).toHaveLength(1);
    resolvers[0]?.(detail('第一次输入', '33333333-3333-4333-8333-333333333333'));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.baseVersionId).toBe('33333333-3333-4333-8333-333333333333');
    expect(store.get(id)?.status).toBe('saving');
    resolvers[1]?.(detail('保存期间继续输入', '44444444-4444-4444-8444-444444444444'));
    await flight;
    expect(store.get(id)?.status).toBe('saved');
    expect(store.get(id)?.savedContent).toBe('保存期间继续输入');
  });
  it('keeps dirty documents when navigating to another and auto-saves after the debounce', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_id: string, input: NovelSave) => detail(input.content));
    const store = new DraftStore({ document: async () => detail(), save });
    stores.push(store);
    store.open(detail());
    store.edit(id, { content: '不丢失' });
    const second = detail();
    second.document.id = '55555555-5555-4555-8555-555555555555';
    store.open(second);
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.get(id)?.content).toBe('不丢失');
  });
  it('retains local content on a conflict and only saves after explicit resolution with the remote version', async () => {
    const remote = detail('服务器新稿', '33333333-3333-4333-8333-333333333333');
    const inputs: NovelSave[] = [];
    const save = vi.fn(async (_id: string, input: NovelSave) => {
      inputs.push(input);
      if (inputs.length === 1) throw new ApiError('VERSION_CONFLICT', '文档已更新');
      return detail(input.content, '44444444-4444-4444-8444-444444444444');
    });
    const store = new DraftStore({ document: async () => remote, save });
    stores.push(store);
    store.open(detail());
    store.edit(id, { content: '本地不同稿' });
    await store.flush(id);
    expect(store.get(id)?.status).toBe('conflict');
    expect(store.get(id)?.content).toBe('本地不同稿');
    expect(store.get(id)?.remote?.version.content).toBe('服务器新稿');
    store.edit(id, { content: '手动合并稿' });
    await store.flush(id);
    expect(save).toHaveBeenCalledTimes(1);
    await store.resolve(id, 'local');
    expect(inputs[1]?.baseVersionId).toBe(remote.version.id);
    expect(store.get(id)?.status).toBe('saved');
  });
  it('recovers a failed draft after reopening and rejects invalid metadata without sending it', async () => {
    const storage = memoryStorage();
    const save = vi.fn(async () => {
      throw new Error('network down');
    });
    const store = new DraftStore({ document: async () => detail(), save }, storage);
    stores.push(store);
    store.open(detail());
    store.edit(id, { content: '失败草稿' });
    await store.flush(id);
    expect(store.get(id)?.status).toBe('error');
    const reopened = new DraftStore({ document: async () => detail(), save }, storage);
    stores.push(reopened);
    expect(reopened.open(detail()).content).toBe('失败草稿');
    reopened.edit(id, { metadataText: '{broken' });
    await reopened.flush(id);
    expect(reopened.get(id)?.error).toContain('JSON');
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('stops recovered stale drafts at conflict and can explicitly discard the local draft', async () => {
    const storage = memoryStorage();
    const store = new DraftStore(
      {
        document: async () => detail(),
        save: async () => {
          throw new Error('offline');
        },
      },
      storage,
    );
    stores.push(store);
    store.open(detail());
    store.edit(id, { content: '找回的草稿' });
    const remote = detail('更新后的远端', '33333333-3333-4333-8333-333333333333');
    const recovered = new DraftStore(
      { document: async () => remote, save: async () => remote },
      storage,
    );
    stores.push(recovered);
    expect(recovered.open(remote).status).toBe('conflict');
    await recovered.resolve(id, 'remote');
    expect(recovered.get(id)?.content).toBe('更新后的远端');
    expect(recovered.get(id)?.status).toBe('saved');
  });
});
