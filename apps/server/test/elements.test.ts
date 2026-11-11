import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  FakeModelAdapter,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@lingma/agent';
import {
  createDocumentSchema,
  type ElementGeneration,
  type ElementKind,
  elementCandidatePayloadSchema,
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
function proposeBatch(items: unknown[]): ModelEvent {
  const call = {
    id: randomUUID(),
    name: 'propose_basic_information_batch',
    arguments: JSON.parse(JSON.stringify({ items })),
  };
  return {
    type: 'response',
    response: {
      text: '',
      calls: [call],
      stop: 'tool_calls',
      transcriptMessage: { role: 'assistant', content: '', toolCalls: [call] },
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
  const item =
    task.expectedShape.items?.[0] ??
    elementCandidatePayloadSchema.parse({
      tempId: 'story_premise_1',
      kind: 'story_premise',
      title: '名称',
      content: '补充说明',
      targetDocumentId: null,
      data: {},
      reason: '生成理由',
      openQuestions: [],
    });
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
async function fixture(
  respond: (request: ModelRequest) => string = output,
  factory?: (request: ModelRequest) => ModelAdapter,
) {
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
      return factory?.(request) ?? new FakeModelAdapter([[response(respond(request))]]);
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
  const projectId = randomUUID(),
    chapterId = randomUUID(),
    chapterVersionId = randomUUID(),
    stamp = new Date().toISOString();
  old.db.transaction((db) => {
    db.prepare('INSERT INTO projects(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(
      projectId,
      '旧书',
      stamp,
      stamp,
    );
    db.prepare(
      "INSERT INTO documents(id,project_id,kind,title,current_version_id) VALUES(?,?,'chapter','旧章',?)",
    ).run(chapterId, projectId, chapterVersionId);
    db.prepare(
      "INSERT INTO document_versions(id,document_id,version_no,content,metadata_json,content_hash,source,created_at) VALUES(?,?,1,'旧内容','{}',?,'manual',?)",
    ).run(chapterVersionId, chapterId, 'b'.repeat(64), stamp);
  });
  const project = { id: projectId };
  const chapter = { document: { id: chapterId }, version: { id: chapterVersionId } };
  const docId = randomUUID(),
    versionId = randomUUID();
  old.db.transaction((db) => {
    db.prepare(
      "INSERT INTO documents(id,project_id,kind,title,current_version_id) VALUES(?,?,'character','旧人物',?)",
    ).run(docId, projectId, versionId);
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

it('persists guided conversations, keeps suggestions pending and reads advanced edits on the next turn', async () => {
  const f = await fixture((request) => {
    const task = JSON.parse(
      String(request.messages.find((message) => message.role === 'user')?.content),
    );
    const item = JSON.parse(output(request)).items[0];
    item.title = '失踪的钟表匠';
    item.data.fields = { genre: '悬疑冒险', premise: task.idea };
    const existing = task.elementContext.find(
      (group: { kind: string }) => group.kind === 'story_premise',
    )?.items[0];
    item.targetDocumentId = existing?.documentId ?? null;
    return JSON.stringify({
      items: [item],
      guidance: {
        reply: '这是一个寻找亲人的悬疑冒险故事。成长主题是我的建议。',
        question: '你希望故事偏甜蜜日常，还是暗恋的酸涩？',
      },
    });
  });
  const input = {
    ...f.input,
    guided: true,
    kinds: ['story_premise' as const],
    mode: 'replace' as const,
    idea: '一名钟表匠在海边小镇寻找失踪的姐姐',
  };
  const first = await f.service.createGeneration(f.project.id, input, randomUUID());
  const result = await f.settled(first.id);
  expect(result.status).toBe('completed');
  expect(result.guidance?.question).toContain('甜蜜日常');
  expect(f.service.list(f.project.id)).toHaveLength(0);
  expect(f.service.jobs(f.project.id)[0]?.guidance).toEqual(result.guidance);
  const candidate = result.candidates[0];
  if (!candidate) throw new Error('missing suggestion');
  f.service.decide(
    result.id,
    { action: 'accept', candidates: [{ id: candidate.id, revision: candidate.revision }] },
    randomUUID(),
  );
  const entry = f.service.list(f.project.id)[0];
  if (!entry) throw new Error('missing accepted entry');
  f.service.save(entry.document.id, {
    baseVersionId: entry.version.id,
    title: entry.document.title,
    content: '高级模式补充：大学社团相识',
    data: { ...entry.data, locked: ['fields.genre'] },
  });
  const second = await f.service.createGeneration(
    f.project.id,
    { ...input, idea: '更喜欢甜蜜日常' },
    randomUUID(),
  );
  const next = await f.settled(second.id);
  expect(next.status).toBe('completed');
  expect(next.candidates[0]?.targetDocumentId).toBe(entry.document.id);
  expect(next.candidates[0]?.data.fields.genre).toBe('悬疑冒险');
  const task = JSON.parse(
    String(f.requests.at(-1)?.messages.find((message) => message.role === 'user')?.content),
  );
  expect(task.conversation).toHaveLength(1);
  expect(task.conversation[0].suggestions[0].status).toBe('accepted');
  expect(task.elementContext[0].items[0].content).toContain('大学社团相识');
  expect(task.expectedShape.guidance).toBeDefined();
});

it('allows discussion without candidates and rejects guided proposals outside basic information', async () => {
  let invalid = false;
  const f = await fixture((request) => {
    const item = JSON.parse(output(request)).items[0];
    item.kind = 'master_outline';
    item.data.fields = {};
    return JSON.stringify({
      items: invalid ? [item] : [],
      guidance: { reply: '我们可以先聊聊人物。', question: '她们是如何认识的？' },
    });
  });
  const input = {
    ...f.input,
    guided: true,
    kinds: ['story_premise' as const],
    mode: 'replace' as const,
  };
  const discussion = await f.service.createGeneration(f.project.id, input, randomUUID());
  expect((await f.settled(discussion.id)).guidance?.question).toBe('她们是如何认识的？');
  expect(f.service.list(f.project.id)).toHaveLength(0);
  invalid = true;
  const bad = await f.service.createGeneration(f.project.id, input, randomUUID());
  const failed = await f.settled(bad.id);
  expect(failed.status).toBe('failed');
  expect(failed.error).toContain('授权分类');
  expect(failed.candidates).toHaveLength(0);
});

it('can regenerate one guided suggestion without losing permission to edit other categories', async () => {
  const f = await fixture((request) => {
    const task = JSON.parse(
      String(request.messages.find((message) => message.role === 'user')?.content),
    );
    const sample = JSON.parse(output(request)).items[0];
    const items = task.regenerateCandidate
      ? [{ ...sample, ...task.regenerateCandidate }]
      : [
          sample,
          {
            ...sample,
            tempId: 'character_1',
            kind: 'character',
            title: '林舟',
            data: elementDataSchema.parse({ fields: { role: '主角' } }),
          },
        ];
    return JSON.stringify({
      items,
      guidance: { reply: '先整理两条建议。', question: '她们如何相识？' },
    });
  });
  const created = await f.service.createGeneration(
    f.project.id,
    { ...f.input, guided: true, kinds: ['story_premise'], mode: 'replace' },
    randomUUID(),
  );
  const original = await f.settled(created.id);
  const character = original.candidates.find((candidate) => candidate.kind === 'character');
  if (!character) throw new Error('missing character');
  const updated = await f.settled(
    (await f.service.regenerateCandidate(character.id, character.revision, randomUUID())).id,
  );
  expect(updated.status).toBe('completed');
  expect(updated.candidates).toHaveLength(2);
  const premise = updated.candidates.find((candidate) => candidate.kind === 'story_premise');
  if (!premise) throw new Error('missing premise');
  const { tempId, kind, title, targetDocumentId, content, data, reason, openQuestions } = premise;
  expect(() =>
    f.service.editCandidate(premise.id, premise.revision, {
      tempId,
      kind,
      title,
      targetDocumentId,
      content,
      data,
      reason,
      openQuestions,
    }),
  ).not.toThrow();
  expect(updated.guidance).not.toBeNull();
});

it('validates mutual links across a whole guided batch and adopts both characters atomically', async () => {
  const f = await fixture((request) => {
    const sample = JSON.parse(output(request)).items[0];
    return JSON.stringify({
      items: ['character_alpha', 'character_beta'].map((tempId, index, ids) => ({
        ...sample,
        tempId,
        kind: 'character',
        title: index ? '角色乙' : '角色甲',
        data: elementDataSchema.parse({
          fields: { role: '主角' },
          links: [{ targetId: ids[1 - index], label: '互相信任', nature: 'planned' }],
        }),
      })),
      guidance: { reply: '整理了两位互相信任的主角。', question: '他们如何相识？' },
    });
  });
  const job = await f.service.createGeneration(
    f.project.id,
    { ...f.input, guided: true, kinds: ['story_premise'], mode: 'replace' },
    randomUUID(),
  );
  const result = await f.settled(job.id);
  expect(result.status).toBe('completed');
  expect(result.callCount).toBe(1);
  expect(result.candidates).toHaveLength(2);
  expect(f.service.list(f.project.id)).toHaveLength(0);
  const first = result.candidates[0];
  if (!first) throw new Error('missing first character');
  expect(() =>
    f.service.decide(
      job.id,
      { action: 'accept', candidates: [{ id: first.id, revision: first.revision }] },
      randomUUID(),
    ),
  ).toThrow('一并选择依赖');
  expect(f.service.list(f.project.id)).toHaveLength(0);
  f.service.decide(
    job.id,
    {
      action: 'accept',
      candidates: result.candidates.map(({ id, revision }) => ({ id, revision })),
    },
    randomUUID(),
  );
  const entries = f.service.list(f.project.id);
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.status).toBe('confirmed');
    expect(entry.data.links[0]?.targetId).toBe(
      entries.find((other) => other.document.id !== entry.document.id)?.document.id,
    );
  }
});

it('still rejects nonexistent link targets in a guided batch', async () => {
  const f = await fixture((request) => {
    const sample = JSON.parse(output(request)).items[0];
    sample.data.links = [{ targetId: 'missing_character', label: '认识', nature: 'planned' }];
    return JSON.stringify({
      items: [sample],
      guidance: { reply: '整理设定建议。', question: '接下来想聊什么？' },
    });
  });
  const job = await f.service.createGeneration(
    f.project.id,
    { ...f.input, guided: true, kinds: ['story_premise'], mode: 'replace' },
    randomUUID(),
  );
  const result = await f.settled(job.id);
  expect(result.status).toBe('failed');
  expect(result.error).toContain('missing_character');
  expect(result.candidates).toHaveLength(0);
  expect(f.service.list(f.project.id)).toHaveLength(0);
});

it('retries a guided turn in place with preceding conversation, fresh settings and a new repair allowance', async () => {
  let targetCalls = 0;
  let retrying = false;
  const f = await fixture((request) => {
    const task = JSON.parse(
      String(request.messages.find((message) => message.role === 'user')?.content),
    );
    if (task.idea === '补全人物性格') {
      targetCalls++;
      if (!retrying || targetCalls === 3) return 'not json';
    }
    return JSON.stringify({
      items: [],
      guidance: { reply: `回应：${task.idea}`, question: '接下来想聊什么？' },
    });
  });
  const input = {
    ...f.input,
    guided: true,
    kinds: ['story_premise' as const],
    mode: 'replace' as const,
  };
  const world = f.service.create(f.project.id, {
    kind: 'worldbuilding',
    title: '故事背景',
    content: '旧设定',
  });
  const before = await f.service.createGeneration(
    f.project.id,
    { ...input, idea: '之前的故事想法' },
    randomUUID(),
  );
  await f.settled(before.id);
  const failed = await f.service.createGeneration(
    f.project.id,
    { ...input, idea: '补全人物性格' },
    randomUUID(),
  );
  expect((await f.settled(failed.id)).status).toBe('failed');
  const after = await f.service.createGeneration(
    f.project.id,
    { ...input, idea: '后来的讨论，不应带入旧消息重试' },
    randomUUID(),
  );
  await f.settled(after.id);
  const other = f.novels.createProject('其他作品');
  const otherJob = await f.service.createGeneration(
    other.id,
    { ...input, idea: '其他作品的消息' },
    randomUUID(),
  );
  await f.settled(otherJob.id);
  const latest = f.service.save(world.document.id, {
    baseVersionId: world.version.id,
    title: world.document.title,
    content: '高级模式刚修改的新设定',
    data: { ...world.data, fields: { era: '近未来' }, locked: ['fields.era'] },
  });
  retrying = true;
  const key = randomUUID();
  const retried = await f.service.retry(failed.id, key);
  expect(retried.id).toBe(failed.id);
  const result = await f.settled(retried.id);
  expect(result.status).toBe('completed');
  expect(result.callCount).toBe(4);
  expect(result.createdAt).toBe(failed.createdAt);
  expect(result.input.idea).toBe('补全人物性格');
  const task = JSON.parse(
    String(f.requests.at(-1)?.messages.find((message) => message.role === 'user')?.content),
  );
  expect(task.idea).toBe('补全人物性格');
  expect(task.conversation.map((turn: { author: string }) => turn.author)).toEqual([
    '之前的故事想法',
  ]);
  expect(task.conversation[0].assistant.reply).toBe('回应：之前的故事想法');
  const setting = task.elementContext.find(
    (group: { kind: string }) => group.kind === 'worldbuilding',
  ).items[0];
  expect(setting.versionId).toBe(latest.version.id);
  expect(setting.content).toBe('高级模式刚修改的新设定');
  expect(setting.metadata.element.locked).toEqual(['fields.era']);
  expect(task.repair).toBeTruthy();
  expect(f.service.jobs(f.project.id)).toHaveLength(3);
  const calls = f.requests.length;
  expect((await f.service.retry(failed.id, key)).status).toBe('completed');
  expect(f.requests).toHaveLength(calls);
});

it('allows another guided retry after the previous retry also fails', async () => {
  let valid = false;
  const f = await fixture(() =>
    valid
      ? JSON.stringify({
          items: [],
          guidance: { reply: '现在可以继续讨论了。', question: '接下来聊什么？' },
        })
      : 'invalid json',
  );
  const created = await f.service.createGeneration(
    f.project.id,
    { ...f.input, guided: true, kinds: ['story_premise'], mode: 'replace', maxCalls: 20 },
    randomUUID(),
  );
  expect((await f.settled(created.id)).status).toBe('failed');
  expect((await f.settled((await f.service.retry(created.id, randomUUID())).id)).status).toBe(
    'failed',
  );
  valid = true;
  const result = await f.settled((await f.service.retry(created.id, randomUUID())).id);
  expect(result.status).toBe('completed');
  expect(result.callCount).toBe(5);
  expect(f.service.jobs(f.project.id)).toHaveLength(1);
});

it('keeps guided setting text clean without removing meaningful suggestions or author edits', async () => {
  const f = await fixture((request) => {
    const item = JSON.parse(output(request)).items[0];
    item.title = '钟表匠的故事（建议）';
    item.content = '寻找失踪的亲人【AI 建议】';
    item.reason = '（AI建议）作者给出题材，本轮补充主题。';
    item.data.summary = '海边小镇的故事 (建议)';
    item.data.fields = {
      genre: '悬疑（建议）',
      premise: '（AI建议）钟表匠寻找失踪的姐姐',
      theme: '她常建议朋友先听完对方的解释。',
    };
    return JSON.stringify({
      items: [item],
      guidance: { reply: '我整理了这个故事的起点。', question: '她最后出现在哪里？' },
    });
  });
  const job = await f.service.createGeneration(
    f.project.id,
    { ...f.input, guided: true, kinds: ['story_premise'], mode: 'replace' },
    randomUUID(),
  );
  const result = await f.settled(job.id);
  expect(result.status).toBe('completed');
  const candidate = result.candidates[0];
  if (!candidate) throw new Error('missing candidate');
  expect(candidate.title).toBe('钟表匠的故事');
  expect(candidate.content).toBe('寻找失踪的亲人');
  expect(candidate.data.summary).toBe('海边小镇的故事');
  expect(candidate.reason).toBe('作者给出题材，本轮补充主题。');
  expect(candidate.data.fields).toEqual({
    genre: '悬疑',
    premise: '钟表匠寻找失踪的姐姐',
    theme: '她常建议朋友先听完对方的解释。',
  });
  const { tempId, kind, title, targetDocumentId, content, data, reason, openQuestions } = candidate;
  const edited = f.service.editCandidate(candidate.id, candidate.revision, {
    tempId,
    kind,
    title,
    targetDocumentId,
    content,
    data: { ...data, fields: { ...data.fields, genre: '作者手动标注（建议）' } },
    reason,
    openQuestions,
  });
  expect(edited?.data.fields.genre).toBe('作者手动标注（建议）');
});

it('uses one real tool call to propose cross-category updates with complete context and atomic adoption', async () => {
  const f = await fixture(output, (request) => {
    expect(request.toolDefinitions).toHaveLength(1);
    expect(request.toolDefinitions[0]).toMatchObject({ name: 'propose_basic_information_batch' });
    const task = JSON.parse(
      String(request.messages.find((message) => message.role === 'user')?.content),
    );
    expect(task.targetCount).toBeUndefined();
    expect(task.expectedShape.items).toBeUndefined();
    expect(
      task.existing.map((entry: { document: { kind: string } }) => entry.document.kind).sort(),
    ).toEqual(['character', 'core_conflict', 'story_premise', 'worldbuilding']);
    const items = f.service
      .list(f.project.id)
      .filter((entry) => entry.document.kind !== 'worldbuilding')
      .map((entry) =>
        elementCandidatePayloadSchema.parse({
          tempId: entry.document.kind,
          kind: entry.document.kind,
          targetDocumentId: entry.document.id,
          title: entry.document.title,
          content: `${entry.version.content}，共同面对危机，结局圆满`,
          data: {
            ...entry.data,
            locked: [],
            fields: {
              ...entry.data.fields,
              ...(entry.document.kind === 'story_premise'
                ? { genre: '不应覆盖锁定题材', theme: '共同成长' }
                : entry.document.kind === 'character'
                  ? { goal: '主动与同伴一起解决危机' }
                  : { choice: '携手化解危机，迎来圆满结局' }),
            },
          },
          reason: '同步落实作者确定的结局方向',
          openQuestions: [],
        }),
      );
    return new FakeModelAdapter([
      [proposeBatch(items)],
      [
        response(
          JSON.stringify({
            items: [], // The final reply must not erase the successfully submitted batch.
            guidance: {
              reply: '已整理定位、人物与冲突的同步修改，等待你采用。',
              question: '危机从哪里开始？',
            },
          }),
        ),
      ],
    ]);
  });
  const premise = f.service.create(f.project.id, {
    kind: 'story_premise',
    title: '故事定位',
    content: '关于彼此信任',
    data: { fields: { genre: '校园恋爱', emotion: '温暖' }, locked: ['fields.genre'] },
  });
  const character = f.service.create(f.project.id, {
    kind: 'character',
    title: '林舟',
    content: '安静而细心',
    data: { fields: { identity: '高中生' } },
  });
  const conflict = f.service.create(f.project.id, {
    kind: 'core_conflict',
    title: '信任的考验',
    content: '两人受到外界压力',
  });
  const unrelated = f.service.create(f.project.id, {
    kind: 'worldbuilding',
    title: '海边校园',
    content: '校园靠近海边',
  });
  const job = await f.service.createGeneration(
    f.project.id,
    {
      ...f.input,
      guided: true,
      kinds: ['story_premise'],
      mode: 'replace',
      idea: '要一起化解危机，结局圆满',
    },
    randomUUID(),
  );
  const result = await f.settled(job.id);
  expect(result.status).toBe('completed');
  expect(result.callCount).toBe(2);
  expect(result.candidates).toHaveLength(3);
  expect(result.candidates.every((candidate) => candidate.status === 'pending')).toBe(true);
  expect(
    result.candidates.find((candidate) => candidate.kind === 'story_premise')?.data.fields,
  ).toMatchObject({ genre: '校园恋爱', emotion: '温暖', theme: '共同成长' });
  for (const entry of [premise, character, conflict, unrelated])
    expect(f.service.entry(entry.document.id).version.id).toBe(entry.version.id);
  f.service.decide(
    result.id,
    {
      action: 'accept',
      candidates: result.candidates.map(({ id, revision }) => ({ id, revision })),
    },
    randomUUID(),
  );
  for (const entry of [premise, character, conflict]) {
    const updated = f.service.entry(entry.document.id);
    expect(updated.version.id).not.toBe(entry.version.id);
    expect(updated.status).toBe('confirmed');
    expect(updated.version.content).toContain('结局圆满');
  }
  expect(f.service.entry(unrelated.document.id).version.id).toBe(unrelated.version.id);
  expect(f.runtime.db.connection.pragma('foreign_key_check')).toEqual([]);
});

it('rejects invalid batches without partial proposals, allows correction and prevents duplicate submissions', async () => {
  const f = await fixture(output, () => {
    const first = elementCandidatePayloadSchema.parse({
      tempId: 'character_a',
      kind: 'character',
      title: '甲',
      targetDocumentId: null,
      content: '信任同伴',
      data: { links: [{ targetId: 'character_b', label: '同伴', nature: 'planned' }] },
      reason: '作者指定',
      openQuestions: [],
    });
    const second = {
      ...first,
      tempId: 'character_b',
      title: '乙',
      data: elementDataSchema.parse({}),
    };
    const invalid = { ...second, targetDocumentId: randomUUID() };
    return new FakeModelAdapter([
      [proposeBatch([first, invalid])],
      [proposeBatch([first, second])],
      [proposeBatch([first, second])],
      [
        response(
          JSON.stringify({
            guidance: { reply: '两位人物已一起整理。', question: '她们在哪里认识？' },
          }),
        ),
      ],
    ]);
  });
  const job = await f.service.createGeneration(
    f.project.id,
    {
      ...f.input,
      guided: true,
      kinds: ['story_premise'],
      mode: 'replace',
    },
    randomUUID(),
  );
  const result = await f.settled(job.id);
  expect(result.status).toBe('completed');
  expect(result.callCount).toBe(4);
  expect(result.candidates).toHaveLength(2);
  expect(f.service.list(f.project.id)).toHaveLength(0);
  const outcomes = f.runtime.db.connection
    .prepare('SELECT result_json FROM tool_executions ORDER BY rowid')
    .all() as { result_json: string }[];
  expect(outcomes.map((row) => JSON.parse(row.result_json).ok)).toEqual([false, true, false]);
  expect(JSON.parse(outcomes[0]?.result_json ?? '{}').error.message).toContain('冻结范围');
  expect(JSON.parse(outcomes[2]?.result_json ?? '{}').error.message).toContain('已提交完整批次');
});

it('does not publish a submitted batch when the final model request exceeds the call budget', async () => {
  const f = await fixture(
    output,
    () =>
      new FakeModelAdapter([
        [
          proposeBatch([
            elementCandidatePayloadSchema.parse({
              tempId: 'character_a',
              kind: 'character',
              title: '甲',
              targetDocumentId: null,
              content: '安静',
              data: {},
              reason: '作者指定',
              openQuestions: [],
            }),
          ]),
        ],
        [response(JSON.stringify({ guidance: { reply: '整理完毕。', question: '接下来呢？' } }))],
      ]),
  );
  const job = await f.service.createGeneration(
    f.project.id,
    {
      ...f.input,
      guided: true,
      kinds: ['story_premise'],
      mode: 'replace',
      maxCalls: 1,
    },
    randomUUID(),
  );
  const result = await f.settled(job.id);
  expect(result.status).toBe('failed');
  expect(result.callCount).toBe(1);
  expect(result.candidates).toHaveLength(0);
  expect(f.service.list(f.project.id)).toHaveLength(0);
  expect(result.error).toContain('BUDGET_LIMIT');
});
