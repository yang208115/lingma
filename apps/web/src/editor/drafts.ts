import type { DocumentDetail, NovelSave } from '@lingma/shared';
import { metadataSchema, novelLimits } from '@lingma/shared';
import { ApiError } from '../api.js';

export type DraftStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
export interface Draft {
  id: string;
  projectId: string;
  baseVersionId: string;
  content: string;
  metadataText: string;
  savedContent: string;
  savedMetadataText: string;
  status: DraftStatus;
  error: string | null;
  remote: DocumentDetail | null;
  recoveryWarning: string | null;
}
interface DraftApi {
  document(id: string): Promise<DocumentDetail>;
  save(id: string, input: NovelSave): Promise<DocumentDetail>;
}
interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One serial save loop per document; the store lives above project/chapter navigation. */
export class DraftStore {
  private readonly drafts = new Map<string, Draft>();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly loads = new Map<string, Promise<Draft>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  constructor(
    private readonly api: DraftApi,
    private readonly storage?: DraftStorage,
    private readonly delayMs = 800,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.revision;
  get(id: string): Draft | undefined {
    return this.drafts.get(id);
  }
  all(): Draft[] {
    return [...this.drafts.values()];
  }
  load(id: string): Promise<Draft> {
    const existing = this.get(id);
    if (existing) return Promise.resolve(existing);
    const loading = this.loads.get(id);
    if (loading) return loading;
    const promise = this.api
      .document(id)
      .then((detail) => this.open(detail))
      .finally(() => this.loads.delete(id));
    this.loads.set(id, promise);
    return promise;
  }
  async recover(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!this.get(id) && this.storage?.getItem(this.key(id))) await this.load(id);
    }
  }
  isDirty(draft: Draft): boolean {
    return draft.content !== draft.savedContent || draft.metadataText !== draft.savedMetadataText;
  }
  open(detail: DocumentDetail): Draft {
    const existing = this.get(detail.document.id);
    if (existing) return existing;
    const metadataText = JSON.stringify(detail.version.metadata, null, 2);
    const draft: Draft = {
      id: detail.document.id,
      projectId: detail.document.projectId,
      baseVersionId: detail.version.id,
      content: detail.version.content,
      metadataText,
      savedContent: detail.version.content,
      savedMetadataText: metadataText,
      status: 'saved',
      error: null,
      remote: null,
      recoveryWarning: null,
    };
    try {
      const raw = this.storage?.getItem(this.key(draft.id));
      if (raw) {
        const recovered = JSON.parse(raw) as Partial<Draft>;
        if (
          typeof recovered.content !== 'string' ||
          recovered.content.length > novelLimits.documentChars ||
          typeof recovered.metadataText !== 'string' ||
          typeof recovered.baseVersionId !== 'string'
        )
          throw new Error('草稿格式无效');
        draft.content = recovered.content;
        draft.metadataText = recovered.metadataText;
        if (recovered.baseVersionId !== detail.version.id) {
          draft.baseVersionId = recovered.baseVersionId;
          draft.savedContent =
            typeof recovered.savedContent === 'string' ? recovered.savedContent : '';
          draft.savedMetadataText =
            typeof recovered.savedMetadataText === 'string' ? recovered.savedMetadataText : '{}';
          draft.remote = detail;
          draft.status = 'conflict';
          draft.error = '已找回本标签页草稿，但服务器版本已变化，请比较后处理';
        } else if (this.isDirty(draft)) draft.status = 'dirty';
      }
    } catch {
      draft.recoveryWarning = '无法读取本标签页的恢复草稿，请勿关闭未保存页面';
    }
    this.drafts.set(draft.id, draft);
    this.notify();
    if (draft.status === 'dirty') this.schedule(draft.id);
    return draft;
  }
  edit(id: string, change: Partial<Pick<Draft, 'content' | 'metadataText'>>): void {
    const draft = this.required(id);
    Object.assign(draft, change);
    if (draft.status !== 'conflict') {
      draft.status = this.flights.has(id) ? 'saving' : this.isDirty(draft) ? 'dirty' : 'saved';
      draft.error = null;
    }
    this.persist(draft);
    this.notify();
    if (draft.status !== 'conflict') this.schedule(id);
  }
  flush(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const existing = this.flights.get(id);
    if (existing) return existing;
    const draft = this.required(id);
    if (!this.isDirty(draft) || draft.status === 'conflict') return Promise.resolve();
    const flight = this.saveLoop(draft).finally(() => {
      this.flights.delete(id);
      this.notify();
    });
    this.flights.set(id, flight);
    return flight;
  }
  async refreshConflict(id: string): Promise<void> {
    const draft = this.required(id);
    try {
      draft.remote = await this.api.document(id);
      draft.error = '服务器版本已读取，请比较后选择处理方式';
    } catch (error) {
      draft.error = error instanceof Error ? error.message : '无法读取服务器版本';
    }
    this.notify();
  }
  async resolve(id: string, choice: 'remote' | 'local'): Promise<void> {
    const draft = this.required(id);
    if (!draft.remote) return;
    // Let the failed request finish before a new loop may start.
    await this.flights.get(id);
    const remote = draft.remote;
    draft.baseVersionId = remote.version.id;
    draft.savedContent = remote.version.content;
    draft.savedMetadataText = JSON.stringify(remote.version.metadata, null, 2);
    if (choice === 'remote') {
      draft.content = draft.savedContent;
      draft.metadataText = draft.savedMetadataText;
    }
    draft.remote = null;
    draft.error = null;
    draft.status = this.isDirty(draft) ? 'dirty' : 'saved';
    this.persist(draft);
    this.notify();
    if (choice === 'local') await this.flush(id);
  }
  replace(detail: DocumentDetail): void {
    const draft = this.get(detail.document.id);
    if (draft && this.isDirty(draft)) throw new Error('请先保存或处理草稿再恢复历史');
    this.forget(detail.document.id);
    this.open(detail);
  }
  forget(id: string): void {
    if (this.flights.has(id)) throw new Error('保存尚在进行，请稍后再试');
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.drafts.delete(id);
    this.storage?.removeItem(this.key(id));
    this.notify();
  }
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  private async saveLoop(draft: Draft): Promise<void> {
    while (this.isDirty(draft) && draft.status !== 'conflict') {
      const content = draft.content;
      const metadataText = draft.metadataText;
      draft.status = 'saving';
      this.notify();
      try {
        if (content.length > novelLimits.documentChars)
          throw new Error('正文超过 100 万字符，请拆成多个章节');
        let metadata: NovelSave['metadata'];
        try {
          metadata = metadataSchema.parse(JSON.parse(metadataText));
        } catch {
          throw new Error('元数据必须是有效的 JSON 对象，且不超过 64Ki 字符');
        }
        const result = await this.api.save(draft.id, {
          baseVersionId: draft.baseVersionId,
          content,
          metadata,
        });
        draft.baseVersionId = result.version.id;
        draft.savedContent = content;
        draft.savedMetadataText = metadataText;
        draft.status = this.isDirty(draft) ? 'dirty' : 'saved';
        draft.error = null;
        this.persist(draft);
        this.notify();
      } catch (error) {
        draft.error = error instanceof Error ? error.message : '保存失败，草稿已保留';
        draft.status =
          error instanceof ApiError && error.code === 'VERSION_CONFLICT' ? 'conflict' : 'error';
        this.persist(draft);
        this.notify();
        if (draft.status === 'conflict') await this.refreshConflict(draft.id);
        return;
      }
    }
  }
  private schedule(id: string): void {
    const previous = this.timers.get(id);
    if (previous) clearTimeout(previous);
    this.timers.set(
      id,
      setTimeout(() => {
        void this.flush(id);
      }, this.delayMs),
    );
  }
  private persist(draft: Draft): void {
    try {
      if (this.isDirty(draft))
        this.storage?.setItem(
          this.key(draft.id),
          JSON.stringify({
            baseVersionId: draft.baseVersionId,
            content: draft.content,
            metadataText: draft.metadataText,
            savedContent: draft.savedContent,
            savedMetadataText: draft.savedMetadataText,
          }),
        );
      else this.storage?.removeItem(this.key(draft.id));
    } catch {
      draft.recoveryWarning = '本标签页草稿备份失败，请保持页面打开并重试保存';
    }
  }
  private key(id: string): string {
    return `lingma:draft:${id}`;
  }
  private required(id: string): Draft {
    const draft = this.get(id);
    if (!draft) throw new Error('尚未加载文档');
    return draft;
  }
  private notify(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
