import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  AgentError,
  FakeModelAdapter,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@lingma/agent';
import {
  agentProfileConfigSchema,
  createDocumentSchema,
  linkedChapterIds,
  parseReviewMarkdown,
  piConnectionSchema,
  type WorkflowRun,
  workflowInputSchema,
  workflowTemplateConfigSchema,
} from '@lingma/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadMigrations } from '../src/db/database.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { openRuntime } from '../src/runtime.js';
import { NovelService } from '../src/services/novels.js';
import { SkillService } from '../src/services/skills.js';
import { buildWorkflowResult, splitRecordSections } from '../src/workflows/adapters.js';
import { AgentLibrary } from '../src/workflows/library.js';
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

it.each(['reset', 'missing-chapter'])(
  'restores the chapter template after %s and reuses its published roles',
  async (scenario) => {
    const f = await fixture();
    const library = f.writing.workflows.library;
    const profiles = library.profiles();
    const retained = library.templates().filter((item) => item.id !== f.template.id);
    f.runtime.db.transaction((db) => {
      if (scenario === 'reset') {
        const reset = loadMigrations().find((migration) => migration.version === 20);
        if (!reset) throw new Error('missing reset migration');
        db.exec(reset.sql);
      } else {
        db.prepare('DELETE FROM workflow_template_versions WHERE template_id=?').run(f.template.id);
        db.prepare('DELETE FROM workflow_templates WHERE id=?').run(f.template.id);
      }
    });
    const restored = new AgentLibrary(f.writing.store, f.skills);
    const chapter = restored.templates().filter((item) => item.draft.taskType === 'chapter_write');
    expect(chapter).toHaveLength(1);
    expect(chapter[0]?.versions[0]?.config.name).toBe('单章协作写作');
    expect(chapter[0]?.versions[0]?.config.steps.map((step) => step.stage)).toEqual([
      'plan',
      'draft',
      'review',
      'review',
      'revise',
    ]);
    expect(chapter[0]?.versions[0]?.config.steps.map((step) => step.agentVersionId)).toEqual(
      f.template.versions[0]?.config.steps.map((step) => step.agentVersionId),
    );
    if (scenario === 'missing-chapter') {
      expect(restored.profiles()).toEqual(profiles);
      for (const template of retained) expect(restored.template(template.id)).toEqual(template);
    } else {
      for (const profile of profiles) expect(restored.profile(profile.id)).toEqual(profile);
    }
    const templates = restored.templates();
    const after = restored.profiles();
    const reopened = new AgentLibrary(f.writing.store, f.skills);
    expect(reopened.templates()).toEqual(templates);
    expect(reopened.profiles()).toEqual(after);
  },
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

it('drafts from an explicit plan and links the new chapter only when the author accepts', async () => {
  const f = await fixture({
    factory: (request) =>
      new FakeModelAdapter([
        [
          text(
            taskOf(request).workflowNode.stage === 'review'
              ? '无重要问题'
              : '# 新章 雪夜\n\n雪落在站台的长椅上。',
          ),
        ],
      ]),
  });
  const event = f.novels.createDocument(
    f.project.id,
    createDocumentSchema.parse({
      baseStructureVersion: f.novels.getProject(f.project.id).structureVersion,
      kind: 'chapter_outline',
      title: '第三卷：雪夜站台',
      content: '规划两人在站台相遇。',
      storyTime: '寒假前',
      summary: '一场雪夜的重逢。',
    }),
  );
  const input = workflowInputSchema.parse({
    ...f.input,
    targetDocumentId: null,
    baseVersionId: null,
    mode: 'create',
    sourceOutlineId: event.document.id,
    selectedVersionIds: [event.version.id],
    allowFutureOutline: true,
  });
  const w = await f.writing.workflows.create(input, randomUUID());
  const ready = await state(f, w.id, 'awaiting_acceptance');
  expect(
    f.novels.getStructure(f.project.id).documents.filter((item) => item.kind === 'chapter'),
  ).toHaveLength(1);
  expect(linkedChapterIds(f.novels.getDocument(event.document.id).document)).toEqual([]);
  const accepted = decide(f, ready, 'accept_result');
  const chapterId = accepted.acceptedResults[0]?.documentId;
  expect(chapterId).toBeTruthy();
  expect(linkedChapterIds(f.novels.getDocument(event.document.id).document)).toEqual([chapterId]);
  expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe('旧正文。');
  expect(f.novels.getDocument(event.document.id).version.content).toBe(event.version.content);
  await expect(f.writing.workflows.preview({ ...input, selectedVersionIds: [] })).rejects.toThrow(
    '明确引用',
  );
  const other = f.novels.createProject('另一部作品');
  await expect(f.writing.workflows.preview({ ...input, projectId: other.id })).rejects.toThrow(
    '来源规划',
  );
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

it('excludes transport settings from workflow snapshots and preview hashes', async () => {
  const f = await fixture();
  const preview = await f.writing.workflows.preview(f.input);
  const provider = f.writing.providers.get(f.provider.id);
  f.writing.providers.save(
    {
      ...provider.config,
      connection: { ...provider.config.connection, baseUrl: 'http://127.0.0.1:2/v1' },
    },
    provider.id,
    provider.revision,
    'rotated-test-key',
  );
  const next = await f.writing.workflows.preview(f.input);
  expect(next.hash).toBe(preview.hash);
  const w = await f.writing.workflows.create(
    { ...f.input, expectedPreviewHash: preview.hash },
    randomUUID(),
  );
  const done = await state(f, w.id, 'awaiting_acceptance');
  for (const context of Object.values(done.snapshot.contexts)) {
    expect(context.request.connectionSnapshot).not.toHaveProperty('baseUrl');
    expect(context.request.connectionSnapshot).not.toHaveProperty('credentialRef');
  }
  const row = f.runtime.db.connection
    .prepare('SELECT state_json FROM workflow_runs WHERE id=?')
    .get(w.id) as { state_json: string };
  expect(row.state_json).not.toContain('baseUrl');
  expect(row.state_json).not.toContain('credentialRef');
  expect(piConnectionSchema.parse(f.requests[0]?.connectionSnapshot).baseUrl).toBe(
    'http://127.0.0.1:2/v1',
  );
});

it('retries legacy workflows through the current transport and preserves tool checkpoints', async () => {
  const attempts: ModelRequest[] = [];
  let fail = true;
  const call = { id: 'search-1', name: 'search_documents', arguments: { query: '来客' } };
  const toolEvent: ModelEvent = {
    type: 'response',
    response: {
      text: '',
      calls: [call],
      transcriptMessage: { role: 'assistant', content: '', toolCalls: [call] },
      stop: 'tool_calls',
      usage,
    },
  };
  const f = await fixture({
    factory: (request) => {
      const adapter = new FakeModelAdapter(
        fail
          ? [[toolEvent], new AgentError('PROVIDER_UNAVAILABLE')]
          : [[text(taskOf(request).workflowNode.stage === 'review' ? '无重要问题' : '节点产物')]],
      );
      return {
        id: adapter.id,
        stream(request, signal) {
          attempts.push(structuredClone(request));
          return adapter.stream(request, signal);
        },
      };
    },
  });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const failed = await state(f, w.id, 'failed');
  const originalRunId = failed.nodes[0]?.runIds[0] as string;
  const originalCheckpoint = f.writing.store.row(originalRunId).checkpoint_json;
  expect(originalCheckpoint).toBeTruthy();
  // Simulate a workflow persisted before transport was removed from snapshots.
  const legacy = JSON.parse(JSON.stringify(failed));
  for (const context of Object.values(legacy.snapshot.contexts) as {
    request: { connectionSnapshot: Record<string, unknown> };
  }[]) {
    context.request.connectionSnapshot.baseUrl = f.provider.config.connection.baseUrl;
    context.request.connectionSnapshot.credentialRef = null;
  }
  f.runtime.db.connection
    .prepare('UPDATE workflow_runs SET state_json=? WHERE id=?')
    .run(JSON.stringify(legacy), w.id);
  const provider = f.writing.providers.get(f.provider.id);
  const updated = f.writing.providers.save(
    {
      ...provider.config,
      modelId: 'new-default-model',
      parameters: { temperature: 0.9 },
      connection: { ...provider.config.connection, baseUrl: 'http://127.0.0.1:2/v1' },
    },
    provider.id,
    provider.revision,
    'rotated-test-key',
  );
  fail = false;
  decide(f, f.writing.workflows.get(w.id), 'retry');
  const done = await state(f, w.id, 'awaiting_acceptance');
  const retryRequest = attempts[2] as ModelRequest;
  expect(piConnectionSchema.parse(retryRequest.connectionSnapshot)).toMatchObject({
    baseUrl: updated.config.connection.baseUrl,
    credentialRef: updated.config.connection.credentialRef,
  });
  expect(retryRequest.modelId).toBe('fixture');
  expect(retryRequest.parameters).toEqual({});
  expect(retryRequest.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'toolResult',
  ]);
  expect(attempts.filter((request) => request.messages.length === 1)).toHaveLength(4);
  expect(done.nodes[0]?.runIds).toHaveLength(2);
  expect(f.writing.store.row(originalRunId).checkpoint_json).toBe(originalCheckpoint);
  expect(JSON.stringify(done.snapshot)).not.toContain('baseUrl');
  expect(JSON.stringify(done.snapshot)).not.toContain('credentialRef');
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
  expect(current.nodes[0]?.status).toBe('running');
  const persisted = f.writing.store.db
    .prepare(
      "SELECT json_extract(state_json, '$.nodes[0].status') AS status FROM workflow_runs WHERE id=?",
    )
    .get(w.id) as { status: string };
  expect(persisted.status).toBe('running');
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

it('pauses at a node boundary when a pause races a node completion, then resumes without repeating work', async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const f = await fixture({
    factory: (request) => ({
      id: 'fake/v1',
      async *stream() {
        const t = taskOf(request);
        if (first) {
          first = false;
          await hold;
        }
        yield text(t.workflowNode.stage === 'review' ? '无重要问题' : `${t.workflowNode.key} 产物`);
      },
    }),
  });
  const w = await f.writing.workflows.create(f.input, randomUUID());
  await vi.waitFor(() => expect(f.writing.workflows.get(w.id).modelCalls).toBe(1));
  decide(f, f.writing.workflows.get(w.id), 'pause');
  release();
  const paused = await state(f, w.id, 'paused');
  const calls = paused.modelCalls;
  expect(calls).toBe(1);
  expect(paused.nodes.filter((n) => n.status === 'pending').length).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(f.writing.workflows.get(w.id).modelCalls).toBe(calls);
  decide(f, paused, 'resume');
  const done = await state(f, w.id, 'awaiting_acceptance');
  expect(done.modelCalls).toBe(4);
  expect(done.nodes.filter((n) => n.stage !== 'merge').every((n) => n.runIds.length === 1)).toBe(
    true,
  );
});

it('cancelling at a manual gate releases the project and never starts the remaining nodes', async () => {
  const f = await fixture();
  const w = await f.writing.workflows.create({ ...f.input, manualGates: true }, randomUUID());
  const gate = await state(f, w.id, 'awaiting_input');
  // A gate already holds the run still, so pausing is refused rather than silently ignored.
  expect(() => decide(f, gate, 'pause')).toThrow('只有运行中');
  decide(f, gate, 'cancel');
  const cancelled = f.writing.workflows.get(w.id);
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.nodes.filter((n) => n.runIds.length)).toHaveLength(1);
  await f.writing.workflows.create(f.input, randomUUID());
});

it('refreshing sources updates material but keeps the frozen model, parameters and global prompt', async () => {
  const f = await fixture();
  const w = await f.writing.workflows.create(f.input, randomUUID());
  const ready = await state(f, w.id, 'awaiting_acceptance');
  const profileId = Object.keys(ready.snapshot.contexts)[0] as string;
  const frozen = ready.snapshot.contexts[profileId]?.request;
  // Author edits the global prompt and the model parameters after the run started.
  const prompt = f.writing.prompt.get();
  f.writing.prompt.save({ prompt: `${prompt.prompt}\n新增的全局规则`, revision: prompt.revision });
  const provider = f.writing.providers.get(f.provider.id);
  f.writing.providers.save(
    { ...provider.config, parameters: { temperature: 0.9 } },
    provider.id,
    provider.revision,
  );
  // New formal text forces the author-merge path; supply the merged full text.
  f.novels.saveDocument(f.chapter.document.id, {
    baseVersionId: f.chapter.version.id,
    content: '作者手写的新正文。',
    metadata: {},
  });
  const refreshed = await f.writing.workflows.refreshSources(
    w.id,
    ready.revision,
    '合并后的完整稿',
    randomUUID(),
  );
  const next = refreshed.snapshot.contexts[profileId]?.request;
  expect(next?.systemPrompt).toBe(frozen?.systemPrompt);
  expect(next?.systemPrompt).not.toContain('新增的全局规则');
  expect(next?.parameters).toEqual(frozen?.parameters);
  expect(refreshed.sourceHistory).toHaveLength(1);
  const again = await state(f, w.id, 'awaiting_acceptance');
  expect(again.round).toBeGreaterThan(ready.round);
});

it('runs connected Agent debates for exactly three rounds and gives the summarizer their full exchange', async () => {
  const f = await fixture({
    factory: (request) =>
      new FakeModelAdapter([[text(`发言 ${taskOf(request).workflowNode.key}`)]]),
  });
  const preset = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.executionMode === 'graph');
  const version = preset?.versions[0];
  if (!version) throw new Error('missing debate template');
  const before = f.novels.getStructure(f.project.id);
  const started = await f.writing.workflows.create(
    workflowInputSchema.parse({
      ...f.input,
      taskType: 'discussion',
      targetDocumentId: null,
      baseVersionId: null,
      templateVersionId: version.id,
    }),
    randomUUID(),
  );
  const done = await state(f, started.id, 'awaiting_acceptance');
  expect(done.nodes.map((node) => node.key)).toEqual([
    'pro',
    'con',
    'pro@r1',
    'con@r1',
    'pro@r2',
    'con@r2',
    'summary@r2',
  ]);
  expect(f.requests).toHaveLength(7);
  expect(done.nodes.some((node) => node.stage === 'merge')).toBe(false);
  expect(done.result).toEqual({ type: 'discussion_summary', content: '发言 summary@r2' });
  const tasks = f.requests.map(taskOf);
  expect(tasks[0]?.upstream).toEqual([]);
  expect(tasks[1]?.upstream).toEqual([]);
  expect(tasks[2]?.upstream.map((item) => item.from).sort()).toEqual(['con', 'pro']);
  expect(tasks[3]?.upstream.map((item) => item.from).sort()).toEqual(['con', 'pro']);
  expect(tasks[4]?.upstream.map((item) => item.from).sort()).toEqual(['con@r1', 'pro@r1']);
  expect(tasks[6]?.upstream.map((item) => item.from)).toEqual([
    'pro',
    'con',
    'pro@r1',
    'con@r1',
    'pro@r2',
    'con@r2',
  ]);
  expect(f.requests[0]?.systemPrompt).toContain('你正在参加多 Agent 辩论');
  expect(f.requests[6]?.systemPrompt).toContain('你在全部辩论轮次结束后汇总');
  const completed = decide(f, done, 'accept_result');
  expect(completed.status).toBe('completed');
  expect(completed.artifacts).toHaveLength(7);
  expect(f.novels.getStructure(f.project.id)).toEqual(before);
});

it('honors arbitrary same-round wires without leaking unrelated Agent statements', async () => {
  const f = await fixture({
    factory: (request) => new FakeModelAdapter([[text(taskOf(request).workflowNode.key)]]),
  });
  const library = f.writing.workflows.library;
  const agent = library.profiles().find((profile) => profile.draft.capability === 'review')
    ?.versions[0];
  if (!agent) throw new Error('missing reviewer');
  let template = library.createTemplate(
    workflowTemplateConfigSchema.parse({
      name: '自由连线',
      taskType: 'discussion',
      executionMode: 'graph',
      maxRounds: 1,
      outputNodeKey: 'summary',
      steps: [
        { key: 'first', name: '提案', stage: 'agent', agentVersionId: agent.id },
        { key: 'unrelated', name: '独立分析', stage: 'agent', agentVersionId: agent.id },
        {
          key: 'reply',
          name: '质疑',
          stage: 'agent',
          agentVersionId: agent.id,
          dependsOn: ['first'],
        },
        {
          key: 'summary',
          name: '汇总',
          stage: 'agent',
          agentVersionId: agent.id,
          dependsOn: ['reply'],
          runWhen: 'after_rounds',
        },
      ],
    }),
  );
  template = library.publishTemplate(template.id, template.revision);
  const started = await f.writing.workflows.create(
    workflowInputSchema.parse({
      ...f.input,
      taskType: 'discussion',
      targetDocumentId: null,
      baseVersionId: null,
      templateVersionId: template.versions[0]?.id,
    }),
    randomUUID(),
  );
  await state(f, started.id, 'awaiting_acceptance');
  const tasks = f.requests.map(taskOf);
  expect(
    tasks.find((task) => task.workflowNode.key === 'reply')?.upstream.map((item) => item.from),
  ).toEqual(['first']);
  expect(
    tasks.find((task) => task.workflowNode.key === 'summary')?.upstream.map((item) => item.from),
  ).toEqual(['first', 'reply']);
});

it('pauses a debating Agent at manual gates and cancels before another round is scheduled', async () => {
  const f = await fixture();
  const version = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.executionMode === 'graph')?.versions[0];
  const started = await f.writing.workflows.create(
    workflowInputSchema.parse({
      ...f.input,
      taskType: 'discussion',
      targetDocumentId: null,
      baseVersionId: null,
      templateVersionId: version?.id,
      manualGates: true,
    }),
    randomUUID(),
  );
  const waiting = await state(f, started.id, 'awaiting_input');
  expect(waiting.nodes[0]?.status).toBe('awaiting_gate');
  expect(f.requests).toHaveLength(1);
  decide(f, waiting, 'release', { nodeKey: 'pro' });
  const second = await state(f, started.id, 'awaiting_input');
  expect(second.nodes[1]?.status).toBe('awaiting_gate');
  const cancelled = decide(f, second, 'cancel');
  await f.writing.workflows.pump();
  expect(cancelled.status).toBe('cancelled');
  expect(f.requests).toHaveLength(2);
});

