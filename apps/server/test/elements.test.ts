import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FakeModelAdapter, type ModelEvent, type ModelRequest } from '@lingma/agent';
import {
  createDocumentSchema,
  type ElementGeneration,
  type ElementKind,
  elementDataSchema,
  elementGenerationInputSchema,
  elementKinds,
  providerInputSchema,
  writingRunInputSchema,
} from '@lingma/shared';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadMigrations } from '../src/db/database.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { openRuntime } from '../src/runtime.js';
import { NovelService } from '../src/services/novels.js';
import { SkillService } from '../src/services/skills.js';
import { WritingService } from '../src/writing/service.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function response(text: string): ModelEvent {
  return {
    type: 'response',
    response: {
      transcriptMessage: { role: 'assistant', content: text, toolCalls: [] },
      text,
      calls: [],
      stop: 'complete',
      usage: { inputTokens: 10, outputTokens: 20, cost: null },
    },
  };
}
type Task = {
  expectedShape: {
    items: {
      tempId: string;
      kind: ElementKind;
      title: string;
      targetDocumentId: string | null;
      content: string;
      data: ReturnType<typeof elementDataSchema.parse>;
      reason: string;
      openQuestions: string[];
    }[];
  };
  existing: { document: { id: string; kind: string }; version: { id: string } }[];
  elementContext: { kind: ElementKind; items: { documentId: string }[] }[];
  targetDocumentId: string | null;
  mode: string;
  context: { documentId: string; versionId: string; to: number }[];
};
function output(request: ModelRequest) {
  const task = JSON.parse(
    String(request.messages.find((message) => message.role === 'user')?.content),
  ) as Task;
  const item = task.expectedShape.items[0];
  if (!item) throw new Error('missing stage contract');
  const kind = item.kind;
  item.title = `${kind}设定`;
  item.data = elementDataSchema.parse(item.data);
  if (task.targetDocumentId) item.targetDocumentId = task.targetDocumentId;
  const world = task.elementContext.find((group) => group.kind === 'worldbuilding')?.items[0];
  if (kind === 'character' && world)
    item.data.links = [{ targetId: world.documentId, label: '居住于', nature: 'rule' }];
  if (task.mode === 'extract' && task.context[0]) {
    item.data.source = 'extracted';
    item.data.sources = [
      {
        documentId: task.context[0].documentId,
        versionId: task.context[0].versionId,
        from: 0,
        to: Math.min(5, task.context[0].to),
      },
    ];
  }
  return JSON.stringify({ items: [item] });
}
async function fixture(respond: (request: ModelRequest) => string = output) {
  const root = await mkdtemp(resolve(tmpdir(), 'lingma-elements-'));
  const runtime = await openRuntime(loadConfig({ DATA_DIR: 'data' }, root));
  const novels = new NovelService(runtime.db),
    project = novels.createProject('重置之城');
  const skills = new SkillService(runtime.db, runtime.blobs, runtime.gate, async () => {
    throw new Error('unused');
  });
  const requests: ModelRequest[] = [];
  const writing = new WritingService(runtime.db, novels, skills, {
    env: {},
    adapterFactory: (request) => {
      requests.push(request);
      return new FakeModelAdapter([[response(respond(request))]]);
    },
  });
  const provider = writing.providers.save(
    providerInputSchema.parse({
      name: '模拟模型',
      modelId: 'elements',
      connection: {
        api: 'openai-completions',
        provider: 'fixture',
        baseUrl: 'http://127.0.0.1:1/v1',
        credentialRef: null,
        contextWindow: 200000,
        maxOutputTokens: 16000,
      },
    }),
  );
  const input = elementGenerationInputSchema.parse({
    providerConfigId: provider.id,
    modelId: 'elements',
    kinds: ['worldbuilding'],
    idea: '邮差寻找明天',
  });
  const service = writing.elements;
  const app = createApp({
    ready: runtime.ready,
    logger: createLogger(() => {}),
    webDistDir: root,
    writing,
  });
  cleanup.push(async () => {
    await writing.close();
    await skills.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  async function settled(id: string): Promise<ElementGeneration> {
    let result = service.get(id);
    for (let i = 0; i < 300 && ['queued', 'running'].includes(result.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = service.get(id);
    }
    expect(['queued', 'running']).not.toContain(result.status);
    return result;
  }
  const readInput = () =>
    writingRunInputSchema.parse({
      projectId: project.id,
      sessionId: null,
      purpose: 'review',
      input: '检查设定',
      providerConfigId: provider.id,
      modelId: 'elements',
      context: { selectedVersionIds: [], allowSearch: true, allowFutureOutline: false },
      limits: {},
    });
  return {
    root,
    runtime,
    novels,
    project,
    skills,
    writing,
    service,
    input,
    provider,
    requests,
    settled,
    app,
    readInput,
  };
}

it('manages eight kinds, confirms versions, preserves legacy metadata and separates planning from facts', async () => {
  const f = await fixture();
  for (const kind of elementKinds) {
    const created = f.service.create(f.project.id, {
      kind,
      title: kind,
      data: { nature: kind === 'timeline_event' ? 'planned' : 'rule' },
    });
    expect(created.status).toBe('draft');
    f.service.confirm(created.document.id, created.version.id);
  }
  expect(f.service.list(f.project.id)).toHaveLength(8);
  let preview = await f.writing.preview(f.readInput());
  expect(preview.allowed).toHaveLength(7);
  preview = await f.writing.preview({
    ...f.readInput(),
    context: { ...f.readInput().context, allowFutureOutline: true },
  });
  expect(preview.allowed).toHaveLength(8);
  const world = f.service.list(f.project.id).find((e) => e.document.kind === 'worldbuilding');
  if (!world) throw new Error('missing world');
  const edited = f.service.save(world.document.id, {
    baseVersionId: world.version.id,
    title: '新世界',
    content: '新稿',
    data: world.data,
  });
  expect(edited.status).toBe('draft');
  expect(
    (await f.writing.preview(f.readInput())).allowed.find(
      (ref) => ref.documentId === world.document.id,
    )?.versionId,
  ).toBe(world.version.id);
  f.service.confirm(edited.document.id, edited.version.id);
  expect(
    (await f.writing.preview(f.readInput())).allowed.find(
      (ref) => ref.documentId === world.document.id,
    )?.versionId,
  ).toBe(edited.version.id);
  f.service.save(edited.document.id, {
    baseVersionId: edited.version.id,
    title: edited.document.title,
    content: edited.version.content,
    data: { ...edited.data, archived: true },
  });
  expect(
    (await f.writing.preview(f.readInput())).allowed.some(
      (ref) => ref.documentId === world.document.id,
    ),
  ).toBe(false);
  const legacy = f.novels.createDocument(
    f.project.id,
    createDocumentSchema.parse({
      baseStructureVersion: f.novels.getProject(f.project.id).structureVersion,
      kind: 'character',
      title: '旧人物',
      content: '不可丢失',
      metadata: { aliases: ['阿舟'], custom: 42 },
    }),
  );
  const entry = f.service.entry(legacy.document.id);
  f.service.save(entry.document.id, {
    baseVersionId: entry.version.id,
    title: entry.document.title,
    content: entry.version.content,
    data: entry.data,
  });
  expect(f.novels.getDocument(entry.document.id).version.metadata).toMatchObject({
    aliases: ['阿舟'],
    custom: 42,
  });
  expect(f.novels.getVersion(entry.document.id, legacy.version.id).content).toBe('不可丢失');
});

it('generates a single category with all eight filled latest versions and accepts related candidates atomically', async () => {
  const f = await fixture((request) => {
    const result = JSON.parse(output(request));
    const first = result.items[0];
    result.items.push({
      ...structuredClone(first),
      tempId: 'character_2',
      title: '第二个人物',
      data: { ...first.data, links: [{ targetId: first.tempId, label: '认识', nature: 'rule' }] },
    });
    return JSON.stringify(result);
  });
  const latest = elementKinds.map((kind) =>
    f.service.create(f.project.id, {
      kind,
      title: kind,
      content: `${kind}已填写`,
      data: { nature: kind === 'timeline_event' ? 'planned' : 'rule' },
    }),
  );
  f.service.create(f.project.id, { kind: 'worldbuilding', title: '空白占位', data: {} });
  await expect(
    f.service.createGeneration(f.project.id, { ...f.input, kinds: elementKinds }, randomUUID()),
  ).rejects.toThrow();
  const started = await f.service.createGeneration(
    f.project.id,
    { ...f.input, kinds: ['character'], mode: 'create' },
    randomUUID(),
  );
  const completed = await f.settled(started.id);
  expect(completed.status).toBe('completed');
  expect(completed.totalStages).toBe(1);
  expect(completed.candidates).toHaveLength(2);
  expect(f.requests).toHaveLength(1);
  const message = f.requests[0]?.messages.find((message) => message.role === 'user');
  const task = JSON.parse(message?.content ?? '{}');
  expect(task.elementContext.map((group: { kind: string }) => group.kind)).toEqual(elementKinds);
  expect(
    task.elementContext
      .flatMap((group: { items: { versionId: string }[] }) => group.items)
      .map((item: { versionId: string }) => item.versionId)
      .sort(),
  ).toEqual(latest.map((entry) => entry.version.id).sort());
  const second = completed.candidates[1];
  if (!second) throw new Error('missing');
  expect(() =>
    f.service.decide(
      completed.id,
      { action: 'accept', candidates: [{ id: second.id, revision: 1 }] },
      randomUUID(),
    ),
  ).toThrow('一并选择依赖');
  expect(f.service.list(f.project.id)).toHaveLength(9);
  const decision = {
      action: 'accept' as const,
      candidates: completed.candidates.map((c) => ({ id: c.id, revision: c.revision })),
    },
    key = randomUUID();
  const result = f.service.decide(completed.id, decision, key);
  expect(result.reviewStatus).toBe('accepted');
  expect(
    f.service.decide(completed.id, decision, key).candidates.map((c) => c.acceptedDocumentId),
  ).toEqual(result.candidates.map((c) => c.acceptedDocumentId));
  expect(f.service.list(f.project.id)).toHaveLength(11);
  expect(f.runtime.db.connection.pragma('foreign_key_check')).toEqual([]);
});

it('preserves locked fields during replacement and rejects the entire acceptance after a target edit', async () => {
  const f = await fixture((request) => {
    const task = JSON.parse(
      String(request.messages.find((message) => message.role === 'user')?.content),
    ) as Task;
    const item = task.expectedShape.items[0];
    if (!item) throw new Error('missing');
    item.title = 'AI 改名';
    item.targetDocumentId = task.targetDocumentId;
    item.data.fields = { rules: '无限回溯', cost: '无代价' };
    return JSON.stringify({ items: [item] });
  });
  const entry = f.service.create(f.project.id, {
    kind: 'worldbuilding',
    title: '时间规则',
    data: { fields: { rules: '最多十分钟' }, locked: ['fields.rules'] },
  });
  f.service.confirm(entry.document.id, entry.version.id);
  const job = await f.settled(
    (
      await f.service.createGeneration(
        f.project.id,
        {
          ...f.input,
          kinds: ['worldbuilding'],
          mode: 'replace',
          targetDocumentId: entry.document.id,
        },
        randomUUID(),
      )
    ).id,
  );
  expect(job.status).toBe('completed');
  expect(job.candidates[0]?.data.fields).toEqual({ rules: '最多十分钟', cost: '无代价' });
  f.service.save(entry.document.id, {
    baseVersionId: entry.version.id,
    title: '作者改名',
    content: '作者新稿',
    data: entry.data,
  });
  expect(() =>
    f.service.decide(
      job.id,
      {
        action: 'accept',
        candidates: job.candidates.map((c) => ({ id: c.id, revision: c.revision })),
      },
      randomUUID(),
    ),
  ).toThrow('文档已更新');
  expect(f.service.get(job.id).candidates[0]?.status).toBe('pending');
  expect(f.service.list(f.project.id)).toHaveLength(1);
  expect(f.novels.getDocument(entry.document.id).version.content).toBe('作者新稿');
});

it('repairs malformed single-category output once and preserves earlier jobs', async () => {
  let count = 0;
  const f = await fixture((request) => {
    count++;
    return count === 1 ? 'not json' : count > 2 ? 'bad again' : output(request);
  });
  const job = await f.settled(
    (
      await f.service.createGeneration(
        f.project.id,
        { ...f.input, kinds: ['story_premise'] },
        randomUUID(),
      )
    ).id,
  );
  expect(job.status).toBe('completed');
  expect(job.candidates).toHaveLength(1);
  expect(job.callCount).toBe(2);
  const failed = await f.settled(
    (
      await f.service.createGeneration(
        f.project.id,
        { ...f.input, kinds: ['worldbuilding'] },
        randomUUID(),
      )
    ).id,
  );
  expect(failed.status).toBe('failed');
  expect(failed.error).toContain('输出校验失败');
  expect(f.service.get(job.id).candidates).toHaveLength(1);
  expect(f.service.events(job.id, 0).some((event) => event.type === 'stage.repair')).toBe(true);
  expect(() => f.service.events(job.id, job.lastEventSeq + 1)).toThrow('游标');
});

it('previews freeze versions and API rejects invalid cross-project references', async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.project.id, { ...f.input, kinds: ['worldbuilding'] });
  f.service.create(f.project.id, {
    kind: 'worldbuilding',
    title: '新增规则',
    data: { summary: '已有内容' },
  });
  // Latest filled drafts are always included in generation context.
  const confirmed = f.service.list(f.project.id)[0];
  if (!confirmed) throw new Error('missing');
  f.service.confirm(confirmed.document.id, confirmed.version.id);
  await expect(
    f.service.createGeneration(
      f.project.id,
      { ...f.input, kinds: ['worldbuilding'], expectedHash: preview.hash },
      randomUUID(),
    ),
  ).rejects.toThrow('重新预览');
  const other = f.novels.createProject('别的书');
  const external = f.service.create(other.id, { kind: 'character', title: '他书人物', data: {} });
  const result = await f.app.request(`http://localhost/api/v1/projects/${f.project.id}/elements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'core_conflict',
      title: '越权关联',
      data: { links: [{ targetId: external.document.id, label: '对手' }] },
    }),
  });
  expect(result.status).toBe(403);
  expect(f.service.list(f.project.id)).toHaveLength(1);
});

it('extracts only from frozen sources and retains actual source versions', async () => {
  const f = await fixture();
  const doc = f.novels.createDocument(
    f.project.id,
    createDocumentSchema.parse({
      baseStructureVersion: 1,
      kind: 'chapter',
      title: '旧存稿',
      content: '旧城每晚重置。',
    }),
  );
  const job = await f.settled(
    (
      await f.service.createGeneration(
        f.project.id,
        {
          ...f.input,
          mode: 'extract',
          kinds: ['worldbuilding'],
          selectedVersionIds: [doc.version.id],
        },
        randomUUID(),
      )
    ).id,
  );
  expect(job.status).toBe('completed');
  expect(job.candidates[0]?.data.source).toBe('extracted');
  expect(job.candidates[0]?.data.sources[0]?.versionId).toBe(doc.version.id);
});

it('upgrades schema nine while preserving IDs, immutable versions and confirmed legacy elements', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'lingma-elements-upgrade-'));
  const config = loadConfig({ DATA_DIR: 'data' }, root);
  const old = await openRuntime(config, { migrations: loadMigrations().slice(0, 9) });
  const novels = new NovelService(old.db),
    project = novels.createProject('旧书');
  const chapter = novels.createDocument(
    project.id,
    createDocumentSchema.parse({
      baseStructureVersion: 1,
      kind: 'chapter',
      title: '旧章',
      content: '旧内容',
    }),
  );
  const docId = randomUUID(),
    versionId = randomUUID();
  old.db.transaction((db) => {
    db.prepare(
      "INSERT INTO documents(id,project_id,kind,title,current_version_id) VALUES(?,?,'character','旧人物',?)",
    ).run(docId, project.id, versionId);
    db.prepare(
      "INSERT INTO document_versions(id,document_id,version_no,content,metadata_json,content_hash,source,created_at) VALUES(?,?,1,'旧设定','{\"custom\":42}',?,'manual',?)",
    ).run(versionId, docId, 'a'.repeat(64), new Date().toISOString());
  });
  await old.close();
  const upgraded = await openRuntime(config);
  cleanup.push(async () => {
    await upgraded.close();
    await rm(root, { recursive: true, force: true });
  });
  const service = new NovelService(upgraded.db);
  expect(service.getDocument(chapter.document.id).version.id).toBe(chapter.version.id);
  expect(service.getDocument(docId).version.metadata.custom).toBe(42);
  expect(service.confirmedVersionId(service.getDocument(docId).document)).toBe(versionId);
  expect(upgraded.db.connection.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(upgraded.db.connection.pragma('foreign_key_check')).toEqual([]);
  expect(() =>
    upgraded.db.connection
      .prepare("UPDATE document_versions SET content='改写' WHERE id=?")
      .run(versionId),
  ).toThrow('immutable');
});

it('regenerates a single pending candidate, preserves its ID and author locks, and rejects stale revisions', async () => {
  const f = await fixture();
  const original = await f.settled(
    (
      await f.service.createGeneration(
        f.project.id,
        { ...f.input, kinds: ['worldbuilding'] },
        randomUUID(),
      )
    ).id,
  );
  const candidate = original.candidates[0];
  if (!candidate) throw new Error('missing');
  const payload = {
    tempId: candidate.tempId,
    kind: candidate.kind,
    title: candidate.title,
    targetDocumentId: candidate.targetDocumentId,
    content: candidate.content,
    reason: candidate.reason,
    openQuestions: candidate.openQuestions,
    data: {
      ...candidate.data,
      fields: { ...candidate.data.fields, rules: '作者锁定规则' },
      locked: ['fields.rules'],
    },
  };
  const edited = f.service.editCandidate(candidate.id, candidate.revision, payload);
  if (!edited) throw new Error('missing');
  const regenerated = await f.settled(
    (await f.service.regenerateCandidate(edited.id, edited.revision, randomUUID())).id,
  );
  expect(regenerated.candidates).toHaveLength(1);
  expect(regenerated.candidates[0]?.id).toBe(candidate.id);
  expect(regenerated.candidates[0]?.revision).toBe(3);
  expect(regenerated.candidates[0]?.data.fields.rules).toBe('作者锁定规则');
  expect(() =>
    f.service.decide(
      original.id,
      { action: 'accept', candidates: [{ id: candidate.id, revision: 1 }] },
      randomUUID(),
    ),
  ).toThrow('候选已更新');
});

it('cancels queued model work and resumes explicitly without replaying completed stages', async () => {
  let calls = 0;
  const f = await fixture((request) => (++calls === 1 ? 'invalid json' : output(request)));
  const job = await f.service.createGeneration(
    f.project.id,
    { ...f.input, kinds: ['worldbuilding'], maxCalls: 1 },
    randomUUID(),
  );
  const partial = await f.settled(job.id);
  expect(partial.status).toBe('failed');
  expect(partial.candidates).toHaveLength(0);
  const retried = await f.settled((await f.service.retry(job.id, randomUUID())).id);
  expect(retried.status).toBe('completed');
  expect(retried.candidates).toHaveLength(1);
  expect(f.requests).toHaveLength(2);
  const next = await f.service.createGeneration(
    f.project.id,
    { ...f.input, kinds: ['narrative_style'] },
    randomUUID(),
  );
  expect(f.service.cancel(next.id).status).toBe('cancelled');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.service.get(next.id).candidates).toHaveLength(0);
});
