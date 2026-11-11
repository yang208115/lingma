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
  defaultAgentPrompt,
  providerInputSchema,
  type RunDetail,
  writingRunInputSchema,
} from '@lingma/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { eventCursor } from '../src/http/writing.js';
import { createLogger } from '../src/logger.js';
import { openRuntime } from '../src/runtime.js';
import { ImportService } from '../src/services/imports.js';
import { NovelService } from '../src/services/novels.js';
import { SkillService } from '../src/services/skills.js';
import { actualActions } from '../src/writing/actions.js';
import { digest } from '../src/writing/context.js';
import { SqlLoopRecorder } from '../src/writing/recorder.js';
import { WritingService } from '../src/writing/service.js';

const cleanup: (() => Promise<void>)[] = [];
const usage = { inputTokens: null, outputTokens: null, cost: null };
function answer(
  text = '生成候选',
  calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [],
): ModelEvent {
  return {
    type: 'response',
    response: {
      transcriptMessage: { role: 'assistant', content: text, toolCalls: calls as never },
      text,
      calls: calls as never,
      stop: calls.length ? 'tool_calls' : 'complete',
      usage,
    },
  };
}
async function fixture(factory?: (request: ModelRequest) => ModelAdapter, includeSkill = true) {
  const root = await mkdtemp(resolve(tmpdir(), 'lingma-writing-'));
  const config = loadConfig({ DATA_DIR: 'data' }, root),
    runtime = await openRuntime(config);
  const novels = new NovelService(runtime.db),
    skills = new SkillService(runtime.db, runtime.blobs, runtime.gate, async () => {
      throw new Error('unused');
    });
  if (includeSkill)
    skills.importLocal(
      [
        {
          path: 'SKILL.md',
          bytes: new TextEncoder().encode(
            '---\nname: 写作测试\ndescription: 续写和审校时检查人物惯用手。\n---\n# 检查惯用手\n[约束](references/style.md)',
          ),
        },
        { path: 'references/style.md', bytes: new TextEncoder().encode('只依据冻结资料') },
      ],
      'test',
    );
  await skills.idle();
  const project = novels.createProject('雾港');
  const create = (kind: string, title: string, content: string, extra = {}) =>
    novels.createDocument(
      project.id,
      createDocumentSchema.parse({
        kind,
        title,
        content,
        baseStructureVersion: novels.getProject(project.id).structureVersion,
        ...extra,
      }),
    );
  const chapter = create('chapter', '第一章', '林舟用左手开窗。');
  const character = create('character', '林舟', '林舟惯用左手，铜铃交给苏禾。', {
    metadata: { aliases: ['阿舟'] },
  });
  let adapterFactory = factory ?? (() => new FakeModelAdapter([[answer()]]));
  const writing = new WritingService(runtime.db, novels, skills, {
    env: {},
    adapterFactory: (request) => adapterFactory(request),
  });
  const provider = writing.providers.save(
    providerInputSchema.parse({
      name: '离线配置',
      modelId: 'fixture',
      connection: {
        api: 'openai-completions',
        provider: 'fixture',
        baseUrl: 'http://127.0.0.1:1/v1',
        credentialRef: null,
        contextWindow: 32000,
        maxOutputTokens: 1024,
      },
    }),
  );
  const input = writingRunInputSchema.parse({
    projectId: project.id,
    sessionId: null,
    purpose: 'write',
    input: '检查林舟的惯用手并续写',
    target: { documentId: chapter.document.id, baseVersionId: chapter.version.id },
    providerConfigId: provider.id,
    modelId: 'fixture',
    context: {
      selectedVersionIds: [character.version.id],
      allowSearch: true,
      allowFutureOutline: false,
    },
    limits: {},
  });
  const app = createApp({
    ready: runtime.ready,
    webDistDir: config.webDistDir,
    logger: createLogger(() => {}),
    novels,
    skills,
    imports: new ImportService(novels, runtime.directories.temp, runtime.gate),
    writing,
  });
  cleanup.push(async () => {
    await writing.close();
    await skills.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    runtime,
    novels,
    skills,
    project,
    create,
    chapter,
    character,
    writing,
    provider,
    input,
    app,
    setFactory: (factory: typeof adapterFactory) => {
      adapterFactory = factory;
    },
  };
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function done(writing: WritingService, id: string): Promise<RunDetail> {
  await vi.waitFor(
    () =>
      expect(['queued', 'running', 'cancelling']).not.toContain(writing.store.summary(id).status),
    { timeout: 5000, interval: 10 },
  );
  return writing.store.detail(id);
}
const actionContext = () => ({
  runId: randomUUID(),
  turnIndex: 0,
  executionId: randomUUID(),
  signal: new AbortController().signal,
});

it('deletes a provider and its checks through HTTP while preserving completed writing history', async () => {
  const f = await fixture(undefined, false);
  const run = await done(f.writing, (await f.writing.create(f.input, randomUUID())).id);
  await f.writing.checkProvider(f.provider.id);
  expect(f.writing.checks(f.provider.id)).toHaveLength(1);
  const path = `http://localhost/api/v1/provider-configs/${f.provider.id}`;
  const remove = (body: unknown) =>
    f.app.request(path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await remove({})).status).toBe(400);
  expect((await remove({ revision: 0 })).status).toBe(400);
  expect((await remove({ revision: f.provider.revision + 1 })).status).toBe(409);
  expect(f.writing.providers.get(f.provider.id).id).toBe(f.provider.id);
  const response = await remove({ revision: f.provider.revision });
  expect(response.status).toBe(200);
  expect((await response.json()).data.id).toBe(f.provider.id);
  expect(f.writing.providers.list()).toEqual([]);
  expect(
    f.runtime.db.connection
      .prepare('SELECT id FROM provider_checks WHERE provider_id=?')
      .all(f.provider.id),
  ).toEqual([]);
  expect(f.writing.store.detail(run.id)).toEqual(run);
  expect((await f.app.request(path)).status).toBe(404);
  expect((await remove({ revision: f.provider.revision })).status).toBe(404);
});

it.each(['queued', 'running', 'cancelling'])(
  'prevents deleting a provider used by a %s writing run',
  async (status) => {
    const f = await fixture(undefined, false);
    const preview = await f.writing.preview(f.input);
    const run = f.runtime.db.transaction(() => f.writing.store.create(f.input, preview));
    f.runtime.db.connection.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run.id);
    expect(() => f.writing.deleteProvider(f.provider.id, f.provider.revision)).toThrow(
      expect.objectContaining({ code: 'PROJECT_BUSY' }),
    );
    const other = f.writing.providers.save({ ...f.provider.config, name: '未使用的模型' });
    expect(f.writing.deleteProvider(other.id, other.revision).id).toBe(other.id);
    expect(f.writing.providers.get(f.provider.id).id).toBe(f.provider.id);
  },
);

it.each(['queued', 'running'])(
  'prevents deleting a provider used by a %s basic-information job between model calls',
  async (status) => {
    const f = await fixture(undefined, false);
    const id = randomUUID();
    f.runtime.db.connection
      .prepare(
        'INSERT INTO element_generation_jobs(id,project_id,input_json,snapshot_json,status,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        f.project.id,
        JSON.stringify({ providerConfigId: f.provider.id }),
        '{}',
        status,
        new Date().toISOString(),
      );
    expect(() => f.writing.deleteProvider(f.provider.id, f.provider.revision)).toThrow(
      expect.objectContaining({ code: 'PROJECT_BUSY' }),
    );
    f.runtime.db.connection
      .prepare("UPDATE element_generation_jobs SET status='cancelled' WHERE id=?")
      .run(id);
    expect(f.writing.deleteProvider(f.provider.id, f.provider.revision).id).toBe(f.provider.id);
  },
);

