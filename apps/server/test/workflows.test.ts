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
  agentProfileConfigSchema,
  createDocumentSchema,
  elementDataSchema,
  jsonSchema,
  type WorkflowArtifactPayload,
  type WorkflowRun,
  workflowDependencies,
  workflowInputSchema,
  workflowTemplateConfigSchema,
  writingRunInputSchema,
} from '@lingma/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { openRuntime } from '../src/runtime.js';
import { NovelService } from '../src/services/novels.js';
import { SkillService } from '../src/services/skills.js';
import { WritingService } from '../src/writing/service.js';

const cleanups: (() => Promise<void>)[] = [];
const usage = { inputTokens: 20, outputTokens: 10, cost: null };
function response(payload?: WorkflowArtifactPayload): ModelEvent {
  const calls = payload
    ? [{ id: randomUUID(), name: 'submit_workflow_artifact', arguments: jsonSchema.parse(payload) }]
    : [];
  return {
    type: 'response',
    response: {
      text: payload ? '已提交' : '节点完成',
      calls,
      transcriptMessage: {
        role: 'assistant',
        content: payload ? '已提交' : '节点完成',
        toolCalls: calls,
      },
      stop: calls.length ? 'tool_calls' : 'complete',
      usage,
    },
  };
}
type Task = {
  targetDocumentId: string | null;
  workflowNode: {
    key: string;
    stage: string;
    reviewedArtifactId: string | null;
    expectedType: string;
  };
  upstream: { id: string; payload: WorkflowArtifactPayload }[];
};
async function fixture(
  options: {
    issue?: boolean;
    revisions?: number;
    invalid?: boolean;
    factory?: (r: ModelRequest) => ModelAdapter;
  } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), 'lingma-workflows-'));
  const config = loadConfig({ DATA_DIR: 'data' }, root);
  const runtime = await openRuntime(config);
  const novels = new NovelService(runtime.db);
  const skills = new SkillService(runtime.db, runtime.blobs, runtime.gate, async () => {
    throw new Error('unused');
  });
  const requests: ModelRequest[] = [];
  const factory = (request: ModelRequest) => {
    requests.push(request);
    if (options.factory) return options.factory(request);
    const first = request.messages[0];
    const t = JSON.parse(first?.role === 'user' ? first.content : '{}') as Task;
    const node = t.workflowNode;
    const draft = t.upstream.find((a) => a.payload.type === 'chapter_draft');
    const quote =
      draft?.payload.type === 'chapter_draft' ? draft.payload.content : '来客说出密室位置';
    let payload: WorkflowArtifactPayload;
    if (node?.expectedType === 'chapter_plan')
      payload = { type: 'chapter_plan', content: '主角听雨，发现来客的破绽。', openQuestions: [] };
    else if (node?.expectedType === 'chapter_draft')
      payload = {
        type: 'chapter_draft',
        title: '雨夜来客',
        content:
          node.stage === 'revise'
            ? '来客低头看着雨水，主角没有揭穿。'
            : '来客说出密室位置，主角抬起头。',
        notes: '完整候选',
      };
    else if (node?.expectedType === 'element_candidates')
      payload = {
        type: 'element_candidates',
        items: [
          {
            tempId: 'world-1',
            kind: 'worldbuilding',
            title: '雨城规则',
            targetDocumentId: t.targetDocumentId,
            content: '每次使用魔法都会失去一段记忆。',
            data: elementDataSchema.parse({
              fields: { rules: '使用魔法需要付出代价', cost: '失去记忆' },
            }),
            reason: '建立可执行的规则',
            openQuestions: [],
          },
        ],
      };
    else if (node?.expectedType === 'master_outline_candidate')
      payload = {
        type: 'master_outline_candidate',
        title: '雾港总纲',
        content: '起点：来客抵港。转折：记忆消失。高潮：主角以记忆换取真相。结局：重建规则。',
        reason: '规划主线',
        citations: [],
      };
    else if (node?.expectedType === 'outline_event_batch')
      payload = {
        type: 'outline_event_batch',
        items: [
          {
            title: '来客抵港',
            storyTime: '第一天',
            summary: '来客打破平静',
            content: '主角在港口遇到失忆来客。',
          },
          {
            title: '规则的代价',
            storyTime: '第二天',
            summary: '魔法消耗记忆',
            content: '主角发现救人的代价是失去记忆。',
          },
        ],
        reason: '拆分主线事件',
        citations: [],
      };
    else if (node?.expectedType === 'analysis_note')
      payload = { type: 'analysis_note', content: '保持悬念。', openQuestions: [] };
    else
      payload = {
        type: 'review_report',
        reviewedArtifactId: node?.reviewedArtifactId ?? randomUUID(),
        domain: 'custom',
        coverage: ['人物知识边界', '场景动机'],
        uncovered: [],
        issues:
          options.issue && Number(node?.key.match(/-r(\d+)$/)?.[1] ?? 0) < (options.revisions ?? 1)
            ? [
                {
                  id: 'knowledge',
                  severity: 'P0',
                  description: '来客不应知道密室位置',
                  quote,
                  sourceCitationIds: ['author'],
                  suggestion: '改为含糊试探',
                },
              ]
            : [],
      };
    return new FakeModelAdapter(
      options.invalid ? [[response()]] : [[response(payload)], [response()]],
    );
  };
  let writing = new WritingService(runtime.db, novels, skills, { adapterFactory: factory });
  const project = novels.createProject('雾港');
  const chapter = novels.createDocument(
    project.id,
    createDocumentSchema.parse({
      baseStructureVersion: project.structureVersion,
      kind: 'chapter',
      title: '雨夜来客',
      content: '旧正文。',
    }),
  );
  const provider = writing.providers.save({
    name: '本地测试',
    modelId: 'fixture',
    connection: {
      api: 'openai-completions',
      provider: 'fixture',
      baseUrl: 'http://127.0.0.1:1/v1',
      credentialRef: null,
      contextWindow: 64000,
      maxOutputTokens: 4096,
      reasoning: false,
      pricing: null,
    },
    parameters: {},
  });
  const template = writing.workflows.library.templates()[0];
  const version = template?.versions[0];
  if (!version) throw new Error('missing template');
  const input = workflowInputSchema.parse({
    projectId: project.id,
    targetDocumentId: chapter.document.id,
    baseVersionId: chapter.version.id,
    templateVersionId: version.id,
    providerConfigId: provider.id,
    input: '写一章，来客不能知道密室位置。',
  });
  cleanups.push(async () => {
    await writing.close();
    await skills.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    runtime,
    novels,
    skills,
    project,
    chapter,
    provider,
    input,
    requests,
    get writing() {
      return writing;
    },
    restart: async () => {
      await writing.close();
      writing = new WritingService(runtime.db, novels, skills, { adapterFactory: factory });
    },
    app: () =>
      createApp({
        writing,
        novels,
        skills,
        ready: runtime.ready,
        logger: createLogger(() => {}),
        webDistDir: config.webDistDir,
      }),
  };
}
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function state(f: Awaited<ReturnType<typeof fixture>>, id: string, status: string) {
  let result: WorkflowRun | undefined;
  await vi.waitFor(
    () => {
      result = f.writing.workflows.get(id);
      expect(
        result.status,
        JSON.stringify(result.nodes.map((n) => [n.name, n.status, n.error])),
      ).toBe(status);
    },
    { timeout: 5000, interval: 10 },
  );
  return result as WorkflowRun;
}
async function runAll(f: Awaited<ReturnType<typeof fixture>>) {
  const service = f.writing.workflows;
  const w = await service.create(f.input, randomUUID());
  const waiting = await state(f, w.id, 'awaiting_input');
  service.decide(
    w.id,
    { action: 'confirm_plan', expectedRevision: waiting.revision, feedback: '' },
    randomUUID(),
  );
  return state(f, w.id, 'awaiting_acceptance');
}