it('rejects deadlocking Agent graphs but accepts explicit cross-round feedback', () => {
  const agentVersionId = randomUUID();
  const step = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    name: key,
    stage: 'agent',
    agentVersionId,
    ...extra,
  });
  const base = {
    name: '辩论',
    taskType: 'discussion',
    executionMode: 'graph',
    maxRounds: 3,
    outputNodeKey: 'b',
  };
  const parse = (steps: unknown[], extra = {}) =>
    workflowTemplateConfigSchema.safeParse({ ...base, steps, ...extra }).success;
  expect(parse([step('a', { feedbackFrom: ['b'] }), step('b', { feedbackFrom: ['a'] })])).toBe(
    true,
  );
  expect(parse([step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })])).toBe(false);
  expect(parse([step('a', { feedbackFrom: ['missing'] }), step('b')])).toBe(false);
  expect(parse([step('a', { feedbackFrom: ['b'] }), step('b', { runWhen: 'after_rounds' })])).toBe(
    false,
  );
  expect(parse([step('a', { dependsOn: ['b'] }), step('b', { runWhen: 'after_rounds' })])).toBe(
    false,
  );
  expect(parse([step('a'), step('b')], { outputNodeKey: 'missing' })).toBe(false);
  expect(parse([step('a'), step('b')], { maxRounds: 0 })).toBe(false);
  expect(parse([step('a'), step('b')], { maxRounds: 21 })).toBe(false);
});