it.each(['default', 'profile'])(
  'prevents deleting a provider referenced by a paused workflow (%s)',
  async (source) => {
    const f = await fixture(undefined, false);
    const workflowId = randomUUID();
    const snapshot = {
      input: { providerConfigId: source === 'default' ? f.provider.id : randomUUID() },
      profiles: [{ config: { providerConfigId: source === 'profile' ? f.provider.id : null } }],
    };
    f.runtime.db.connection
      .prepare('INSERT INTO workflow_runs VALUES(?,?,?,?,?,?)')
      .run(
        workflowId,
        f.project.id,
        'paused',
        JSON.stringify({ snapshot }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    expect(() => f.writing.deleteProvider(f.provider.id, f.provider.revision)).toThrow(
      expect.objectContaining({ code: 'PROJECT_BUSY' }),
    );
    f.runtime.db.connection
      .prepare("UPDATE workflow_runs SET status='cancelled' WHERE id=?")
      .run(workflowId);
    expect(f.writing.deleteProvider(f.provider.id, f.provider.revision).id).toBe(f.provider.id);
  },
);

it('prevents deleting a provider during its connection check', async () => {
  const f = await fixture(undefined, false);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(f.writing.providers, 'adapter').mockReturnValue({
    id: 'connection-check-test',
    async *stream() {
      await gate;
      yield answer('OK');
    },
  });
  const check = f.writing.checkProvider(f.provider.id);
  try {
    expect(() => f.writing.deleteProvider(f.provider.id, f.provider.revision)).toThrow(
      expect.objectContaining({ code: 'PROJECT_BUSY' }),
    );
  } finally {
    release();
    await check;
  }
  expect(f.writing.deleteProvider(f.provider.id, f.provider.revision).id).toBe(f.provider.id);
});

it('exposes general and current-project skills to writing and rejects a pinned skill from another project', async () => {
  const f = await fixture();
  const other = f.novels.createProject('另一项目');
  const own = f.skills.importLocal(
    [{ path: 'SKILL.md', bytes: new TextEncoder().encode('# 当前项目规则') }],
    'own',
    undefined,
    f.project.id,
  );
  const foreign = f.skills.importLocal(
    [{ path: 'SKILL.md', bytes: new TextEncoder().encode('# 其他项目规则') }],
    'foreign',
    undefined,
    other.id,
  );
  await f.skills.idle();
  const preview = await f.writing.preview(f.input);
  expect(preview.skills.map((s) => s.name).sort()).toEqual(['写作测试', '当前项目规则'].sort());
  expect(preview.request.systemPrompt).not.toContain('其他项目规则');
  await expect(
    f.writing.preview({ ...f.input, skillVersionId: f.skills.job(foreign.id).versionId as string }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const ownVersion = f.skills.job(own.id).versionId as string;
  expect(
    (await f.writing.preview({ ...f.input, skillVersionId: ownVersion })).skills.some(
      (s) => s.versionId === ownVersion,
    ),
  ).toBe(true);
});

it('edits the Agent prompt through the API, invalidates previews and freezes the actual prompt in each run', async () => {
  const f = await fixture();
  const before = await f.writing.preview(f.input);
  const initial = await (await f.app.request('http://localhost/api/v1/agent-prompt')).json();
  expect(initial.data).toMatchObject({ prompt: defaultAgentPrompt, revision: 0 });
  const prompt = '  自定义写作助手。\n保持段落简洁，先读取适用的 Skill。\n';
  const save = (text: string, revision: number) =>
    f.app.request('http://localhost/api/v1/agent-prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text, revision }),
    });
  const saved = await save(prompt, 0);
  expect(saved.status).toBe(200);
  expect((await saved.json()).data).toMatchObject({ prompt, revision: 1 });
  expect((await save('覆盖旧版本', 0)).status).toBe(409);
  expect((await save(' \n ', 1)).status).toBe(400);
  const preview = await f.writing.preview(f.input);
  expect(preview.agentPromptRevision).toBe(1);
  expect(preview.request.systemPrompt).toMatch(/^ {2}自定义写作助手。/);
  expect(preview.request.systemPrompt).toContain('可用 Skill 目录');
  expect(preview.request.systemPrompt).toContain('续写和审校时检查人物惯用手。');
  expect(preview.hash).not.toBe(before.hash);
  await expect(
    f.writing.create({ ...f.input, expectedContextHash: before.hash }, randomUUID()),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  const run = await done(
    f.writing,
    (await f.writing.create({ ...f.input, expectedContextHash: preview.hash }, randomUUID())).id,
  );
  expect(run.status).toBe('completed');
  expect(run.preview.request.systemPrompt.startsWith(prompt)).toBe(true);
  expect(JSON.stringify(run.turns[0]?.request)).toContain('自定义写作助手');
  expect((await save(defaultAgentPrompt, 1)).status).toBe(200);
  expect(f.writing.store.detail(run.id).preview.request.systemPrompt.startsWith(prompt)).toBe(true);
  expect(
    (await f.writing.preview(f.input)).request.systemPrompt.startsWith(defaultAgentPrompt),
  ).toBe(true);
});

it('discovers multiple Skills from descriptions and continues load/file/read/propose/answer in one loop', async () => {
  const f = await fixture();
  const job = f.skills.importLocal(
    [
      {
        path: 'SKILL.md',
        bytes: new TextEncoder().encode(
          '---\nname: 节奏审校\ndescription: 检查章节节奏。\n---\n节奏检查专用指导。',
        ),
      },
    ],
    'pacing',
  );
  await f.skills.idle();
  expect(f.skills.job(job.id).status).toBe('completed');
  const preview = await f.writing.preview(f.input);
  const writingSkill = preview.skills.find((skill) => skill.name === '写作测试');
  const pacingSkill = preview.skills.find((skill) => skill.name === '节奏审校');
  if (!writingSkill || !pacingSkill) throw new Error('missing catalog');
  expect(preview.request.systemPrompt).toContain('检查章节节奏。');
  expect(preview.request.systemPrompt).not.toContain('节奏检查专用指导。');
  const target = f.input.target;
  if (!target) throw new Error('missing target');
  const adapter = new FakeModelAdapter([
    [
      answer('', [
        {
          id: 'load-writing',
          name: 'load_skill',
          arguments: { versionId: writingSkill.versionId },
        },
        { id: 'load-pacing', name: 'load_skill', arguments: { versionId: pacingSkill.versionId } },
      ]),
    ],
    [
      answer('', [
        {
          id: 'style',
          name: 'read_skill_file',
          arguments: {
            versionId: writingSkill.versionId,
            path: 'references/style.md',
          },
        },
      ]),
    ],
    [
      answer('', [
        {
          id: 'read',
          name: 'read_document',
          arguments: {
            documentId: target.documentId,
            versionId: target.baseVersionId,
          },
        },
      ]),
    ],
    [
      answer('', [
        {
          id: 'propose',
          name: 'propose_document_change',
          arguments: {
            content: '林舟抬起左手。',
            reason: '遵循加载的 Skill',
            citations: [],
          },
        },
      ]),
    ],
    [answer('已完成续写与节奏审校')],
  ]);
  f.setFactory(() => adapter);
  const created = await f.writing.create(
    { ...f.input, expectedContextHash: preview.hash },
    randomUUID(),
  );
  const run = await done(f.writing, created.id);
  expect(run.status).toBe('completed');
  expect(run.turns).toHaveLength(5);
  expect(run.tools.map((tool) => tool.name)).toEqual([
    'load_skill',
    'load_skill',
    'read_skill_file',
    'read_document',
    'propose_document_change',
  ]);
  const loaded = adapter.requests[1]?.messages.filter((message) => message.role === 'toolResult');
  expect(JSON.stringify(loaded)).toContain('# 检查惯用手');
  expect(JSON.stringify(loaded)).toContain('节奏检查专用指导。');
  expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('只依据冻结资料');
  expect(run.proposals[0]?.status).toBe('pending');
  expect(f.novels.getDocument(target.documentId).version.id).toBe(target.baseVersionId);
});

it('preserves the Skill catalog and loaded results on retry and denies later versions', async () => {
  const f = await fixture();
  const preview = await f.writing.preview(f.input);
  const ref = preview.skills[0];
  if (!ref) throw new Error('missing Skill');
  f.setFactory(
    () =>
      new FakeModelAdapter([
        [answer('', [{ id: 'load', name: 'load_skill', arguments: { versionId: ref.versionId } }])],
        new Error('interrupted after load'),
      ]),
  );
  const created = await f.writing.create(f.input, randomUUID());
  const first = await done(f.writing, created.id);
  expect(first.status).toBe('failed');
  const updated = await f.skills.save(
    ref.skillId,
    ref.versionId,
    '---\nname: 新名称\ndescription: 新描述\n---\n更新后的 Skill 正文。',
  );
  const registry = actualActions(f.writing.store, created.id, f.skills);
  expect(
    await registry.execute(
      {
        id: 'wrong',
        name: 'load_skill',
        arguments: {
          versionId: updated.version.id,
        },
      },
      actionContext(),
    ),
  ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  const original = await registry.execute(
    {
      id: 'old',
      name: 'load_skill',
      arguments: {
        versionId: ref.versionId,
      },
    },
    actionContext(),
  );
  expect(original).toMatchObject({ ok: true, value: { name: '写作测试' } });
  expect(JSON.stringify(original)).toContain('# 检查惯用手');
  const resumed = new FakeModelAdapter([
    [
      answer('', [
        {
          id: 'file',
          name: 'read_skill_file',
          arguments: {
            versionId: ref.versionId,
            path: 'references/style.md',
          },
        },
      ]),
    ],
    [answer('依据原 Skill 完成')],
  ]);
  f.setFactory(() => resumed);
  const retry = f.writing.retry(created.id, randomUUID());
  const completed = await done(f.writing, retry.id);
  expect(completed.status).toBe('completed');
  expect(completed.preview.skills).toEqual(first.preview.skills);
  expect(completed.tools.map((tool) => tool.name)).toEqual(['read_skill_file']);
  expect(JSON.stringify(resumed.requests[0]?.messages)).toContain('# 检查惯用手');
  expect(JSON.stringify(resumed.requests)).not.toContain('更新后的 Skill 正文。');
  const fresh = await f.writing.preview(f.input);
  expect(fresh.skills[0]?.versionId).toBe(updated.version.id);
  expect(fresh.hash).not.toBe(preview.hash);
  await expect(
    f.writing.create({ ...f.input, expectedContextHash: preview.hash }, randomUUID()),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  const pinned = await f.writing.preview({ ...f.input, skillVersionId: ref.versionId });
  expect(pinned.skills[0]).toEqual(ref);
  const headingOnly = await f.skills.save(ref.skillId, updated.version.id, '# 旧版标题\n指导正文');
  await f.skills.save(ref.skillId, headingOnly.version.id, '# 最新标题\n指导正文');
  expect(f.skills.catalog(headingOnly.version.id)[0]?.name).toBe('旧版标题');
});

it('loads a full Skill beyond 32K, pages its text files and rejects invalid or binary file reads', async () => {
  const f = await fixture();
  const longSkill = `---\nname: 长篇指导\ndescription: 长篇写作测试\n---\n${'x'.repeat(40000)}`;
  const fileText = 'a'.repeat(9000);
  const job = f.skills.importLocal(
    [
      { path: 'SKILL.md', bytes: new TextEncoder().encode(longSkill) },
      { path: 'references/long.md', bytes: new TextEncoder().encode(fileText) },
      { path: 'image.png', bytes: new Uint8Array([0, 255, 0]) },
    ],
    'large',
  );
  await f.skills.idle();
  const detail = f.skills.detail(f.skills.job(job.id).skillId as string);
  const provider = f.writing.providers.save({
    ...f.provider.config,
    connection: { ...f.provider.config.connection, contextWindow: 262144 },
  });
  f.setFactory(
    () =>
      new FakeModelAdapter([
        [
          answer('', [
            { id: 'load-large', name: 'load_skill', arguments: { versionId: detail.version.id } },
          ]),
        ],
        [answer('完成')],
      ]),
  );
  const created = await f.writing.create(
    { ...f.input, providerConfigId: provider.id },
    randomUUID(),
  );
  const run = await done(f.writing, created.id);
  expect(run.status).toBe('completed');
  expect(run.tools[0]?.result).toMatchObject({ ok: true, value: { content: longSkill } });
  const registry = actualActions(f.writing.store, created.id, f.skills);
  const read = (path: string, range?: { from: number; to: number }) =>
    registry.execute(
      {
        id: randomUUID(),
        name: 'read_skill_file',
        arguments: {
          versionId: detail.version.id,
          path,
          ...(range ? { range } : {}),
        },
      },
      actionContext(),
    );
  expect(await read('references/long.md')).toMatchObject({
    ok: true,
    value: {
      content: fileText.slice(0, 8000),
      from: 0,
      to: 8000,
      totalChars: 9000,
      truncated: true,
    },
  });
  expect(await read('references/long.md', { from: 8000, to: 9000 })).toMatchObject({
    ok: true,
    value: {
      content: fileText.slice(8000),
      from: 8000,
      to: 9000,
      truncated: false,
    },
  });
  expect(await read('references/long.md', { from: 0, to: 9001 })).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION_ERROR' },
  });
  expect(await read('../SKILL.md')).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION_ERROR' },
  });
  expect(await read('absent.md')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await read('image.png')).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
});

it('runs without any installed or selected Skills', async () => {
  const f = await fixture(undefined, false);
  const preview = await f.writing.preview(f.input);
  expect(preview.skills).toEqual([]);
  expect(
    preview.request.toolDefinitions.map((tool) => (tool as { name: string }).name),
  ).not.toContain('load_skill');
  const created = await f.writing.create(f.input, randomUUID());
  expect((await done(f.writing, created.id)).status).toBe('completed');
});

it('freezes real novel versions, executes read/propose/answer, and only acceptance adds a version', async () => {
  const f = await fixture((request) => {
    const user = JSON.parse((request.messages[0] as { content: string }).content);
    const ref = user.context.find((entry: { kind: string }) => entry.kind === 'character');
    return new FakeModelAdapter([
      [
        answer('', [
          {
            id: 'read',
            name: 'read_document',
            arguments: { documentId: ref.documentId, versionId: ref.versionId },
          },
        ]),
      ],
      [
        answer('', [
          {
            id: 'proposal',
            name: 'propose_document_change',
            arguments: {
              content: '林舟用左手拨开窗栓。',
              reason: '保持惯用手一致',
              citations: [ref.citationId],
            },
          },
        ]),
      ],
      [{ type: 'text_delta', text: '林舟用左手拨开窗栓。' }, answer('林舟用左手拨开窗栓。')],
    ]);
  });
  const preview = await f.writing.preview(f.input);
  expect(preview.request.systemPrompt).toContain('续写和审校时检查人物惯用手。');
  expect(preview.request.systemPrompt).not.toContain('# 检查惯用手');
  expect(preview.request.systemPrompt).not.toContain('只依据冻结资料');
  const created = await f.writing.create(
    { ...f.input, expectedContextHash: preview.hash },
    randomUUID(),
  );
  f.novels.saveDocument(f.character.document.id, {
    baseVersionId: f.character.version.id,
    content: '后来改成右手',
    metadata: {},
  });
  const run = await done(f.writing, created.id);
  expect(run.status).toBe('completed');
  expect(run.turns).toHaveLength(3);
  expect(JSON.stringify(run.tools)).toContain('惯用左手');
  expect(JSON.stringify(run.tools)).not.toContain('后来改成右手');
  expect(run.proposals[0]?.status).toBe('pending');
  expect(f.novels.getDocument(f.chapter.document.id).version.id).toBe(f.chapter.version.id);
  const proposal = run.proposals[0];
  if (!proposal) throw new Error();
  const accepted = await Promise.all([
    Promise.resolve().then(() => f.writing.store.accept(proposal.id, randomUUID())),
    Promise.resolve().then(() => f.writing.store.accept(proposal.id, randomUUID())),
  ]);
  expect(accepted[0]?.acceptedVersionId).toBe(accepted[1]?.acceptedVersionId);
  expect(f.novels.getDocument(f.chapter.document.id).version).toMatchObject({
    versionNo: 2,
    source: 'proposal',
    content: '林舟用左手拨开窗栓。',
  });
  const events = f.writing.store.events(run.id, 0);
  expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
  expect(events.filter((e) => e.type === 'run.finished')).toHaveLength(1);
  expect(run.usage).toEqual({ known: usage, complete: false });
});

it('returns identical creation responses for duplicate keys and rejects changed requests', async () => {
  const f = await fixture();
  const key = randomUUID();
  const [one, two] = await Promise.all([
    f.writing.create(f.input, key),
    f.writing.create(f.input, key),
  ]);
  expect(two).toEqual(one);
  await done(f.writing, one.id);
  expect(await f.writing.create(f.input, key)).toEqual(one);
  await expect(f.writing.create({ ...f.input, input: 'different' }, key)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(f.writing.store.list(f.project.id, 100).data).toHaveLength(1);
});

it('enforces frozen version/other-project permissions, Chinese search and verified citations', async () => {
  const f = await fixture();
  const run = await f.writing.create(f.input, randomUUID());
  await done(f.writing, run.id);
  const registry = actualActions(f.writing.store, run.id, f.skills),
    ctx = actionContext();
  const forbidden = await registry.execute(
    {
      id: 'x',
      name: 'read_document',
      arguments: { documentId: randomUUID(), versionId: f.character.version.id },
    },
    ctx,
  );
  expect(forbidden).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  const updated = f.novels.saveDocument(f.character.document.id, {
    baseVersionId: f.character.version.id,
    content: '新版本',
    metadata: {},
  });
  expect(
    await registry.execute(
      {
        id: 'x2',
        name: 'read_document',
        arguments: { documentId: f.character.document.id, versionId: updated.version.id },
      },
      ctx,
    ),
  ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(
    await registry.execute(
      { id: 'search', name: 'search_documents', arguments: { query: '惯用左手' } },
      ctx,
    ),
  ).toMatchObject({
    ok: true,
    value: {
      matches: expect.arrayContaining([
        expect.objectContaining({ excerpt: expect.stringContaining('惯用左手') }),
      ]),
    },
  });
  expect(() => f.writing.store.accept(randomUUID(), randomUUID())).toThrow();
});

it('requires current bases and rejects fabricated citations without changing the author draft', async () => {
  const f = await fixture();
  f.setFactory(() => {
    return new FakeModelAdapter([
      [
        answer('', [
          {
            id: 'bad',
            name: 'propose_document_change',
            arguments: {
              content: 'candidate',
              reason: 'r',
              citations: ['invented'],
            },
          },
        ]),
      ],
    ]);
  });
  const bad = await f.writing.create(f.input, randomUUID());
  const result = await done(f.writing, bad.id);
  expect(result.proposals).toHaveLength(0);
  expect(result.tools[0]?.result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  f.setFactory(
    () =>
      new FakeModelAdapter([
        [
          answer('', [
            {
              id: 'good',
              name: 'propose_document_change',
              arguments: { content: 'candidate', reason: 'r', citations: [] },
            },
          ]),
        ],
        [answer('已提交')],
      ]),
  );
  const next = await f.writing.create(f.input, randomUUID());
  const completed = await done(f.writing, next.id);
  const proposal = completed.proposals[0];
  if (!proposal) throw new Error('missing proposal');
  f.novels.saveDocument(f.chapter.document.id, {
    baseVersionId: f.chapter.version.id,
    content: '作者新稿',
    metadata: {},
  });
  expect(() => f.writing.store.accept(proposal.id, randomUUID())).toThrowError(
    expect.objectContaining({ code: 'VERSION_CONFLICT' }),
  );
  expect(f.writing.store.proposal(proposal.id).status).toBe('stale');
  expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe('作者新稿');
});

it('applies UTF-16 selection replacement and rejects stale or mismatched selection hashes', async () => {
  const f = await fixture();
  if (!f.input.target) throw new Error('missing fixture target');
  const input = {
    ...f.input,
    purpose: 'rewrite' as const,
    target: {
      ...f.input.target,
      selection: { from: 2, to: 5, textHash: digest(f.chapter.version.content.slice(2, 5)) },
    },
  };
  f.setFactory(
    () =>
      new FakeModelAdapter([
        [
          answer('', [
            {
              id: 'sel',
              name: 'propose_document_change',
              arguments: { content: '以左手轻轻', reason: 'r', citations: [] },
            },
          ]),
        ],
        [answer('已提交')],
      ]),
  );
  const created = await f.writing.create(input, randomUUID()),
    run = await done(f.writing, created.id);
  const proposal = run.proposals[0];
  if (!proposal) throw new Error('missing proposal');
  f.writing.store.accept(proposal.id, randomUUID());
  expect(f.novels.getDocument(f.chapter.document.id).version.content).toBe(
    `${f.chapter.version.content.slice(0, 2)}以左手轻轻${f.chapter.version.content.slice(5)}`,
  );
  await expect(
    f.writing.preview({
      ...input,
      target: {
        ...input.target,
        baseVersionId: f.novels.getDocument(f.chapter.document.id).version.id,
        selection: { ...input.target.selection, textHash: 'a'.repeat(64) },
      },
    }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
});

it('provides a read-only skill_test engine without a project or target and disallows candidate application', async () => {
  const f = await fixture();
  const input = writingRunInputSchema.parse({
    ...f.input,
    projectId: null,
    target: undefined,
    purpose: 'skill_test',
    context: { selectedVersionIds: [], allowSearch: false, allowFutureOutline: false },
  });
  const created = await f.writing.create(input, randomUUID()),
    run = await done(f.writing, created.id);
  expect(run.status).toBe('completed');
  expect(run.preview.allowed).toHaveLength(0);
  expect(
    run.preview.request.toolDefinitions.map((tool) => (tool as { name: string }).name),
  ).toEqual(['load_skill', 'read_skill_file', 'read_document']);
  expect(() =>
    f.writing.store.candidate(run.id, run.output?.messageId as string, randomUUID()),
  ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
});

it.each(['master_outline', 'timeline_event'])(
  'accepting a %s confirms its new version while preserving future-planning permission',
  async (kind) => {
    const f = await fixture(
      () =>
        new FakeModelAdapter([
          [
            answer('', [
              {
                id: 'planning',
                name: 'propose_document_change',
                arguments: { content: '修订后的未来规划', reason: '作者要求', citations: [] },
              },
            ]),
          ],
          [answer('已提交规划候选')],
        ]),
      false,
    );
    const outline = f.create(kind, '故事规划', '原规划', {
      metadata: { element: { schemaVersion: 1, nature: 'planned' } },
    });
    expect(f.novels.confirmedVersionId(outline.document)).toBeNull();
    const task = '请修改当前规划，不写小说正文';
    const input = {
      ...f.input,
      input: task,
      purpose: 'review' as const,
      allowTargetProposal: true,
      allowOutlineCreation: true,
      target: { documentId: outline.document.id, baseVersionId: outline.version.id },
      context: { selectedVersionIds: [], allowSearch: true, allowFutureOutline: true },
    };
    const preview = await f.writing.preview(input);
    expect(preview.request.systemPrompt).toContain('当前是故事大纲与时间线规划。');
    const userMessage = preview.request.messages.find((message) => message.role === 'user');
    expect(JSON.parse(String(userMessage?.content)).task).toBe(task);
    const run = await done(f.writing, (await f.writing.create(input, randomUUID())).id);
    expect(run.taskPreview).toBe(task);
    const proposalId = run.proposals[0]?.id as string;
    const accepted = f.writing.store.accept(proposalId, randomUUID());
    expect(f.writing.store.accept(proposalId, randomUUID())).toEqual(accepted);
    const saved = f.novels.getDocument(outline.document.id);
    expect(saved.version.content).toBe('修订后的未来规划');
    expect(f.novels.confirmedVersionId(saved.document)).toBe(saved.version.id);
    const writingContext = await f.writing.preview({
      ...f.input,
      context: { ...f.input.context, allowFutureOutline: true },
    });
    expect(writingContext.allowed).toContainEqual(
      expect.objectContaining({
        documentId: outline.document.id,
        versionId: saved.version.id,
        planning: true,
      }),
    );
    const noFutureContext = await f.writing.preview(f.input);
    expect(noFutureContext.allowed.some((ref) => ref.documentId === outline.document.id)).toBe(
      false,
    );
  },
);

it.each(['propose_master_outline', 'propose_chapter_outlines'] as const)(
  '%s creates the right outline kind without a target, with review and idempotent acceptance',
  async (tool) => {
    const master = tool === 'propose_master_outline';
    const title = master ? '雾港故事总纲' : '雨夜来客';
    const content = '## 起点\n林舟调查铜铃。\n## 转折与结局\n苏禾揭开真相，两人离开雾港。';
    const f = await fixture((request) => {
      const first = request.messages[0];
      const context = JSON.parse(first?.role === 'user' ? first.content : '{}').context;
      const payload = {
        reason: '依据人物资料规划故事',
        citations: [context[0].citationId],
        ...(master
          ? { title, content }
          : { items: [{ title, content, storyTime: '第一夜', summary: '来客带来铜铃。' }] }),
      };
      return new FakeModelAdapter([
        [answer('', [{ id: 'outline', name: tool, arguments: payload }])],
        [answer('', [{ id: 'duplicate', name: tool, arguments: payload }])],
        [answer('已提交大纲候选，请确认。')],
      ]);
    }, false);
    const existing = f.create('master_outline', '已有总纲', '保留原规划');
    const before = f.novels.getStructure(f.project.id).documents.length;
    const input = {
      ...f.input,
      purpose: 'review' as const,
      target: undefined,
      allowOutlineCreation: true,
      context: { ...f.input.context, allowFutureOutline: true },
    };
    const run = await done(f.writing, (await f.writing.create(input, randomUUID())).id);
    expect(run.status).toBe('completed');
    expect(run.preview.request.toolDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'propose_master_outline' }),
        expect.objectContaining({ name: 'propose_chapter_outlines' }),
      ]),
    );
    expect(run.preview.request.toolDefinitions).not.toContainEqual(
      expect.objectContaining({ name: 'propose_document_change' }),
    );
    expect(run.outlineProposals).toHaveLength(1);
    const proposal = run.outlineProposals[0];
    if (!proposal) throw new Error('Expected an outline proposal');
    expect(proposal).toMatchObject({
      status: 'pending',
      payload: { kind: master ? 'master_outline' : 'chapter_outline', items: [{ title, content }] },
    });
    expect(f.novels.getStructure(f.project.id).documents).toHaveLength(before);
    const accept = () =>
      f.app.request(`http://localhost/api/v1/outline-proposals/${proposal.id}/accept`, {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
      });
    const response = await accept();
    expect(response.status).toBe(200);
    const accepted = (await response.json()).data;
    expect((await (await accept()).json()).data).toEqual(accepted);
    expect(accepted.acceptedDocuments).toHaveLength(1);
    const saved = f.novels.getDocument(accepted.acceptedDocuments[0].documentId);
    expect(saved.document).toMatchObject({
      projectId: f.project.id,
      kind: master ? 'master_outline' : 'chapter_outline',
      title,
      chapterId: null,
      ...(!master ? { storyTime: '第一夜', summary: '来客带来铜铃。' } : {}),
    });
    expect(saved.version).toMatchObject({ content, source: 'proposal' });
    expect(f.novels.getStructure(f.project.id).documents).toHaveLength(before + 1);
    expect(f.novels.getDocument(existing.document.id).version.id).toBe(existing.version.id);
    expect(f.novels.getDocument(f.chapter.document.id).version.id).toBe(f.chapter.version.id);
    expect(f.writing.store.detail(run.id).outlineProposals[0]).toEqual(accepted);
    if (master) {
      expect(saved.version.metadata).toMatchObject({ element: { nature: 'planned' } });
      expect(f.novels.confirmedVersionId(saved.document)).toBe(saved.version.id);
      const preview = await f.writing.preview({
        ...f.input,
        context: { ...f.input.context, allowFutureOutline: true },
      });
      expect(preview.allowed).toContainEqual(
        expect.objectContaining({
          documentId: saved.document.id,
          versionId: saved.version.id,
          planning: true,
        }),
      );
      expect((await f.writing.preview(f.input)).allowed).not.toContainEqual(
        expect.objectContaining({ documentId: saved.document.id }),
      );
    }
  },
);

it.each(['write', 'review'] as const)(
  'does not expose total-outline creation to an unauthorized %s run',
  async (purpose) => {
    const f = await fixture(
      () =>
        new FakeModelAdapter([
          [
            answer('', [
              {
                id: 'forbidden',
                name: 'propose_master_outline',
                arguments: {
                  title: '未授权总纲',
                  content: '不能保存',
                  reason: '测试',
                  citations: [],
                },
              },
            ]),
          ],
          [answer('结束')],
        ]),
      false,
    );
    const run = await done(
      f.writing,
      (await f.writing.create({ ...f.input, purpose }, randomUUID())).id,
    );
    expect(run.preview.request.toolDefinitions).not.toContainEqual(
      expect.objectContaining({ name: 'propose_master_outline' }),
    );
    expect(run.tools[0]?.result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(run.outlineProposals).toHaveLength(0);
  },
);

it.each([false, true])(
  'validates total-outline citations and rejects candidates without creating documents (invalid citation: %s)',
  async (invalidCitation) => {
    const f = await fixture(
      () =>
        new FakeModelAdapter([
          [
            answer('', [
              {
                id: 'master',
                name: 'propose_master_outline',
                arguments: {
                  title: '待审总纲',
                  content: '故事从铜铃开始。',
                  reason: '测试',
                  citations: invalidCitation ? ['invented'] : [],
                },
              },
            ]),
          ],
          [answer('结束')],
        ]),
      false,
    );
    const before = f.novels.getStructure(f.project.id).documents.length;
    const run = await done(
      f.writing,
      (
        await f.writing.create(
          {
            ...f.input,
            purpose: 'review',
            target: undefined,
            allowOutlineCreation: true,
          },
          randomUUID(),
        )
      ).id,
    );
    if (invalidCitation) {
      expect(run.tools[0]?.result).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR' },
      });
      expect(run.outlineProposals).toHaveLength(0);
    } else {
      const proposal = run.outlineProposals[0];
      if (!proposal) throw new Error('Expected an outline proposal');
      const id = proposal.id;
      expect(
        (
          await f.app.request(`http://localhost/api/v1/outline-proposals/${id}/reject`, {
            method: 'POST',
          })
        ).status,
      ).toBe(200);
      expect(f.writing.store.detail(run.id).outlineProposals[0]?.status).toBe('rejected');
      expect(
        (
          await f.app.request(`http://localhost/api/v1/outline-proposals/${id}/accept`, {
            method: 'POST',
            headers: { 'Idempotency-Key': randomUUID() },
          })
        ).status,
      ).toBe(403);
    }
    expect(f.novels.getStructure(f.project.id).documents).toHaveLength(before);
  },
);

it('reviews an explicitly selected chapter outline and only proposes changes after target authorization', async () => {
  const f = await fixture(() => {
    return new FakeModelAdapter([
      [
        answer('', [
          {
            id: 'outline',
            name: 'propose_document_change',
            arguments: {
              content: '修订后的规划',
              reason: '审校修订',
              citations: [],
            },
          },
        ]),
      ],
      [answer('完成审校')],
    ]);
  });
  const outline = f.create('chapter_outline', '当前章纲', '原规划', {
    chapterId: f.chapter.document.id,
  });
  const input = {
    ...f.input,
    purpose: 'review' as const,
    target: { documentId: outline.document.id, baseVersionId: outline.version.id },
  };
  const preview = await f.writing.preview(input);
  expect(preview.entries.find((ref) => ref.documentId === outline.document.id)?.planning).toBe(
    true,
  );
  const readonly = await done(f.writing, (await f.writing.create(input, randomUUID())).id);
  expect(readonly.tools[0]?.result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(readonly.proposals).toHaveLength(0);
  const authorized = await done(
    f.writing,
    (await f.writing.create({ ...input, allowTargetProposal: true }, randomUUID())).id,
  );
  expect(authorized.proposals[0]?.status).toBe('pending');
  f.writing.store.accept(authorized.proposals[0]?.id as string, randomUUID());
  expect(f.novels.getDocument(outline.document.id).version.content).toBe('修订后的规划');
  expect(f.novels.getDocument(f.chapter.document.id).version.id).toBe(f.chapter.version.id);
});

it('limits instance execution, rejects concurrent writing on a project, and cancels a stuck model', async () => {
  const stuck: ModelAdapter = {
    id: 'stuck',
    async *stream() {
      await new Promise(() => {});
      yield answer();
    },
  };
  const f = await fixture(() => stuck);
  const created = await f.writing.create(f.input, randomUUID());
  await vi.waitFor(() => expect(f.writing.store.summary(created.id).status).toBe('running'));
  await expect(f.writing.create(f.input, randomUUID())).rejects.toMatchObject({
    code: 'PROJECT_BUSY',
  });
  expect(() =>
    f.novels.deleteDocument(
      f.character.document.id,
      f.character.version.id,
      f.novels.getProject(f.project.id).structureVersion,
    ),
  ).toThrowError(expect.objectContaining({ code: 'PROJECT_BUSY' }));
  f.writing.cancel(created.id);
  const run = await done(f.writing, created.id);
  expect(run.status).toBe('cancelled');
  expect(f.writing.store.events(run.id, 0).filter((e) => e.type === 'run.finished')).toHaveLength(
    1,
  );
});

it('retries using the complete checkpoint and old versions without repeating completed reads', async () => {
  let models = 0;
  const f = await fixture((request) => {
    models++;
    const user = JSON.parse((request.messages[0] as { content: string }).content),
      ref = user.context.find((entry: { kind: string }) => entry.kind === 'character');
    return models === 1
      ? new FakeModelAdapter([
          [
            answer('', [
              {
                id: 'read',
                name: 'read_document',
                arguments: { documentId: ref.documentId, versionId: ref.versionId },
              },
            ]),
          ],
          new Error('synthetic failure'),
        ])
      : new FakeModelAdapter([[answer('retry result')]]);
  });
  const first = await f.writing.create(f.input, randomUUID()),
    failed = await done(f.writing, first.id);
  expect(failed.status).toBe('failed');
  expect(failed.tools).toHaveLength(1);
  f.novels.saveDocument(f.chapter.document.id, {
    baseVersionId: f.chapter.version.id,
    content: 'new body',
    metadata: {},
  });
  const retry = f.writing.retry(first.id, randomUUID()),
    second = await done(f.writing, retry.id);
  expect(second.status).toBe('completed');
  expect(second.turns[0]?.turnIndex).toBe(1);
  expect(second.tools).toHaveLength(0);
  expect(second.retryOfRunId).toBe(first.id);
  expect(second.preview.request).toEqual(failed.preview.request);
  expect(second.turns[0]?.request).toMatchObject({
    messages: [
      expect.anything(),
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'toolResult' }),
    ],
  });
  expect(f.writing.store.summary(first.id).status).toBe('failed');
});

it('handles startup interruption, expires events and validates Last-Event-ID before after', async () => {
  const f = await fixture();
  const preview = await f.writing.preview(f.input);
  const queued = f.runtime.db.transaction(() => f.writing.store.create(f.input, preview));
  f.writing.store.recover();
  expect(f.writing.store.summary(queued.id).status).toBe('interrupted');
  expect(eventCursor('2', 'old invalid after')).toBe(2);
  for (const cursor of ['-1', '01', '1.5', 'NaN', '9007199254740992', ''])
    expect(() => eventCursor(cursor, '0')).toThrow();
  f.writing.store.expireEvents(queued.id, 1);
  expect(
    (await f.app.request(`http://localhost/api/v1/runs/${queued.id}/events?after=0`)).status,
  ).toBe(410);
  expect(
    (
      await f.app.request(`http://localhost/api/v1/runs/${queued.id}/events?after=bad`, {
        headers: { 'Last-Event-ID': '1' },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.app.request(`http://localhost/api/v1/runs/${queued.id}/events?after=1`, {
        headers: { 'Last-Event-ID': 'bad' },
      })
    ).status,
  ).toBe(400);
});

it('persists visible thinking separately from final prose and after event expiry', async () => {
  const final = answer('小说正文');
  if (final.type !== 'response') throw new Error('expected response');
  final.response.thinking = '先核对人物资料。';
  const f = await fixture(
    () =>
      new FakeModelAdapter([
        [
          { type: 'thinking_delta', text: '先核对' },
          { type: 'thinking_delta', text: '人物资料。' },
          { type: 'text_delta', text: '小说正文' },
          final,
        ],
      ]),
  );
  const preview = await f.writing.preview(f.input);
  const run = await f.writing.create(
    { ...f.input, expectedContextHash: preview.hash },
    randomUUID(),
  );
  const detail = await done(f.writing, run.id);
  expect(detail.status).toBe('completed');
  expect(detail.turns[0]).toMatchObject({
    thinking: '先核对人物资料。',
    partialText: '小说正文',
  });
  expect(detail.output?.text).toBe('小说正文');
  expect(f.writing.store.events(run.id, 0)).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'thinking.delta' })]),
  );
  f.writing.store.expireEvents(run.id, detail.lastEventSeq);
  expect(f.writing.store.detail(run.id).turns[0]?.thinking).toBe('先核对人物资料。');
});