it('runs planning, two independent reviews and creates only a final proposal; acceptance is idempotent', async () => {
  const f = await fixture();
  const w = await runAll(f);
  expect(w.nodes.every((n) => n.status === 'succeeded')).toBe(true);
  expect(w.modelCalls).toBe(8);
  expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe('旧正文。');
  expect(w.proposal?.status).toBe('pending');
  expect(
    w.nodes.flatMap((n) => n.runIds).flatMap((id) => f.writing.store.proposals(id)),
  ).toHaveLength(1);
  for (const request of f.requests.filter((r) => r.systemPrompt.includes('审校'))) {
    const first = request.messages[0];
    const data = JSON.parse(first?.role === 'user' ? first.content : '{}') as Task;
    expect(data.upstream.some((a) => a.payload.type === 'review_report')).toBe(false);
  }
  const a = f.writing.store.accept(w.proposalId as string, randomUUID());
  expect(f.writing.store.accept(w.proposalId as string, randomUUID())).toEqual(a);
  expect(f.writing.workflows.get(w.id).outcome).toBe('accepted');
  expect(f.novels.getDocument(f.chapter.document.id).version.versionNo).toBe(2);
});
it('performs one directed revision and re-reviews the new draft', async () => {
  const f = await fixture({ issue: true });
  const w = await runAll(f);
  expect(w.revisionCount).toBe(1);
  expect(w.nodes).toHaveLength(7);
  expect(w.modelCalls).toBe(14);
  expect(w.artifacts.filter((a) => a.payload.type === 'chapter_draft')).toHaveLength(2);
  expect(w.proposal?.content).toContain('没有揭穿');
});
it('keeps revising beyond one revision until the required reviews pass', async () => {
  const f = await fixture({ issue: true, revisions: 2 });
  const w = await runAll(f);
  expect(w.revisionCount).toBe(2);
  expect(w.modelCalls).toBe(20);
  expect(w.artifacts.filter((a) => a.payload.type === 'chapter_draft')).toHaveLength(3);
  expect(w.proposal?.content).toContain('没有揭穿');
});
it('lets users add a custom reviewer without changing a role enum and freezes published versions', async () => {
  const f = await fixture();
  const lib = f.writing.workflows.library;
  const p = lib.createProfile(
    agentProfileConfigSchema.parse({
      name: '悬疑伏笔审校员',
      capability: 'review',
      prompt: '检查伏笔，引用当前稿原文。',
      tools: [],
    }),
  );
  const published = lib.publishProfile(p.id, p.revision);
  const v = published.versions[0];
  if (!v) throw new Error('missing role');
  const t = lib.templates()[0];
  if (!t) throw new Error('missing template');
  const steps = [...t.draft.steps];
  steps.splice(4, 0, {
    key: 'suspense',
    name: '伏笔检查',
    stage: 'review',
    agentVersionId: v.id,
    required: true,
  });
  const custom = lib.createTemplate({ ...t.draft, name: '自定义悬疑流程', steps });
  const ready = lib.publishTemplate(custom.id, custom.revision);
  f.input.templateVersionId = ready.versions[0]?.id as string;
  const before = await f.writing.workflows.preview(f.input);
  const updated = lib.saveProfile(p.id, published.revision, {
    ...published.draft,
    prompt: '全新提示词',
  });
  lib.publishProfile(p.id, updated.revision);
  const w = await runAll(f);
  expect(w.snapshot.profiles.find((p) => p.id === v.id)?.config.prompt).toBe(v.config.prompt);
  expect(w.nodes.some((n) => n.key === 'suspense')).toBe(true);
  expect(before.hash).toBe(w.snapshot.hash);
});
it('rejects incompatible capabilities and invalid stage order before starting', async () => {
  const f = await fixture();
  const t = f.writing.workflows.library.templates()[0];
  if (!t) throw new Error('missing');
  expect(() =>
    f.writing.workflows.library.createTemplate({
      ...t.draft,
      steps: t.draft.steps.map((s) =>
        s.stage === 'review'
          ? { ...s, agentVersionId: t.draft.steps[1]?.agentVersionId as string }
          : s,
      ),
    }),
  ).toThrow('不兼容');
  expect(
    workflowTemplateConfigSchema.safeParse({ ...t.draft, steps: [...t.draft.steps].reverse() })
      .success,
  ).toBe(false);
});
it('does not pass incomplete artifacts downstream and retries use a fresh run', async () => {
  const f = await fixture({ invalid: true });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const failed = await state(f, w.id, 'failed');
  expect(failed.artifacts).toHaveLength(0);
  expect(failed.nodes[1]?.runIds).toHaveLength(0);
  f.writing.workflows.decide(
    w.id,
    { action: 'retry', expectedRevision: failed.revision, feedback: '' },
    randomUUID(),
  );
  const again = await state(f, w.id, 'failed');
  expect(failed.formatRepairs).toBe(1);
  expect(again.nodes[0]?.runIds).toHaveLength(3);
  expect(again.modelCalls).toBe(3);
});
it('holds project writing ownership while awaiting approval and releases it on cancellation', async () => {
  const f = await fixture();
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const waiting = await state(f, w.id, 'awaiting_input');
  const write = writingRunInputSchema.parse({
    projectId: f.project.id,
    sessionId: null,
    purpose: 'write',
    input: '续写',
    target: { documentId: f.chapter.document.id, baseVersionId: f.chapter.version.id },
    providerConfigId: f.provider.id,
    modelId: 'fixture',
    context: { selectedVersionIds: [], allowSearch: false, allowFutureOutline: false },
    limits: {},
  });
  await expect(f.writing.create(write, randomUUID())).rejects.toThrow('协作写作');
  f.writing.workflows.decide(
    w.id,
    { action: 'cancel', expectedRevision: waiting.revision, feedback: '' },
    randomUUID(),
  );
  expect(f.writing.workflows.get(w.id).status).toBe('cancelled');
  await expect(f.writing.create(write, randomUUID())).resolves.toMatchObject({ status: 'queued' });
});
it('detects preview and revision conflicts and preserves immutable profile versions', async () => {
  const f = await fixture();
  const service = f.writing.workflows;
  const p = service.library.profiles()[0];
  if (!p) throw new Error('missing');
  expect(() => service.library.saveProfile(p.id, 999, p.draft)).toThrow('配置已变化');
  const old = await service.preview(f.input);
  f.writing.prompt.save({ revision: f.writing.prompt.get().revision, prompt: '更改全局规则' });
  await expect(
    service.create({ ...f.input, expectedPreviewHash: old.hash }, randomUUID()),
  ).rejects.toThrow('重新预览');
  expect(service.list(f.project.id)).toHaveLength(0);
});
it('does not overwrite manual edits when final proposal is accepted', async () => {
  const f = await fixture();
  const w = await runAll(f);
  f.novels.saveDocument(f.chapter.document.id, {
    baseVersionId: f.chapter.version.id,
    content: '作者的新正文',
    metadata: {},
  });
  expect(() => f.writing.store.accept(w.proposalId as string, randomUUID())).toThrow();
  expect(f.writing.workflows.get(w.id).proposal?.status).toBe('stale');
  expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe('作者的新正文');
});
it('re-reviews a manually edited candidate and keeps the older draft and reports', async () => {
  const f = await fixture();
  let w = await runAll(f);
  const old = w.latestDraftId;
  f.writing.workflows.decide(
    w.id,
    {
      action: 'edit_candidate',
      expectedRevision: w.revision,
      feedback: '',
      content: '来客只谈雨势。',
    },
    randomUUID(),
  );
  w = await state(f, w.id, 'awaiting_acceptance');
  expect(w.latestDraftId).not.toBe(old);
  expect(w.artifacts.some((a) => a.id === old)).toBe(true);
  expect(w.proposal?.content).toBe('来客只谈雨势。');
  expect(w.artifacts.filter((a) => a.payload.type === 'review_report')).toHaveLength(4);
});
it('keeps waiting states and historical configs across restart', async () => {
  const f = await fixture();
  const w = await f.writing.workflows.create(f.input, randomUUID());
  await state(f, w.id, 'awaiting_input');
  await f.restart();
  const restored = f.writing.workflows.get(w.id);
  expect(restored.status).toBe('awaiting_input');
  expect(restored.artifacts).toHaveLength(1);
  f.writing.workflows.decide(
    w.id,
    { action: 'confirm_plan', expectedRevision: restored.revision, feedback: '' },
    randomUUID(),
  );
  expect((await state(f, w.id, 'awaiting_acceptance')).modelCalls).toBe(8);
});
it('serves custom role CRUD, publication and SSE cursor validation through HTTP', async () => {
  const f = await fixture();
  const app = f.app();
  const req = await app.request('http://localhost/api/v1/agent-profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(
      agentProfileConfigSchema.parse({
        name: '对白润色师',
        capability: 'draft',
        prompt: '保留情节，只润色对白。',
      }),
    ),
  });
  expect(req.status).toBe(201);
  const { data: p } = await req.json();
  const pub = await app.request(`http://localhost/api/v1/agent-profiles/${p.id}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ expectedRevision: p.revision }),
  });
  expect(pub.status).toBe(200);
  const w = await f.writing.workflows.create(f.input, randomUUID());
  expect(
    (await app.request(`http://localhost/api/v1/workflows/${w.id}/events?after=9999&check=1`))
      .status,
  ).toBe(400);
});