it('re-runs a debating Agent and every connected later turn while keeping unconnected turns and history', async () => {
  let attempt = 0;
  const f = await fixture({
    factory: (request) =>
      new FakeModelAdapter([[text(`${taskOf(request).workflowNode.key} / attempt ${++attempt}`)]]),
  });
  const template = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.executionMode === 'graph');
  const started = await f.writing.workflows.create(
    workflowInputSchema.parse({
      ...f.input,
      taskType: 'discussion',
      targetDocumentId: null,
      baseVersionId: null,
      templateVersionId: template?.versions[0]?.id,
    }),
    randomUUID(),
  );
  const first = await state(f, started.id, 'awaiting_acceptance');
  const old = first.nodes.find((node) => node.key === 'pro@r1')?.artifactId;
  const unchanged = first.nodes.find((node) => node.key === 'con@r1')?.artifactId;
  decide(f, first, 'rerun', { nodeKey: 'pro@r1' });
  const second = await state(f, started.id, 'awaiting_acceptance');
  expect(f.requests).toHaveLength(11);
  expect(second.nodes.find((node) => node.key === 'pro@r1')?.artifactId).not.toBe(old);
  expect(second.nodes.find((node) => node.key === 'con@r1')?.artifactId).toBe(unchanged);
  expect(taskOf(f.requests.at(-1) as ModelRequest).upstream.map((item) => item.id)).not.toContain(
    old,
  );
  expect(second.artifacts.some((artifact) => artifact.id === old)).toBe(true);
  expect(second.nodes.every((node) => node.status === 'released')).toBe(true);
  expect(second.result?.type).toBe('discussion_summary');
});