it('batches text with event cursors and partial_text in one transaction', async () => {
  const f = await fixture();
  const preview = await f.writing.preview(f.input),
    run = f.runtime.db.transaction(() => f.writing.store.create(f.input, preview));
  f.runtime.db.transaction((db) =>
    db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id),
  );
  const recorder = new SqlLoopRecorder(f.writing.store, run.id, () => {});
  recorder.record({
    kind: 'request',
    turnIndex: 0,
    messageId: randomUUID(),
    request: preview.request,
  });
  const messageId = randomUUID();
  for (let i = 1; i <= 3; i++)
    recorder.record({
      kind: 'event',
      event: {
        schemaVersion: 1,
        runId: run.id,
        type: 'text.delta',
        turnIndex: 0,
        messageId,
        text: '片',
        seq: i,
      },
    });
  expect(f.writing.store.summary(run.id).lastEventSeq).toBe(0);
  recorder.flush();
  recorder.dispose();
  expect(f.writing.store.events(run.id, 0)).toMatchObject([{ seq: 3, text: '片片片' }]);
  expect(f.writing.store.detail(run.id).turns[0]?.partialText).toBe('片片片');
});

it('batches thinking deltas without mixing their event cursors with prose', async () => {
  const f = await fixture();
  const preview = await f.writing.preview(f.input),
    run = f.runtime.db.transaction(() => f.writing.store.create(f.input, preview));
  const recorder = new SqlLoopRecorder(f.writing.store, run.id, () => {});
  const messageId = randomUUID();
  recorder.record({ kind: 'request', turnIndex: 0, messageId, request: preview.request });
  const fragments = [
    { type: 'thinking.delta', text: '核对' },
    { type: 'thinking.delta', text: '资料' },
    { type: 'text.delta', text: '正文' },
    { type: 'thinking.delta', text: '完成' },
  ] as const;
  for (const [index, fragment] of fragments.entries())
    recorder.record({
      kind: 'event',
      event: {
        schemaVersion: 1,
        runId: run.id,
        seq: index + 1,
        turnIndex: 0,
        messageId,
        ...fragment,
      },
    });
  recorder.flush();
  recorder.dispose();
  expect(f.writing.store.events(run.id, 0)).toMatchObject([
    { type: 'thinking.delta', seq: 2, text: '核对资料' },
    { type: 'text.delta', seq: 3, text: '正文' },
    { type: 'thinking.delta', seq: 4, text: '完成' },
  ]);
  expect(f.writing.store.detail(run.id).turns[0]).toMatchObject({
    thinking: '核对资料完成',
    partialText: '正文',
  });
});