it('tests an unpublished role draft with frozen permissions and no formal proposal', async () => {
  const f = await fixture();
  const lib = f.writing.workflows.library;
  const p = lib.createProfile(
    agentProfileConfigSchema.parse({
      name: '私人文风检查',
      capability: 'review',
      prompt: '检查对白是否自然。',
      tools: [],
    }),
  );
  const result = await f.writing.workflows.testProfile(p.id, p.revision, f.input, randomUUID());
  await vi.waitFor(() => expect(f.writing.store.summary(result.run.id).status).toBe('completed'));
  const tested = f.writing.workflows.testResult(result.run.id);
  expect(tested.artifact?.type).toBe('review_report');
  expect(tested.run.proposals).toHaveLength(0);
  expect(lib.profile(p.id).versions).toHaveLength(0);
  expect(tested.run.preview.request.toolDefinitions).toHaveLength(1);
  expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe('旧正文。');
});
it('recognizes a completed child after restart instead of repeating its paid calls', async () => {
  const f = await fixture();
  const service = f.writing.workflows;
  const w = await service.create(f.input, randomUUID());
  // Simulate a crash after child commit but before parent transition.
  const spy = vi.spyOn(service, 'pump').mockResolvedValue();
  const runId = service.get(w.id).nodes[0]?.runIds[0];
  if (!runId) throw new Error('missing child');
  await vi.waitFor(() => expect(f.writing.store.summary(runId).status).toBe('completed'));
  spy.mockRestore();
  await f.restart();
  const restored = f.writing.workflows.get(w.id);
  expect(restored.status).toBe('interrupted');
  f.writing.workflows.decide(
    w.id,
    { action: 'resume', expectedRevision: restored.revision, feedback: '' },
    randomUUID(),
  );
  const waiting = await state(f, w.id, 'awaiting_input');
  expect(waiting.nodes[0]?.runIds).toEqual([runId]);
  expect(waiting.modelCalls).toBe(2);
});
it('continues re-reviewing beyond the former total model call cap', async () => {
  const f = await fixture();
  const lib = f.writing.workflows.library;
  const t = lib.templates()[0];
  if (!t) throw new Error('missing');
  const updated = lib.saveTemplate(t.id, t.revision, {
    ...t.draft,
    autoRevise: false,
  });
  const published = lib.publishTemplate(t.id, updated.revision);
  f.input.templateVersionId = published.versions[0]?.id as string;
  const w = await runAll(f);
  expect(w.modelCalls).toBe(8);
  f.writing.workflows.decide(
    w.id,
    {
      action: 'edit_candidate',
      expectedRevision: w.revision,
      feedback: '',
      content: '作者修改后的完整正文。',
    },
    randomUUID(),
  );
  const reviewed = await state(f, w.id, 'awaiting_acceptance');
  expect(reviewed.modelCalls).toBe(12);
  expect(reviewed.proposalId).not.toBeNull();
});
it('resumes a failed node from its committed artifact checkpoint', async () => {
  let interrupted = true;
  const f = await fixture({
    factory: (request) => {
      const first = request.messages[0];
      const t = JSON.parse(first?.role === 'user' ? first.content : '{}') as Task;
      if (!interrupted) return new FakeModelAdapter([[response()]]);
      if (t.workflowNode.stage === 'plan' && interrupted) {
        interrupted = false;
        return new FakeModelAdapter([
          [response({ type: 'chapter_plan', content: '章纲已经保存', openQuestions: [] })],
          new Error('synthetic provider error'),
        ]);
      }
      return new FakeModelAdapter([
        [response({ type: 'chapter_plan', content: '不应重复生成', openQuestions: [] })],
        [response()],
      ]);
    },
  });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const failed = await state(f, w.id, 'failed');
  expect(failed.modelCalls).toBe(2);
  f.writing.workflows.decide(
    w.id,
    { action: 'resume', expectedRevision: failed.revision, feedback: '' },
    randomUUID(),
  );
  const waiting = await state(f, w.id, 'awaiting_input');
  expect(waiting.modelCalls).toBe(3);
  expect(waiting.artifacts[0]?.payload).toMatchObject({ content: '章纲已经保存' });
});