async function embeddedDebate(f: Fixture, gate: 'auto' | 'manual' = 'auto') {
  const library = f.writing.workflows.library;
  const preset = library.templates().find((item) => item.draft.executionMode === 'graph');
  const agents = preset?.draft.steps;
  if (!agents?.[0] || !agents[1] || !agents[2]) throw new Error('missing debate agents');
  const config = workflowTemplateConfigSchema.parse({
    ...f.template.draft,
    name: '生成 → 辩论 → 审校',
    steps: [
      ...f.template.draft.steps.map((step) =>
        step.stage === 'review' ? { ...step, dependsOn: ['debate'] } : step,
      ),
      {
        key: 'debate',
        name: '方案辩论',
        stage: 'debate',
        agentVersionId: agents[2].agentVersionId,
        gate,
        dependsOn: ['draft'],
        instructions: '主角是否应该揭穿来客？',
        debate: {
          rounds: 3,
          participants: agents.slice(0, 2).map((agent) => ({
            name: agent.name,
            agentVersionId: agent.agentVersionId,
            instructions: agent.instructions ?? '',
          })),
        },
      },
    ],
  });
  const created = library.createTemplate(config);
  const published = library.publishTemplate(created.id, created.revision);
  return { ...f.input, templateVersionId: published.versions[0]?.id as string };
}