it('keeps environment credentials off provider responses and rejects invalid connections before persistence', async () => {
  const f = await fixture();
  expect(() =>
    f.writing.providers.save({
      ...f.provider.config,
      connection: {
        ...f.provider.config.connection,
        baseUrl: 'https://user:never-store@provider.invalid',
      },
    }),
  ).toThrow();
  expect(JSON.stringify(f.writing.providers.list())).not.toContain('never-store');
  const missing = f.writing.providers.save({
    ...f.provider.config,
    connection: {
      ...f.provider.config.connection,
      baseUrl: 'https://provider.invalid/v1',
      credentialRef: 'env:MISSING_KEY',
    },
  });
  expect(missing.credentialConfigured).toBe(false);
  const check = await f.writing.checkProvider(missing.id);
  expect(check.stopReason).toBe('PROVIDER_AUTH_ERROR');
  expect(f.writing.checks(missing.id)).toHaveLength(1);
});

it('abandons a staged proposal when cancellation arrives before the complete round commits', async () => {
  const f = await fixture(() => {
    return new FakeModelAdapter([
      [
        answer('', [
          {
            id: 'change',
            name: 'propose_document_change',
            arguments: {
              content: '未提交候选',
              reason: 'test',
              citations: [],
            },
          },
        ]),
      ],
    ]);
  });
  const original = f.writing.store.insertProposal.bind(f.writing.store);
  vi.spyOn(f.writing.store, 'insertProposal').mockImplementation((input, executionId) => {
    const result = original(input, executionId);
    f.writing.cancel(input.runId);
    return result;
  });
  const created = await f.writing.create(f.input, randomUUID());
  const run = await done(f.writing, created.id);
  expect(run.status).toBe('cancelled');
  expect(run.proposals).toMatchObject([{ status: 'abandoned' }]);
  expect(run.turns[0]?.status).toBe('cancelled');
  expect(() => f.writing.store.accept(run.proposals[0]?.id as string, randomUUID())).toThrow();
  expect(f.novels.getDocument(f.chapter.document.id).version.id).toBe(f.chapter.version.id);
});