it('requires an explicit snapshot decision when reference material changes before acceptance', async () => {
  const f = await fixture();
  const character = f.novels.createDocument(
    f.project.id,
    createDocumentSchema.parse({
      baseStructureVersion: f.novels.getProject(f.project.id).structureVersion,
      kind: 'character',
      title: '林舟',
      content: '主角不知道密室位置。',
    }),
  );
  const w = await runAll(f);
  f.novels.saveDocument(character.document.id, {
    baseVersionId: character.version.id,
    content: '主角已知道密室位置。',
    metadata: {},
  });
  expect(f.writing.workflows.get(w.id).sourceChanges).toContain('林舟');
  expect(() => f.writing.store.accept(w.proposalId as string, randomUUID())).toThrow(
    '参考资料已更新',
  );
  let current = f.writing.workflows.get(w.id);
  expect(current.proposal?.status).toBe('pending');
  f.writing.workflows.decide(
    w.id,
    { action: 'use_snapshot', expectedRevision: current.revision, feedback: '' },
    randomUUID(),
  );
  f.writing.store.accept(w.proposalId as string, randomUUID());
  current = f.writing.workflows.get(w.id);
  expect(current.outcome).toBe('accepted');
});
it('refreshes reference snapshots and re-reviews the same manuscript with preserved history', async () => {
  const f = await fixture();
  const character = f.novels.createDocument(
    f.project.id,
    createDocumentSchema.parse({
      baseStructureVersion: f.novels.getProject(f.project.id).structureVersion,
      kind: 'character',
      title: '来客',
      content: '来客是商人。',
    }),
  );
  let w = await runAll(f);
  const prior = w.latestDraftId;
  f.novels.saveDocument(character.document.id, {
    baseVersionId: character.version.id,
    content: '来客是信使。',
    metadata: {},
  });
  await f.writing.workflows.refreshSources(w.id, w.revision, undefined, randomUUID());
  w = await state(f, w.id, 'awaiting_acceptance');
  expect(w.sourceHistory).toHaveLength(1);
  expect(w.latestDraftId).not.toBe(prior);
  expect(w.sourceChanges).toHaveLength(0);
  expect(w.artifacts.filter((a) => a.payload.type === 'review_report')).toHaveLength(4);
  f.writing.store.accept(w.proposalId as string, randomUUID());
  expect(f.writing.workflows.get(w.id).outcome).toBe('accepted');
});
it('requires an author merge before rebasing a proposal onto changed formal text', async () => {
  const f = await fixture();
  let w = await runAll(f);
  f.novels.saveDocument(f.chapter.document.id, {
    baseVersionId: f.chapter.version.id,
    content: '作者新添了重要伏笔。',
    metadata: {},
  });
  await expect(
    f.writing.workflows.refreshSources(w.id, w.revision, undefined, randomUUID()),
  ).rejects.toThrow('合并后的完整稿');
  await f.writing.workflows.refreshSources(
    w.id,
    w.revision,
    '作者新添了重要伏笔。来客低头避开目光。',
    randomUUID(),
  );
  w = await state(f, w.id, 'awaiting_acceptance');
  f.writing.store.accept(w.proposalId as string, randomUUID());
  expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe(
    '作者新添了重要伏笔。来客低头避开目光。',
  );
});
it('cancels an active model call and never starts downstream nodes', async () => {
  const f = await fixture({
    factory: () => ({
      id: 'fake/v1',
      async *stream(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        yield response();
      },
    }),
  });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  await vi.waitFor(() => expect(f.writing.workflows.get(w.id).modelCalls).toBe(1));
  const current = f.writing.workflows.get(w.id);
  f.writing.workflows.decide(
    w.id,
    { action: 'cancel', expectedRevision: current.revision, feedback: '' },
    randomUUID(),
  );
  const id = current.nodes[0]?.runIds[0];
  if (!id) throw new Error('missing');
  await vi.waitFor(() => expect(f.writing.store.summary(id).status).toBe('cancelled'));
  const stopped = f.writing.workflows.get(w.id);
  expect(stopped.status).toBe('cancelled');
  expect(stopped.nodes[1]?.runIds).toHaveLength(0);
  expect(stopped.artifacts).toHaveLength(0);
});

