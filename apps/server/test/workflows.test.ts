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
  parseReviewMarkdown,
  type WorkflowRun,
  workflowInputSchema,
  workflowTemplateConfigSchema,
} from '@lingma/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { openRuntime } from '../src/runtime.js';
import { NovelService } from '../src/services/novels.js';
import { SkillService } from '../src/services/skills.js';
import { buildWorkflowResult, splitRecordSections } from '../src/workflows/adapters.js';
import { WritingService } from '../src/writing/service.js';

const cleanups: (() => Promise<void>)[] = [];
const usage = { inputTokens: 20, outputTokens: 10, cost: null };
const text = (content: string): ModelEvent => ({
  type: 'response',
  response: {
    text: content,
    calls: [],
    transcriptMessage: { role: 'assistant', content, toolCalls: [] },
    stop: 'complete',
    usage,
  },
});
type Task = {
  workflowNode: { key: string; stage: string; round: number };
  upstream: { id: string; kind: string; from: string; markdown: string; notes?: string }[];
  issuesToFix?: { id: string; summary: string }[];
  feedback: string;
};
const taskOf = (request: ModelRequest) => {
  const first = request.messages[0];
  return JSON.parse(first?.role === 'user' ? first.content : '{}') as Task;
};
const flaw = '来客说出密室位置';
const issueMarkdown = `### [P0] 来客不应知道密室位置\n> ${flaw}\n\n改为含糊试探。`;