it('makes a persisted cancellation win a late completion and emits one terminal event', async () => {
  const f = await fixture();
  const original = f.writing.store.terminal.bind(f.writing.store);
  vi.spyOn(f.writing.store, 'terminal').mockImplementation((id, status, ...rest) => {
    if (status === 'completed') f.writing.cancel(id);
    original(id, status, ...rest);
  });
  const created = await f.writing.create(f.input, randomUUID());
  const run = await done(f.writing, created.id);
  expect(run.status).toBe('cancelled');
  expect(
    f.writing.store.events(run.id, 0).filter((event) => event.type === 'run.finished'),
  ).toMatchObject([{ status: 'cancelled' }]);
  expect(() => f.writing.retry(run.id, randomUUID())).toThrowError(
    expect.objectContaining({ code: 'FORBIDDEN' }),
  );
});

it('runs at most one model across projects and starts the next queued task after cancellation', async () => {
  let calls = 0;
  const f = await fixture(() => {
    calls++;
    return calls === 1
      ? {
          id: 'stuck',
          async *stream() {
            await new Promise(() => {});
            yield answer();
          },
        }
      : new FakeModelAdapter([[answer('second')]]);
  });
  const first = await f.writing.create(f.input, randomUUID());
  await vi.waitFor(() => expect(calls).toBe(1));
  const project = f.novels.createProject('另一部');
  const chapter = f.novels.createDocument(
    project.id,
    createDocumentSchema.parse({
      kind: 'chapter',
      title: '第一章',
      content: '另一个故事',
      baseStructureVersion: project.structureVersion,
    }),
  );
  const second = await f.writing.create(
    {
      ...f.input,
      projectId: project.id,
      target: { documentId: chapter.document.id, baseVersionId: chapter.version.id },
      context: { ...f.input.context, selectedVersionIds: [] },
    },
    randomUUID(),
  );
  expect(f.writing.store.summary(second.id).status).toBe('queued');
  expect(calls).toBe(1);
  f.writing.cancel(first.id);
  expect((await done(f.writing, second.id)).status).toBe('completed');
  expect(calls).toBe(2);
});