it.each(['worldbuilding', 'master_outline', 'story_events'] as const)(
  'runs %s without a chapter, restores its session and accepts the typed result exactly once',
  async (taskType) => {
    const f = await fixture();
    const project = f.novels.createProject(`空作品-${taskType}`);
    const session = f.writing.store.session(project.id, null, '通用编排');
    const template = f.writing.workflows.library
      .templates()
      .find((item) => item.draft.taskType === taskType)?.versions[0];
    if (!template) throw new Error('missing creative template');
    const input = workflowInputSchema.parse({
      projectId: project.id,
      taskType,
      sessionId: session.id,
      templateVersionId: template.id,
      providerConfigId: f.provider.id,
      input: '构建雾港的设定与主线。',
    });
    const preview = await f.writing.workflows.preview(input);
    const created = await f.writing.workflows.create(
      { ...input, expectedPreviewHash: preview.hash },
      randomUUID(),
    );
    let w = await state(f, created.id, 'awaiting_acceptance');
    expect(w.proposalId).toBeNull();
    expect(f.novels.getStructure(project.id).documents).toHaveLength(0);
    expect(f.writing.workflows.list(project.id, session.id).map((item) => item.id)).toEqual([w.id]);
    await f.restart();
    w = f.writing.workflows.get(w.id);
    expect(w.status).toBe('awaiting_acceptance');
    const key = randomUUID();
    const decision = {
      action: 'accept_result' as const,
      expectedRevision: w.revision,
      feedback: '',
    };
    const accepted = f.writing.workflows.decide(w.id, decision, key);
    expect(accepted.status).toBe('completed');
    expect(accepted.outcome).toBe('accepted');
    expect(f.writing.workflows.decide(w.id, decision, key).acceptedResults).toEqual(
      accepted.acceptedResults,
    );
    const docs = f.novels.getStructure(project.id).documents;
    expect(docs).toHaveLength(taskType === 'story_events' ? 2 : 1);
    expect(
      docs.every(
        (doc) => doc.kind === (taskType === 'story_events' ? 'chapter_outline' : taskType),
      ),
    ).toBe(true);
    expect(docs.every((doc) => doc.kind !== 'chapter')).toBe(true);
    expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe('旧正文。');
  },
);