it('embeds a complete debate between generation and review without replacing the draft', async () => {
  const f = await fixture();
  const input = await embeddedDebate(f);
  const started = await f.writing.workflows.create(input, randomUUID());
  const done = await state(f, started.id, 'awaiting_acceptance');
  const tasks = f.requests.map(taskOf);
  const statements = tasks.filter((task) => task.workflowNode.stage === 'agent');
  expect(statements).toHaveLength(6);
  expect(statements[0]?.upstream.map((item) => item.from)).toEqual(['draft']);
  expect(statements[1]?.upstream.map((item) => item.from)).toEqual(['draft']);
  expect(statements[2]?.upstream.map((item) => item.from)).toEqual([
    'draft',
    'debate~d0p0',
    'debate~d0p1',
  ]);
  const summary = tasks.find((task) => task.workflowNode.stage === 'debate');
  expect(summary?.upstream).toHaveLength(7);
  const reviews = tasks.filter((task) => task.workflowNode.stage === 'review');
  for (const review of reviews)
    expect(review.upstream.map((item) => item.from)).toContain('debate');
  expect(done.nodes.find((node) => node.key === 'debate')?.inputArtifactIds).toHaveLength(7);
  expect(done.artifacts.find((artifact) => artifact.id === done.latestDraftId)?.nodeKey).toBe(
    'draft',
  );
  expect(done.snapshot.profiles).toHaveLength(7);
  expect(
    f.requests.find((request) => taskOf(request).workflowNode.key === 'debate~d0p1')?.systemPrompt,
  ).toContain('从不同立场挑战提案');
  expect(
    f.requests.find((request) => taskOf(request).workflowNode.key === 'debate')?.systemPrompt,
  ).toContain('全部辩论轮次结束后汇总');
});