it('recovers persisted partial text after closing and reopening the runtime', async () => {
  const f = await fixture();
  const preview = await f.writing.preview(f.input);
  const run = f.runtime.db.transaction(() => f.writing.store.create(f.input, preview));
  f.runtime.db.transaction((db) => {
    db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id);
    db.prepare(
      "INSERT INTO run_turns(run_id,turn_index,status,partial_text) VALUES(?,0,'running','尚未完成的片段')",
    ).run(run.id);
  });
  await f.runtime.close();
  const runtime = await openRuntime(loadConfig({ DATA_DIR: 'data' }, f.root));
  const novels = new NovelService(runtime.db);
  const skills = new SkillService(runtime.db, runtime.blobs, runtime.gate, async () => {
    throw new Error('unused');
  });
  const writing = new WritingService(runtime.db, novels, skills, { env: {} });
  cleanup.push(async () => {
    await writing.close();
    await skills.close();
    await runtime.close();
  });
  const recovered = writing.store.detail(run.id);
  expect(recovered).toMatchObject({
    status: 'interrupted',
    turns: [{ status: 'interrupted', partialText: '尚未完成的片段' }],
  });
  expect(writing.store.events(run.id, 0).filter((e) => e.type === 'run.finished')).toHaveLength(1);
  expect(f.writing.store.db.open).toBe(false);
});