it('rejects incompatible tasks and cross-type targets before model execution', async () => {
  const f = await fixture();
  const service = f.writing.workflows;
  const template = service.library
    .templates()
    .find((item) => item.draft.taskType === 'worldbuilding')?.versions[0];
  if (!template) throw new Error('missing template');
  await expect(service.preview({ ...f.input, taskType: 'worldbuilding' })).rejects.toThrow();
  await expect(
    service.preview({ ...f.input, taskType: 'worldbuilding', templateVersionId: template.id }),
  ).rejects.toThrow('目标类型');
  expect(f.requests).toHaveLength(0);
});

it('preserves locked worldbuilding fields and refuses a stale target on acceptance', async () => {
  const f = await fixture();
  const world = f.writing.elements.create(f.project.id, {
    kind: 'worldbuilding',
    title: '世界规则',
    content: '作者原稿',
    data: { fields: { rules: '绝不能复活死者' }, locked: ['fields.rules', 'content'] },
  });
  const template = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.taskType === 'worldbuilding')?.versions[0];
  if (!template) throw new Error('missing template');
  const input = workflowInputSchema.parse({
    ...f.input,
    taskType: 'worldbuilding',
    mode: 'replace',
    templateVersionId: template.id,
    targetDocumentId: world.document.id,
    baseVersionId: world.version.id,
  });
  const created = await f.writing.workflows.create(input, randomUUID());
  const w = await state(f, created.id, 'awaiting_acceptance');
  const draft = w.artifacts.find((item) => item.id === w.latestDraftId)?.payload;
  expect(draft?.type).toBe('element_candidates');
  if (draft?.type !== 'element_candidates') throw new Error('missing world candidate');
  expect(draft.items[0]?.data.fields.rules).toBe('绝不能复活死者');
  expect(draft.items[0]?.content).toBe('作者原稿');
  f.novels.saveDocument(world.document.id, {
    baseVersionId: world.version.id,
    content: '作者新稿',
    metadata: world.version.metadata,
  });
  expect(() =>
    f.writing.workflows.decide(
      w.id,
      { action: 'accept_result', expectedRevision: w.revision, feedback: '' },
      randomUUID(),
    ),
  ).toThrow();
  expect(f.novels.getDocument(world.document.id).version.content).toBe('作者新稿');
  expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe('旧正文。');
});