it('holds the embedded summary before downstream review and can cancel at that boundary', async () => {
  const f = await fixture();
  const started = await f.writing.workflows.create(await embeddedDebate(f, 'manual'), randomUUID());
  const held = await state(f, started.id, 'awaiting_input');
  expect(held.nodes.find((node) => node.status === 'awaiting_gate')?.key).toBe('debate');
  expect(f.requests.map(taskOf).some((task) => task.workflowNode.stage === 'review')).toBe(false);
  decide(f, held, 'release', { nodeKey: 'debate' });
  const done = await state(f, started.id, 'awaiting_acceptance');
  expect(
    done.nodes
      .filter((node) => node.stage === 'review')
      .every((node) => node.status === 'released'),
  ).toBe(true);
  decide(f, done, 'reject');
  const second = await f.writing.workflows.create(await embeddedDebate(f, 'manual'), randomUUID());
  const heldAgain = await state(f, second.id, 'awaiting_input');
  const count = f.requests.length;
  const cancelled = decide(f, heldAgain, 'cancel');
  expect(cancelled.status).toBe('cancelled');
  expect(f.requests).toHaveLength(count);
});

it('repeats the embedded debate on the revised draft before a second review round', async () => {
  const f = await fixture({ issueRounds: 1 });
  const started = await f.writing.workflows.create(await embeddedDebate(f), randomUUID());
  const done = await state(f, started.id, 'awaiting_acceptance');
  expect(done.round).toBe(1);
  const tasks = f.requests.map(taskOf);
  const repeated = tasks.filter(
    (task) => task.workflowNode.stage === 'agent' && task.workflowNode.round === 1,
  );
  expect(repeated).toHaveLength(6);
  expect(repeated[0]?.upstream.map((item) => item.from)).toEqual(['revise@r1']);
  expect(repeated.every((task) => task.upstream.every((item) => item.from !== 'draft'))).toBe(true);
  const review = tasks.find((task) => task.workflowNode.key === 'continuity@r1');
  expect(review?.upstream.map((item) => item.from)).toContain('debate@r1');
  expect(review?.upstream.map((item) => item.from)).not.toContain('debate');
  expect(done.artifacts.find((artifact) => artifact.id === done.latestDraftId)?.nodeKey).toBe(
    'revise@r1',
  );
});