it('keeps pinned historical metadata, excludes future chapters and treats future outlines as planning', async () => {
  const f = await fixture();
  const later = f.create('chapter', '第二章', '未来正文');
  const outline = f.create('chapter_outline', '第二章章纲', '未来规划', {
    chapterId: later.document.id,
  });
  f.novels.saveDocument(f.character.document.id, {
    baseVersionId: f.character.version.id,
    content: '人物新版本',
    metadata: { aliases: ['新别名'] },
  });
  const preview = await f.writing.preview(f.input);
  expect(preview.entries.find((e) => e.documentId === f.character.document.id)).toMatchObject({
    versionId: f.character.version.id,
    metadata: { aliases: ['阿舟'] },
  });
  expect(
    preview.allowed.some(
      (ref) => ref.documentId === later.document.id || ref.documentId === outline.document.id,
    ),
  ).toBe(false);
  const future = await f.writing.preview({
    ...f.input,
    context: { ...f.input.context, allowFutureOutline: true },
  });
  expect(future.allowed.find((ref) => ref.documentId === outline.document.id)?.planning).toBe(true);
  expect(future.allowed.some((ref) => ref.documentId === later.document.id)).toBe(false);
});

it('never silently trims pinned context and rejects an obsolete preview before creating a run', async () => {
  const f = await fixture();
  const preview = await f.writing.preview(f.input);
  f.writing.providers.save(
    { ...f.provider.config, parameters: { temperature: 0.1 } },
    f.provider.id,
    f.provider.revision,
  );
  await expect(
    f.writing.create({ ...f.input, expectedContextHash: preview.hash }, randomUUID()),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  expect(f.writing.store.list(f.project.id, 50).data).toHaveLength(0);
  const large = f.create('character', '大人物', '人物'.repeat(12000));
  await expect(
    f.writing.preview({
      ...f.input,
      context: { ...f.input.context, selectedVersionIds: [large.version.id] },
    }),
  ).rejects.toMatchObject({ code: 'CONTEXT_TOO_LARGE' });
  const small = f.writing.providers.save(
    { ...f.provider.config, connection: { ...f.provider.config.connection, contextWindow: 11000 } },
    f.provider.id,
    f.provider.revision + 1,
  );
  const bounded = await f.writing.preview({
    ...f.input,
    providerConfigId: small.id,
    context: { ...f.input.context, selectedVersionIds: [] },
  });
  expect(bounded.estimatedInputTokens).toBeLessThanOrEqual(bounded.inputLimit);
  expect(bounded.omitted).toContain('大人物：推荐片段超出预算');
});

it('registers citations for valid large read results without a result-size limit', async () => {
  const f = await fixture((request) => {
    const { allowedDocuments } = JSON.parse((request.messages[0] as { content: string }).content);
    const ref = allowedDocuments.find((r: { title: string }) => r.title === '长资料');
    return new FakeModelAdapter([
      [
        answer('', [
          {
            id: 'read',
            name: 'read_document',
            arguments: { documentId: ref.documentId, versionId: ref.versionId },
          },
        ]),
      ],
      [answer('done')],
    ]);
  });
  const large = f.create('character', '长资料', '长'.repeat(9000), {
    metadata: { description: '大'.repeat(40000) },
  });
  const input = { ...f.input, context: { ...f.input.context, selectedVersionIds: [] } };
  const preview = await f.writing.preview(input);
  expect(preview.entries.some((e) => e.documentId === large.document.id)).toBe(false);
  const run = await done(f.writing, (await f.writing.create(input, randomUUID())).id);
  expect(run.status).toBe('completed');
  expect(run.tools[0]?.result).toMatchObject({ ok: true });
  expect(run.contexts.some((e) => e.documentId === large.document.id)).toBe(true);
});

it('refuses cross-project sessions and exposes stable session/message pagination', async () => {
  const f = await fixture();
  const other = f.novels.createProject('别部作品');
  const foreign = f.writing.store.session(other.id, null, '私有会话');
  await expect(f.writing.preview({ ...f.input, sessionId: foreign.id })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  for (let i = 0; i < 3; i++) f.writing.store.session(f.project.id, null, `会话${i}`);
  const first = f.writing.store.sessions(f.project.id, 2);
  const second = f.writing.store.sessions(f.project.id, 2, first.nextCursor as string);
  expect(new Set([...first.data, ...second.data].map((s) => s.id)).size).toBe(3);
  expect(second.nextCursor).toBeNull();
  const sessionId = first.data[0]?.id as string;
  for (let i = 0; i < 2; i++)
    await done(
      f.writing,
      (await f.writing.create({ ...f.input, sessionId, input: `任务${i}` }, randomUUID())).id,
    );
  const messages = f.writing.store.messages(sessionId, 2);
  const older = f.writing.store.messages(sessionId, 2, messages.nextCursor as string);
  expect(messages.data.map((m) => m.content)).toContain('任务1');
  expect(older.data.map((m) => m.content)).toContain('任务0');
  expect(new Set([...messages.data, ...older.data].map((m) => m.id)).size).toBe(4);
});

it('does not let an unread SSE connection block background completion', async () => {
  const f = await fixture(
    () =>
      new FakeModelAdapter([
        [
          ...Array.from({ length: 24 }, () => ({
            type: 'text_delta' as const,
            text: '流'.repeat(1024),
          })),
          answer('流'.repeat(24 * 1024)),
        ],
      ]),
  );
  const created = await f.writing.create(f.input, randomUUID());
  const stream = await f.app.request(`http://localhost/api/v1/runs/${created.id}/events?after=0`);
  expect(stream.status).toBe(200);
  expect((await done(f.writing, created.id)).status).toBe('completed');
  await stream.body?.cancel();
});

it('applies the input budget again after tools extend the conversation', async () => {
  const f = await fixture((request) => {
    const { allowedDocuments } = JSON.parse((request.messages[0] as { content: string }).content);
    const ref = allowedDocuments.find((r: { title: string }) => r.title === '长文');
    return new FakeModelAdapter([
      [
        answer('', [
          {
            id: 'read',
            name: 'read_document',
            arguments: { documentId: ref.documentId, versionId: ref.versionId },
          },
        ]),
      ],
      [answer('must not call')],
    ]);
  });
  f.create('character', '长文', '文'.repeat(8000));
  f.writing.providers.save(
    { ...f.provider.config, connection: { ...f.provider.config.connection, contextWindow: 15000 } },
    f.provider.id,
    f.provider.revision,
  );
  const run = await done(
    f.writing,
    (
      await f.writing.create(
        { ...f.input, context: { ...f.input.context, selectedVersionIds: [] } },
        randomUUID(),
      )
    ).id,
  );
  expect(run.stopReason).toBe('CONTEXT_TOO_LARGE');
  expect(run.turns[0]?.status).toBe('complete');
  expect(run.turns[1]?.response).toBeNull();
});