it('accepts worldbuilding dependencies atomically and resolves temporary references', async () => {
  const f = await fixture({
    factory: (request) => {
      const first = request.messages[0];
      const task = JSON.parse(first?.role === 'user' ? first.content : '{}');
      const payload: WorkflowArtifactPayload =
        task.workflowNode.expectedType === 'element_candidates'
          ? {
              type: 'element_candidates',
              items: ['city', 'magic'].map((tempId) => ({
                tempId,
                kind: 'worldbuilding',
                title: tempId,
                targetDocumentId: null,
                content: '港城与魔法',
                data: elementDataSchema.parse({
                  links: tempId === 'city' ? [{ targetId: 'magic', label: '遵循规则' }] : [],
                }),
                reason: '',
                openQuestions: [],
              })),
            }
          : {
              type: 'review_report',
              reviewedArtifactId: task.workflowNode.reviewedArtifactId,
              domain: 'rules',
              coverage: ['规则与引用'],
              uncovered: [],
              issues: [],
            };
      return new FakeModelAdapter([[response(payload)], [response()]]);
    },
  });
  const project = f.novels.createProject('依赖接受');
  const template = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.taskType === 'worldbuilding')?.versions[0];
  if (!template) throw new Error('missing template');
  const created = await f.writing.workflows.create(
    workflowInputSchema.parse({
      ...f.input,
      projectId: project.id,
      taskType: 'worldbuilding',
      targetDocumentId: null,
      baseVersionId: null,
      templateVersionId: template.id,
    }),
    randomUUID(),
  );
  let w = await state(f, created.id, 'awaiting_acceptance');
  expect(() =>
    f.writing.workflows.decide(
      w.id,
      { action: 'accept_result', expectedRevision: w.revision, feedback: '', itemIds: ['city'] },
      randomUUID(),
    ),
  ).toThrow('依赖');
  expect(f.novels.getStructure(project.id).documents).toHaveLength(0);
  w = f.writing.workflows.decide(
    w.id,
    { action: 'accept_result', expectedRevision: w.revision, feedback: '', itemIds: ['magic'] },
    randomUUID(),
  );
  expect(w.status).toBe('awaiting_acceptance');
  expect(w.acceptedResults).toHaveLength(1);
  const restored = f.writing.workflows.get(w.id);
  w = f.writing.workflows.decide(
    w.id,
    {
      action: 'accept_result',
      expectedRevision: restored.revision,
      feedback: '',
      itemIds: ['city'],
    },
    randomUUID(),
  );
  expect(w.status).toBe('completed');
  const city = w.acceptedResults.find((item) => item.itemId === 'city');
  const magic = w.acceptedResults.find((item) => item.itemId === 'magic');
  expect(city && magic).toBeTruthy();
  expect(f.writing.elements.entry(city?.documentId as string).data.links[0]?.targetId).toBe(
    magic?.documentId,
  );
  expect(f.novels.getStructure(project.id).documents).toHaveLength(2);
});

it('refuses a generator that tries to save another element category', async () => {
  const f = await fixture({
    factory: () =>
      new FakeModelAdapter([
        [
          response({
            type: 'element_candidates',
            items: [
              {
                tempId: 'foreign',
                kind: 'character',
                title: '越权人物',
                targetDocumentId: null,
                content: '不应保存',
                data: elementDataSchema.parse({}),
                reason: '',
                openQuestions: [],
              },
            ],
          }),
        ],
        [response()],
      ]),
  });
  const template = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.taskType === 'worldbuilding')?.versions[0];
  if (!template) throw new Error('missing template');
  const created = await f.writing.workflows.create(
    workflowInputSchema.parse({
      ...f.input,
      taskType: 'worldbuilding',
      targetDocumentId: null,
      baseVersionId: null,
      templateVersionId: template.id,
    }),
    randomUUID(),
  );
  const w = await state(f, created.id, 'failed');
  expect(w.latestDraftId).toBeNull();
  expect(f.novels.getStructure(f.project.id).documents.map((item) => item.kind)).toEqual([
    'chapter',
  ]);
});