async function fixture(
  options: {
    /** Number of review rounds that report an issue before the reviewers pass. */
    issueRounds?: number;
    reviewMarkdown?: string;
    factory?: (r: ModelRequest) => ModelAdapter;
    reviseSame?: boolean;
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
    const t = taskOf(request);
    const node = t.workflowNode;
    let reply: string;
    if (node.stage === 'plan') reply = '## 章纲\n主角听雨，发现来客的破绽。';
    else if (node.stage === 'analysis') reply = '保持悬念。';
    else if (node.stage === 'review')
      reply =
        options.reviewMarkdown ??
        (node.round < (options.issueRounds ?? 0) ? issueMarkdown : '无重要问题');
    else if (node.stage === 'revise')
      reply = options.reviseSame ? `${flaw}，主角抬起头。` : '来客低头看着雨水，主角没有揭穿。';
    else reply = `${flaw}，主角抬起头。`;
    return new FakeModelAdapter([[text(reply)]]);
  };
  const writing = new WritingService(runtime.db, novels, skills, { adapterFactory: factory });
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
  const template = writing.workflows.library
    .templates()
    .find((item) => item.draft.taskType === 'chapter_write');
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
    writing,
    template: template as NonNullable<typeof template>,
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
type Fixture = Awaited<ReturnType<typeof fixture>>;
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function state(f: Fixture, id: string, status: string) {
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
const decide = (
  f: Fixture,
  w: WorkflowRun,
  action: Parameters<Fixture['writing']['workflows']['decide']>[1]['action'],
  extra: Record<string, unknown> = {},
) =>
  f.writing.workflows.decide(
    w.id,
    { action, expectedRevision: w.revision, feedback: '', ...extra } as never,
    randomUUID(),
  );

it('runs the default pipeline unattended, merges reviews and stops at the final proposal', async () => {
  const f = await fixture();
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const done = await state(f, w.id, 'awaiting_acceptance');
  expect(done.nodes.filter((n) => n.round === 0).map((n) => [n.templateKey, n.status])).toEqual([
    ['plan', 'released'],
    ['draft', 'released'],
    ['continuity', 'released'],
    ['narrative', 'released'],
    ['merge', 'released'],
  ]);
  expect(done.modelCalls).toBe(4);
  expect(done.artifacts.map((a) => a.kind)).toEqual(['plan', 'draft', 'review', 'review', 'merge']);
  expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe('旧正文。');
  expect(done.proposal?.status).toBe('pending');
  const a = f.writing.store.accept(done.proposalId as string, randomUUID());
  expect(f.writing.store.accept(done.proposalId as string, randomUUID())).toEqual(a);
  expect(f.writing.workflows.get(w.id).outcome).toBe('accepted');
  expect(f.novels.getDocument(f.chapter.document.id).version.versionNo).toBe(2);
});

it('keeps reviewers independent of each other and sends them the same draft', async () => {
  const f = await fixture();
  const w = await f.writing.workflows.create(f.input, randomUUID());
  await state(f, w.id, 'awaiting_acceptance');
  const reviewers = f.requests.map(taskOf).filter((t) => t.workflowNode.stage === 'review');
  expect(reviewers).toHaveLength(2);
  for (const t of reviewers) {
    expect(t.upstream.some((a) => a.kind === 'review')).toBe(false);
    expect(t.upstream.some((a) => a.kind === 'draft')).toBe(true);
  }
  expect(reviewers[0]?.upstream.find((a) => a.kind === 'draft')?.id).toBe(
    reviewers[1]?.upstream.find((a) => a.kind === 'draft')?.id,
  );
});

it('revises only adopted issues, re-reviews as a new round and keeps old rounds as history', async () => {
  const f = await fixture({ issueRounds: 1 });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const done = await state(f, w.id, 'awaiting_acceptance');
  expect(done.revisionCount).toBe(1);
  expect(done.nodes.filter((n) => n.round === 1).map((n) => n.stage)).toEqual([
    'revise',
    'review',
    'review',
    'merge',
  ]);
  const revise = f.requests.map(taskOf).find((t) => t.workflowNode.stage === 'revise');
  expect(revise?.issuesToFix?.map((i) => i.summary)).toEqual(['来客不应知道密室位置']);
  expect(done.proposal?.content).toContain('没有揭穿');
  expect(done.artifacts.filter((a) => a.kind === 'draft')).toHaveLength(2);
  expect(done.nodes.every((n) => ['released', 'skipped'].includes(n.status))).toBe(true);
});

it('does not revise when the author ignores an issue; ignoring P0 needs a reason', async () => {
  const f = await fixture({ issueRounds: 1 });
  const input = { ...f.input, manualGates: true };
  const w = await f.writing.workflows.create(input, randomUUID());
  let current = await state(f, w.id, 'awaiting_input');
  // Release plan, draft and the two reviewers until the merge gate.
  for (
    let i = 0;
    i < 20 && current.nodes.find((n) => n.status === 'awaiting_gate')?.stage !== 'merge';
    i++
  ) {
    decide(f, current, 'release');
    await vi.waitFor(() => {
      current = f.writing.workflows.get(w.id);
      expect(current.status).toBe('awaiting_input');
    });
  }
  const merge = current.artifacts.find((a) => a.kind === 'merge');
  const issue = merge?.issues[0];
  if (!issue) throw new Error('missing merged issue');
  expect(() =>
    decide(f, current, 'set_adoption', { issueId: issue.id, adoption: 'ignore' }),
  ).toThrow('理由');
  decide(f, current, 'set_adoption', {
    issueId: issue.id,
    adoption: 'ignore',
    reason: '这是作者有意的设定',
  });
  current = f.writing.workflows.get(w.id);
  decide(f, current, 'release');
  const done = await state(f, w.id, 'awaiting_acceptance');
  expect(done.revisionCount).toBe(0);
  expect(done.adoption[issue.id]?.reason).toBe('这是作者有意的设定');
});

it('stops at a manual gate, lets the author edit the output and re-reviews on a new round', async () => {
  const f = await fixture();
  const steps = f.template.draft.steps.map((s) =>
    s.key === 'plan' ? { ...s, gate: 'manual' as const } : s,
  );
  const saved = f.writing.workflows.library.saveTemplate(
    f.template.id,
    f.template.revision,
    workflowTemplateConfigSchema.parse({ ...f.template.draft, steps }),
  );
  const published = f.writing.workflows.library.publishTemplate(saved.id, saved.revision);
  const input = { ...f.input, templateVersionId: published.versions[0]?.id as string };
  const w = await f.writing.workflows.create(input, randomUUID());
  const gate = await state(f, w.id, 'awaiting_input');
  expect(gate.reasonCode).toBe('GATE');
  expect(gate.nodes.find((n) => n.key === 'plan')?.status).toBe('awaiting_gate');
  expect(gate.nodes.find((n) => n.key === 'draft')?.status).toBe('pending');
  expect(f.requests).toHaveLength(1);
  decide(f, gate, 'edit_artifact', { nodeKey: 'plan', content: '## 章纲\n作者改过的章纲。' });
  const edited = f.writing.workflows.get(w.id);
  const authored = edited.artifacts.find((a) => a.createdBy === 'author');
  expect(authored?.supersedes).toBe(gate.artifacts[0]?.id);
  decide(f, edited, 'release', { nodeKey: 'plan' });
  await state(f, w.id, 'awaiting_acceptance');
  const draftRequest = f.requests.map(taskOf).find((t) => t.workflowNode.stage === 'draft');
  expect(draftRequest?.upstream.find((a) => a.kind === 'plan')?.markdown).toContain('作者改过');
});

it('invalidates downstream results when a generated draft is edited and reviews again', async () => {
  const f = await fixture();
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const first = await state(f, w.id, 'awaiting_acceptance');
  const before = f.requests.length;
  decide(f, first, 'edit_artifact', { nodeKey: 'draft', content: '作者直接改好的正文。' });
  const after = await state(f, w.id, 'awaiting_acceptance');
  expect(after.nodes.filter((n) => n.status === 'stale').length).toBeGreaterThanOrEqual(3);
  expect(after.round).toBe(1);
  expect(f.requests.length - before).toBe(2);
  expect(after.proposal?.content).toBe('作者直接改好的正文。');
  expect(after.artifacts.filter((a) => a.kind === 'draft')).toHaveLength(2);
});

it('stops without another automatic round when a revision returns identical text', async () => {
  const f = await fixture({ issueRounds: 5, reviseSame: true });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const waiting = await state(f, w.id, 'awaiting_input');
  expect(waiting.reasonCode).toBe('NO_CHANGE');
  expect(waiting.revisionCount).toBe(1);
});

it('keeps unstructured review prose as a suggestion and never retries', async () => {
  const f = await fixture({ reviewMarkdown: '整体不错，但节奏略慢，建议再紧凑一些。' });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const done = await state(f, w.id, 'awaiting_acceptance');
  const merge = done.artifacts.find((a) => a.kind === 'merge');
  expect(merge?.issues.length).toBeGreaterThan(0);
  expect(merge?.issues.every((i) => i.severity === 'P2' && !i.structured)).toBe(true);
  expect(done.revisionCount).toBe(0);
  expect(done.modelCalls).toBe(4);
});

it('fails a node that returns nothing without inventing an artifact', async () => {
  const f = await fixture({ factory: () => new FakeModelAdapter([[text('')]]) });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const failed = await state(f, w.id, 'failed');
  expect(failed.artifacts).toHaveLength(0);
  expect(failed.nodes[0]?.status).toBe('failed');
});

it('holds project writing ownership while awaiting approval and releases it on cancellation', async () => {
  const f = await fixture();
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const done = await state(f, w.id, 'awaiting_acceptance');
  await expect(f.writing.workflows.create(f.input, randomUUID())).rejects.toMatchObject({
    code: 'PROJECT_BUSY',
  });
  decide(f, done, 'cancel');
  expect(f.writing.workflows.get(w.id).status).toBe('cancelled');
  await f.writing.workflows.create(f.input, randomUUID());
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
        yield text('x');
      },
    }),
  });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  await vi.waitFor(() => expect(f.writing.workflows.get(w.id).modelCalls).toBe(1));
  const current = f.writing.workflows.get(w.id);
  decide(f, current, 'cancel');
  const id = current.nodes[0]?.runIds[0];
  if (!id) throw new Error('missing');
  await vi.waitFor(() => expect(f.writing.store.summary(id).status).toBe('cancelled'));
  const stopped = f.writing.workflows.get(w.id);
  expect(stopped.status).toBe('cancelled');
  expect(stopped.nodes[1]?.runIds).toHaveLength(0);
  expect(stopped.artifacts).toHaveLength(0);
});