it('reruns an embedded statement and its consumers, keeping independent statements and the draft', async () => {
  const f = await fixture();
  const started = await f.writing.workflows.create(await embeddedDebate(f), randomUUID());
  const first = await state(f, started.id, 'awaiting_acceptance');
  const independent = first.nodes.find((node) => node.key === 'debate~d0p1')?.artifactId;
  const oldSummary = first.nodes.find((node) => node.key === 'debate')?.artifactId;
  decide(f, first, 'rerun', { nodeKey: 'debate~d0p0' });
  const second = await state(f, started.id, 'awaiting_acceptance');
  expect(second.nodes.find((node) => node.key === 'debate~d0p1')?.artifactId).toBe(independent);
  expect(second.nodes.find((node) => node.key === 'debate')?.artifactId).not.toBe(oldSummary);
  expect(second.latestDraftId).toBe(first.latestDraftId);
  expect(second.nodes.find((node) => node.key === 'continuity')?.inputArtifactIds).not.toContain(
    oldSummary,
  );
  expect(second.artifacts.some((artifact) => artifact.id === oldSummary)).toBe(true);
  const updatedDraft = '作者改写后的全新稿件';
  decide(f, second, 'edit_artifact', { nodeKey: 'draft', content: updatedDraft });
  const third = await state(f, started.id, 'awaiting_acceptance');
  expect(
    f.requests
      .map(taskOf)
      .filter((task) => task.workflowNode.key === 'debate~d0p0')
      .at(-1)
      ?.upstream.map((item) => item.markdown)
      .join('\n'),
  ).toContain(updatedDraft);
  expect(third.nodes.find((node) => node.key === 'debate~d0p1')?.artifactId).not.toBe(independent);
});

it('validates embedded debate limits and every nested Agent version before starting', async () => {
  const f = await fixture();
  const input = await embeddedDebate(f);
  const library = f.writing.workflows.library;
  const config = library.templateVersion(input.templateVersionId).config;
  const debate = config.steps.find((step) => step.stage === 'debate');
  if (!debate?.debate) throw new Error('missing debate');
  const settings = debate.debate;
  for (const rounds of [0, 21, 1.5]) {
    expect(
      workflowTemplateConfigSchema.safeParse({
        ...config,
        steps: config.steps.map((step) =>
          step === debate ? { ...step, debate: { ...debate.debate, rounds } } : step,
        ),
      }).success,
    ).toBe(false);
  }
  expect(
    workflowTemplateConfigSchema.safeParse({
      ...config,
      steps: config.steps.map((step) =>
        step === debate
          ? {
              ...step,
              debate: { ...settings, participants: settings.participants.slice(0, 1) },
            }
          : step,
      ),
    }).success,
  ).toBe(false);
  const invalid = structuredClone(config);
  const participant = invalid.steps.find((step) => step.stage === 'debate')?.debate
    ?.participants[0];
  if (!participant) throw new Error('missing participant');
  participant.agentVersionId = randomUUID();
  expect(() => library.createTemplate(invalid)).toThrow('Agent 发布版本不存在');
});