it('creates a new chapter only after accepting its workflow result and includes it in session history', async () => {
  const f = await fixture();
  const project = f.novels.createProject('无章节正文编排');
  const session = f.writing.store.session(project.id, null, '开始创作');
  const input = workflowInputSchema.parse({
    ...f.input,
    projectId: project.id,
    sessionId: session.id,
    targetDocumentId: null,
    baseVersionId: null,
    input: '生成一章雨夜来客。',
  });
  const created = await f.writing.workflows.create(input, randomUUID());
  const plan = await state(f, created.id, 'awaiting_input');
  f.writing.workflows.decide(
    plan.id,
    { action: 'confirm_plan', expectedRevision: plan.revision, feedback: '' },
    randomUUID(),
  );
  const waiting = await state(f, created.id, 'awaiting_acceptance');
  expect(f.novels.getStructure(project.id).documents).toHaveLength(0);
  expect(f.writing.store.sessionDetail(session.id)).toMatchObject({
    runCount: 1,
    preview: '生成一章雨夜来客。',
  });
  expect(() => f.writing.store.deleteSession(session.id)).toThrow();
  const accepted = f.writing.workflows.decide(
    waiting.id,
    { action: 'accept_result', expectedRevision: waiting.revision, feedback: '' },
    randomUUID(),
  );
  expect(accepted.status).toBe('completed');
  expect(f.novels.getStructure(project.id).documents).toHaveLength(1);
  expect(
    f.novels.getDocument(accepted.acceptedResults[0]?.documentId as string).document.kind,
  ).toBe('chapter');
});

it('executes persisted graph dependencies rather than array order and isolates unrelated analysis', async () => {
  const f = await fixture();
  const lib = f.writing.workflows.library;
  const template = lib.templates()[0];
  if (!template) throw new Error('missing template');
  const producer = template.draft.steps.find((s) => s.stage === 'draft');
  const reviewer = template.draft.steps.find((s) => s.stage === 'review');
  const analystProfile = lib.createProfile(
    agentProfileConfigSchema.parse({
      name: '独立分析员',
      capability: 'analysis',
      prompt: '辅助分析，提交分析笔记。',
    }),
  );
  const analyst = lib.publishProfile(analystProfile.id, analystProfile.revision).versions[0];
  if (!producer || !reviewer || !analyst) throw new Error('missing roles');
  const graph = lib.createTemplate({
    ...template.draft,
    name: '显式依赖图',
    confirmPlan: false,
    autoRevise: false,
    steps: [
      { ...reviewer, key: 'review', dependsOn: ['produce'], position: { x: 600, y: 80 } },
      {
        key: 'side',
        name: '独立分析',
        stage: 'analysis',
        agentVersionId: analyst.id,
        required: true,
        dependsOn: [],
        position: { x: 0, y: 250 },
      },
      { ...producer, key: 'produce', dependsOn: [], position: { x: 300, y: 80 } },
    ],
  });
  const published = lib.publishTemplate(graph.id, graph.revision);
  f.input.templateVersionId = published.versions[0]?.id as string;
  const created = await f.writing.workflows.create(f.input, randomUUID());
  const done = await state(f, created.id, 'awaiting_acceptance');
  expect(done.nodes.map((n) => n.key)).toEqual(['side', 'produce', 'review']);
  const review = done.artifacts.find((a) => a.nodeKey === 'review');
  const output = done.artifacts.find((a) => a.nodeKey === 'produce');
  expect(review?.inputArtifactIds).toEqual([output?.id]);
  expect(done.artifacts.find((a) => a.nodeKey === 'produce')?.inputArtifactIds).toEqual([]);
  expect(lib.template(graph.id).draft.steps[0]?.position).toEqual({ x: 600, y: 80 });
});

it('rejects cycles, broken links, disconnected review and independent output branches before dispatch', async () => {
  const f = await fixture();
  const lib = f.writing.workflows.library;
  const template = lib.templates()[0];
  const producer = template?.draft.steps.find((s) => s.stage === 'draft');
  const reviewer = template?.draft.steps.find((s) => s.stage === 'review');
  if (!template || !producer || !reviewer) throw new Error('missing template');
  for (const steps of [
    [
      { ...producer, dependsOn: [reviewer.key] },
      { ...reviewer, dependsOn: [producer.key] },
    ],
    [
      { ...producer, dependsOn: ['missing'] },
      { ...reviewer, dependsOn: [producer.key] },
    ],
    [
      { ...producer, dependsOn: [] },
      { ...reviewer, dependsOn: [] },
    ],
    [
      { ...producer, dependsOn: [] },
      { ...producer, key: 'other', dependsOn: [] },
      { ...reviewer, dependsOn: [producer.key, 'other'] },
    ],
  ])
    expect(() => lib.createTemplate({ ...template.draft, steps })).toThrow();
  expect(f.requests).toHaveLength(0);
});

it('keeps legacy independent reviews on the same candidate while respecting explicit links', () => {
  const steps = [
    { key: 'plan', stage: 'plan' },
    { key: 'draft', stage: 'draft' },
    { key: 'continuity', stage: 'review' },
    { key: 'narrative', stage: 'review' },
    { key: 'revise', stage: 'revise' },
  ];
  const implicit = workflowDependencies(steps);
  expect(implicit.get('continuity')).toEqual(['draft']);
  expect(implicit.get('narrative')).toEqual(['draft']);
  expect(
    workflowDependencies(
      steps.map((s) => (s.key === 'narrative' ? { ...s, dependsOn: ['continuity'] } : s)),
    ).get('narrative'),
  ).toEqual(['continuity']);
});