it('rejects stale decisions and duplicate gate releases with a conflict', async () => {
  const f = await fixture();
  const w = await f.writing.workflows.create({ ...f.input, manualGates: true }, randomUUID());
  const gate = await state(f, w.id, 'awaiting_input');
  expect(() =>
    f.writing.workflows.decide(
      w.id,
      { action: 'release', expectedRevision: gate.revision - 1, feedback: '' },
      randomUUID(),
    ),
  ).toThrow();
  const key = randomUUID();
  const body = { action: 'release', expectedRevision: gate.revision, feedback: '' } as const;
  const one = f.writing.workflows.decide(w.id, body, key);
  const two = f.writing.workflows.decide(w.id, body, key);
  expect(two.revision).toBe(one.revision);
});

it('marks interrupted runs after a restart instead of calling the model again', async () => {
  const f = await fixture({
    factory: () => ({
      id: 'fake/v1',
      async *stream(_request, signal) {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
        yield text('x');
      },
    }),
  });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  await vi.waitFor(() => expect(f.writing.workflows.get(w.id).modelCalls).toBe(1));
  await f.writing.close();
  const reopened = new WritingService(f.runtime.db, f.novels, f.skills, {
    adapterFactory: () => new FakeModelAdapter([[text('不应调用')]]),
  });
  cleanups.push(() => reopened.close());
  const restored = reopened.workflows.get(w.id);
  expect(restored.status).toBe('interrupted');
  expect(restored.modelCalls).toBe(1);
});