it('splits a volume into independent chapter plans and writes each into the same volume', async () => {
  let planning = true;
  const f = await fixture({
    factory: (request) =>
      new FakeModelAdapter([
        [
          text(
            taskOf(request).workflowNode.stage === 'review'
              ? '无重要问题'
              : planning
                ? '## 第一章 初见\n概述：在码头相遇。\n### 目标\n初次相识，暴雨留给下一章。\n\n## 第二章 暴雨\n概述：暴雨中互助。\n### 目标\n承接相遇，展开暴雨。'
                : '# 第一章 初见\n\n她在码头停步。',
          ),
        ],
      ]),
  });
  const source = f.novels.createDocument(
    f.project.id,
    createDocumentSchema.parse({
      baseStructureVersion: f.novels.getProject(f.project.id).structureVersion,
      kind: 'chapter_outline',
      title: '第一卷 雨港',
      content: '相遇、暴雨、离别。',
    }),
  );
  const template = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.taskType === 'chapter_planning')?.versions[0];
  expect(template).toBeTruthy();
  const input = workflowInputSchema.parse({
    ...f.input,
    taskType: 'chapter_planning',
    templateVersionId: template?.id,
    targetDocumentId: null,
    baseVersionId: null,
    sourceOutlineId: source.document.id,
    chapterCount: 2,
    newVolumeTitle: source.document.title,
    selectedVersionIds: [source.version.id],
    allowFutureOutline: true,
  });
  const run = await f.writing.workflows.create(input, randomUUID());
  const ready = await state(f, run.id, 'awaiting_acceptance');
  expect(ready.result).toMatchObject({
    type: 'chapter_plan_batch',
    items: [{ title: '第一章 初见' }, { title: '第二章 暴雨' }],
  });
  expect(f.novels.getStructure(f.project.id).volumes).toHaveLength(0);
  const key = randomUUID();
  const accepted = f.writing.workflows.decide(
    ready.id,
    { action: 'accept_result', expectedRevision: ready.revision, feedback: '' },
    key,
  );
  const replay = f.writing.workflows.decide(
    ready.id,
    { action: 'accept_result', expectedRevision: ready.revision, feedback: '' },
    key,
  );
  expect(replay.acceptedResults).toEqual(accepted.acceptedResults);
  const structure = f.novels.getStructure(f.project.id);
  expect(structure.volumes).toHaveLength(1);
  const plans = accepted.acceptedResults.map((item) => f.novels.getDocument(item.documentId));
  expect(plans).toHaveLength(2);
  expect(plans[0]?.document.summary).toBe('在码头相遇。');
  expect(plans[1]?.document.summary).toBe('暴雨中互助。');
  for (const plan of plans)
    expect(plan.document).toMatchObject({
      kind: 'chapter_plan',
      parentOutlineId: source.document.id,
      volumeId: structure.volumes[0]?.id,
      chapterIds: [],
    });
  expect(f.novels.getDocument(source.document.id).version.content).toBe(source.version.content);
  planning = false;
  for (const plan of plans) {
    const draftInput = workflowInputSchema.parse({
      ...f.input,
      targetDocumentId: null,
      baseVersionId: null,
      sourceOutlineId: plan.document.id,
      selectedVersionIds: [plan.version.id],
      allowFutureOutline: true,
    });
    const draft = await f.writing.workflows.create(draftInput, randomUUID());
    const draftReady = await state(f, draft.id, 'awaiting_acceptance');
    const saved = decide(f, draftReady, 'accept_result');
    const chapterId = saved.acceptedResults[0]?.documentId;
    expect(chapterId).toBeTruthy();
    expect(f.novels.getDocument(chapterId as string).document.volumeId).toBe(
      structure.volumes[0]?.id,
    );
    expect(linkedChapterIds(f.novels.getDocument(plan.document.id).document)).toEqual([chapterId]);
    await expect(f.writing.workflows.preview(draftInput)).rejects.toThrow('已有关联正文');
  }
  expect(linkedChapterIds(f.novels.getDocument(source.document.id).document)).toHaveLength(2);
  expect(
    f.novels.getStructure(f.project.id).documents.filter((item) => item.kind === 'chapter'),
  ).toHaveLength(3);
  const other = f.novels.createProject('另一部作品');
  await expect(f.writing.workflows.preview({ ...input, projectId: other.id })).rejects.toThrow(
    '来源规划',
  );
  await expect(f.writing.workflows.preview({ ...input, selectedVersionIds: [] })).rejects.toThrow(
    '明确引用',
  );
});

it('does not silently accept a chapter plan batch with fewer chapters than requested', async () => {
  const f = await fixture({
    factory: (request) =>
      new FakeModelAdapter([
        [
          text(
            taskOf(request).workflowNode.stage === 'review'
              ? '无重要问题'
              : '## 第一章 初见\n只有一章。',
          ),
        ],
      ]),
  });
  const template = f.writing.workflows.library
    .templates()
    .find((item) => item.draft.taskType === 'chapter_planning')?.versions[0];
  const run = await f.writing.workflows.create(
    workflowInputSchema.parse({
      ...f.input,
      taskType: 'chapter_planning',
      templateVersionId: template?.id,
      targetDocumentId: null,
      baseVersionId: null,
      chapterCount: 2,
    }),
    randomUUID(),
  );
  const stopped = await state(f, run.id, 'awaiting_input');
  expect(JSON.stringify(stopped)).toContain('章纲数量不符');
  expect(
    f.novels.getStructure(f.project.id).documents.filter((item) => item.kind === 'chapter_plan'),
  ).toEqual([]);
});