it('serves templates through HTTP and validates cursors', async () => {
  const f = await fixture();
  const app = f.app();
  const created = await app.request('http://localhost/api/v1/agent-profiles', {
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
  expect(created.status).toBe(201);
  const w = await f.writing.workflows.create(f.input, randomUUID());
  expect(
    (await app.request(`http://localhost/api/v1/workflows/${w.id}/events?after=9999&check=1`))
      .status,
  ).toBe(400);
});

it('rejects invalid graphs before dispatch', () => {
  const id = randomUUID();
  const base = { name: '流程', taskType: 'chapter_write' as const };
  const step = (key: string, stage: string, dependsOn: string[] = []) => ({
    key,
    name: key,
    stage,
    agentVersionId: id,
    dependsOn,
  });
  expect(
    workflowTemplateConfigSchema.safeParse({
      ...base,
      steps: [step('a', 'draft', ['b']), step('b', 'review', ['a'])],
    }).success,
  ).toBe(false);
  expect(
    workflowTemplateConfigSchema.safeParse({
      ...base,
      steps: [step('a', 'draft'), step('b', 'review')],
    }).success,
  ).toBe(false);
  expect(
    workflowTemplateConfigSchema.safeParse({
      ...base,
      steps: [step('a', 'draft'), step('b', 'review', ['a']), step('c', 'review', ['b'])],
    }).success,
  ).toBe(false);
  expect(
    workflowTemplateConfigSchema.safeParse({
      ...base,
      steps: [step('a', 'draft'), step('b', 'review', ['a'])],
    }).success,
  ).toBe(true);
});

it('parses review Markdown leniently', () => {
  const draft = '来客说出密室位置，主角抬起头。';
  const issues = parseReviewMarkdown(
    '### [P1] 视角漂移\n> 主角抬起头\n\n建议保持限知。\n\n### [P2] 节奏\n说明',
    draft,
    'r',
  );
  expect(issues.map((i) => [i.severity, i.summary, i.located])).toEqual([
    ['P1', '视角漂移', true],
    ['P2', '节奏', false],
  ]);
  expect(parseReviewMarkdown('无重要问题', draft, 'r')).toEqual([]);
  expect(parseReviewMarkdown('', draft, 'r')).toEqual([]);
});

it('splits record sections and builds typed results from Markdown', () => {
  const md =
    '前言\n## [人物] 运阳\n> 冷静的学委\n外在目标：守住秩序\n她不爱说话。\n## [世界] 滨海小城\n海风';
  expect(splitRecordSections(md).map((s) => [s.tag, s.title])).toEqual([
    ['人物', '运阳'],
    ['世界', '滨海小城'],
  ]);
  const built = buildWorkflowResult(
    'basic_information',
    { targetDocumentId: null, mode: 'fill' },
    md,
    ['story_premise', 'worldbuilding', 'character', 'core_conflict', 'narrative_style'],
  );
  expect(built.result.type).toBe('element_candidates');
  if (built.result.type !== 'element_candidates') return;
  expect(built.result.items[0]).toMatchObject({
    kind: 'character',
    title: '运阳',
    content: '她不爱说话。',
    data: { summary: '冷静的学委', fields: { goal: '守住秩序' } },
  });
  expect(built.warnings[0]).toContain('未覆盖分类');
  expect(() =>
    buildWorkflowResult('basic_information', { targetDocumentId: null, mode: 'fill' }, '没有标题', [
      'character',
    ]),
  ).toThrow('分条');
  expect(() =>
    buildWorkflowResult(
      'basic_information',
      { targetDocumentId: null, mode: 'fill' },
      '## 无分类\n内容',
      ['character'],
    ),
  ).toThrow('分类标记');
  const chapter = buildWorkflowResult(
    'chapter_write',
    { targetDocumentId: null, mode: 'create' },
    '# 新的一章\n\n正文。',
    [],
  );
  expect(chapter.result).toMatchObject({
    type: 'chapter_draft',
    title: '新的一章',
    content: '正文。',
  });
  const events = buildWorkflowResult(
    'story_events',
    { targetDocumentId: null, mode: 'create' },
    '## 抵港\n时间：第一天\n概述：来客\n正文大纲',
    [],
  );
  expect(events.result).toMatchObject({
    type: 'outline_event_batch',
    items: [{ title: '抵港', storyTime: '第一天', summary: '来客', content: '正文大纲' }],
  });
});

it('runs every task type through the same pipeline and saves via the adapter', async () => {
  const f = await fixture({
    factory: (request) => {
      const t = taskOf(request);
      const first = request.messages[0];
      const data = JSON.parse(first?.role === 'user' ? first.content : '{}') as {
        taskType: string;
      };
      if (t.workflowNode.stage === 'review') return new FakeModelAdapter([[text('无重要问题')]]);
      return new FakeModelAdapter([
        [
          text(
            data.taskType === 'master_outline'
              ? '# 雾港总纲\n\n起点：来客抵港。'
              : data.taskType === 'story_events'
                ? '## 来客抵港\n时间：第一天\n概述：来客\n主角遇到来客。'
                : '## [世界] 雨城\n> 雨城规则\n规则与使用条件：魔法需要代价\n代价与限制：失去记忆',
          ),
        ],
      ]);
    },
  });
  for (const taskType of ['worldbuilding', 'master_outline', 'story_events'] as const) {
    const project = f.novels.createProject(`空作品-${taskType}`);
    const template = f.writing.workflows.library
      .templates()
      .find((item) => item.draft.taskType === taskType)?.versions[0];
    if (!template) throw new Error('missing template');
    const input = workflowInputSchema.parse({
      projectId: project.id,
      taskType,
      templateVersionId: template.id,
      providerConfigId: f.provider.id,
      input: '规划一下',
    });
    const w = await f.writing.workflows.create(input, randomUUID());
    const ready = await state(f, w.id, 'awaiting_acceptance');
    expect(ready.result?.type).toBe(
      {
        worldbuilding: 'element_candidates',
        master_outline: 'master_outline_candidate',
        story_events: 'outline_event_batch',
      }[taskType],
    );
    const before = f.novels.getStructure(project.id).documents.length;
    const accepted = f.writing.workflows.decide(
      w.id,
      { action: 'accept_result', expectedRevision: ready.revision, feedback: '' },
      randomUUID(),
    );
    expect(accepted.status).toBe('completed');
    expect(f.novels.getStructure(project.id).documents.length).toBeGreaterThan(before);
  }
});

it('stops at the result gate with a readable reason when a records artifact has no sections', async () => {
  const f = await fixture({
    factory: (request) =>
      new FakeModelAdapter([
        [
          text(
            taskOf(request).workflowNode.stage === 'review'
              ? '无重要问题'
              : '随便写了几句，没有分条',
          ),
        ],
      ]),
  });
  const project = f.novels.createProject('空作品');
  const template = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.taskType === 'worldbuilding')?.versions[0];
  if (!template) throw new Error('missing template');
  const w = await f.writing.workflows.create(
    workflowInputSchema.parse({
      projectId: project.id,
      taskType: 'worldbuilding',
      templateVersionId: template.id,
      providerConfigId: f.provider.id,
      input: '构建世界观',
    }),
    randomUUID(),
  );
  const waiting = await state(f, w.id, 'awaiting_input');
  expect(waiting.reasonCode).toBe('RESULT');
  expect(waiting.reason).toContain('分条');
  const node = waiting.nodes.find((n) => n.stage === 'generate');
  decide(f, waiting, 'edit_artifact', {
    nodeKey: node?.key,
    content: '## [世界] 雨城\n雨城规则\n',
  });
  const fixed = await state(f, w.id, 'awaiting_acceptance');
  expect(fixed.result?.type).toBe('element_candidates');
});

it('reruns missing basic-information categories only when the author asks', async () => {
  let generations = 0;
  const f = await fixture({
    factory: (request) => {
      const t = taskOf(request);
      if (t.workflowNode.stage === 'review') return new FakeModelAdapter([[text('无重要问题')]]);
      generations++;
      return new FakeModelAdapter([
        [
          text(
            generations === 1
              ? '## [人物] 运阳\n外在目标：守住秩序'
              : '## [人物] 运阳\n外在目标：守住秩序\n\n## [世界] 滨海小城\n海风',
          ),
        ],
      ]);
    },
  });
  const project = f.novels.createProject('空作品');
  const template = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.taskType === 'basic_information')?.versions[0];
  if (!template) throw new Error('missing template');
  const w = await f.writing.workflows.create(
    workflowInputSchema.parse({
      projectId: project.id,
      taskType: 'basic_information',
      mode: 'fill',
      templateVersionId: template.id,
      providerConfigId: f.provider.id,
      elementKinds: ['character', 'worldbuilding'],
      input: '构建基础信息',
    }),
    randomUUID(),
  );
  const first = await state(f, w.id, 'awaiting_acceptance');
  expect(first.missingKinds).toEqual(['worldbuilding']);
  expect(generations).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(generations).toBe(1);
  decide(f, first, 'rerun_missing');
  const second = await state(f, w.id, 'awaiting_acceptance');
  expect(generations).toBe(2);
  expect(second.missingKinds).toEqual([]);
  expect(second.result?.type === 'element_candidates' && second.result.items.length).toBe(2);
});
