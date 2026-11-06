import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

async function setup(request: APIRequestContext, model = 'fixture-write') {
  const project = (
    await (
      await request.post('/api/v1/projects', { data: { title: `写作 ${crypto.randomUUID()}` } })
    ).json()
  ).data;
  Object.assign(
    project,
    (
      await (
        await request.post(`/api/v1/projects/${project.id}/setup-completion`, {
          data: { baseStructureVersion: project.structureVersion },
        })
      ).json()
    ).data,
  );
  let structure = (await (await request.get(`/api/v1/projects/${project.id}/structure`)).json())
    .data;
  const chapter = (
    await (
      await request.post(`/api/v1/projects/${project.id}/documents`, {
        data: {
          kind: 'chapter',
          title: '第一章',
          content: '林舟用左手开窗。',
          baseStructureVersion: structure.project.structureVersion,
        },
      })
    ).json()
  ).data;
  structure = (await (await request.get(`/api/v1/projects/${project.id}/structure`)).json()).data;
  await request.post(`/api/v1/projects/${project.id}/documents`, {
    data: {
      kind: 'character',
      title: '林舟',
      content: '林舟惯用左手。',
      baseStructureVersion: structure.project.structureVersion,
    },
  });
  const job = (
    await (
      await request.post('/api/v1/skills/import/local', {
        multipart: {
          files: {
            name: 'SKILL.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from(
              '---\nname: 写作助手\ndescription: 小说续写时读取资料并生成候选。\n---\n读取允许资料后生成候选。',
            ),
          },
          paths: JSON.stringify(['SKILL.md']),
        },
      })
    ).json()
  ).data;
  let skillId = '';
  await expect
    .poll(async () => {
      const jobState = (await (await request.get(`/api/v1/skill-imports/${job.id}`)).json()).data;
      skillId = jobState.skillId;
      return jobState.status;
    })
    .toBe('completed');
  const providerResponse = await request.post('/api/v1/provider-configs', {
    data: {
      name: model,
      modelId: model,
      connection: {
        api: 'openai-completions',
        provider: 'fixture',
        baseUrl: 'http://127.0.0.1:4179/v1',
        credentialRef: null,
        contextWindow: 32000,
        maxOutputTokens: 1024,
        reasoning: model === 'fixture-thinking',
      },
      parameters: {},
    },
  });
  expect(providerResponse.ok()).toBe(true);
  const provider = (await providerResponse.json()).data;
  return { project, chapter, skillId, provider };
}
async function open(page: Page, f: Awaited<ReturnType<typeof setup>>) {
  await page.goto(`/?project=${f.project.id}&document=${f.chapter.document.id}`);
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('林舟用左手开窗。');
  await page.getByLabel('写作模型', { exact: true }).selectOption(f.provider.id);
  const debug = page.getByRole('button', { name: 'Debug 调试信息' });
  if ((await debug.getAttribute('aria-pressed')) !== 'true') await debug.click();
  await expect(page.getByLabel('执行 Skill', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Skill 版本', { exact: true })).toHaveCount(0);
}
async function start(page: Page, task = '续写第一章') {
  await page.getByLabel('写作任务', { exact: true }).fill(task);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'AI 聊天侧栏', exact: true })).toBeVisible();
}

test('the outline assistant generates, previews and saves a total outline while an event is selected', async ({
  page,
  request,
}) => {
  const f = await setup(request, 'fixture-master-outline');
  const structure = (await (await request.get(`/api/v1/projects/${f.project.id}/structure`)).json())
    .data;
  const event = (
    await (
      await request.post(`/api/v1/projects/${f.project.id}/documents`, {
        data: {
          kind: 'chapter_outline',
          title: '雨夜来客',
          content: '保留原事件大纲',
          baseStructureVersion: structure.project.structureVersion,
        },
      })
    ).json()
  ).data;
  await page.goto(`/?project=${f.project.id}&document=${event.document.id}&view=outline`);
  await page.getByLabel('写作模型', { exact: true }).selectOption(f.provider.id);
  await page.getByRole('button', { name: 'AI 生成总纲', exact: true }).click();
  await expect(page.locator('.chat-task textarea')).toHaveValue(/生成一份完整的故事总纲/);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const card = page.locator('.outline-creation-card');
  await expect(card).toContainText('故事总纲候选');
  await expect(card.getByRole('button', { name: '保存故事总纲', exact: true })).toBeEnabled();
  await card.locator('summary').click();
  await expect(card.getByRole('heading', { name: '高潮与结局', exact: true })).toBeVisible();
  const before = (await (await request.get(`/api/v1/projects/${f.project.id}/structure`)).json())
    .data;
  expect(
    before.documents.filter((doc: { kind: string }) => doc.kind === 'master_outline'),
  ).toHaveLength(0);
  await card.getByRole('button', { name: '保存故事总纲', exact: true }).click();
  const sidebar = page.getByRole('complementary', { name: '故事时间线目录', exact: true });
  await expect(sidebar.getByRole('button', { name: '雾港故事总纲', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const after = (await (await request.get(`/api/v1/projects/${f.project.id}/structure`)).json())
    .data;
  expect(
    after.documents.filter((doc: { kind: string }) => doc.kind === 'master_outline'),
  ).toHaveLength(1);
  expect(after.documents.filter((doc: { kind: string }) => doc.kind === 'chapter')).toHaveLength(1);
  expect(
    (await (await request.get(`/api/v1/documents/${event.document.id}`)).json()).data.version
      .content,
  ).toBe('保留原事件大纲');
  await page.reload();
  await expect(sidebar.getByRole('button', { name: '雾港故事总纲', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('thinking streams before completion, survives reload and stays out of the novel', async ({
  page,
  request,
}, testInfo) => {
  const f = await setup(request, 'fixture-thinking');
  await open(page, f);
  await start(page);
  await page.locator('.trace-row.kind-thinking > summary').first().click();
  const firstThought = page.locator('.trace-row.kind-thinking').first();
  await expect(firstThought).toContainText('第1轮：先核对人物资料，再生成正文。');
  await expect(page.getByRole('button', { name: '取消运行', exact: true })).toBeVisible();
  await page.reload();
  await page.locator('.trace-row.kind-thinking > summary').first().click();
  await expect(firstThought).toContainText('第1轮：先核对人物资料，再生成正文。');
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  await expect(page.locator('.trace-row.kind-thinking').nth(2)).toContainText(
    '第3轮：先核对人物资料，再生成正文。',
  );
  await expect(page.getByLabel('助手回复', { exact: true })).toHaveText('林舟用左手拨开窗栓。');
  await page.getByRole('button', { name: '采纳修改', exact: true }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('林舟用左手拨开窗栓。');
  const screenshot = testInfo.outputPath('thinking-output.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Thinking output', { path: screenshot, contentType: 'image/png' });
  await page.locator('.trace-row.kind-thinking > summary').first().click();
  await expect(firstThought).not.toHaveAttribute('open', '');
  await page.reload();
  await page.locator('.trace-row.kind-thinking > summary').first().click();
  await expect(firstThought).toContainText('第1轮：先核对人物资料，再生成正文。');
});

test('a model with no thinking has an explicit empty state', async ({ page, request }) => {
  const f = await setup(request);
  await open(page, f);
  await start(page);
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  await expect(page.locator('.trace-row.kind-thinking')).toHaveCount(0);
  await expect(page.getByLabel('助手回复', { exact: true })).toHaveText('林舟用左手拨开窗栓。');
});

test('the agent loads a Skill from its prompt catalog through the real SDK tool loop', async ({
  page,
  request,
}) => {
  const f = await setup(request, 'fixture-skills');
  await open(page, f);
  await start(page);
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  const summary = (await (await request.get(`/api/v1/runs?projectId=${f.project.id}`)).json())
    .data[0];
  const run = (await (await request.get(`/api/v1/runs/${summary.id}`)).json()).data;
  expect(run.input.skillVersionId).toBeUndefined();
  expect(run.preview.request.systemPrompt).toContain('小说续写时读取资料并生成候选。');
  expect(run.preview.request.systemPrompt).not.toContain('读取允许资料后生成候选。');
  expect(run.tools.map((tool: { name: string }) => tool.name)).toEqual([
    'load_skill',
    'read_document',
    'propose_document_change',
  ]);
  expect(run.tools[0].result).toMatchObject({
    ok: true,
    value: {
      content: expect.stringContaining('读取允许资料后生成候选。'),
    },
  });
  expect(run.turns).toHaveLength(4);
  expect(JSON.stringify(run.turns[1].request.messages)).toContain('读取允许资料后生成候选。');
  await expect(page.getByLabel('助手回复', { exact: true })).toHaveText('林舟用左手拨开窗栓。');
});

test('authors edit and restore the Agent prompt, and new runs receive the saved text', async ({
  page,
  request,
}, testInfo) => {
  const original = (await (await request.get('/api/v1/agent-prompt')).json()).data;
  const f = await setup(request);
  const custom = `${original.prompt}\n\n编辑器验证：使用简洁中文回答。`;
  try {
    await open(page, f);
    await page.getByRole('link', { name: 'Agent 提示词', exact: true }).click();
    let dialog = page.getByRole('main', { name: 'Agent 提示词', exact: true });
    await expect(dialog.getByLabel('系统提示词', { exact: true })).toHaveValue(original.prompt);
    await dialog.getByLabel('系统提示词', { exact: true }).fill(custom);
    await dialog.getByRole('button', { name: '保存提示词', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('提示词已保存');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    await page.getByRole('link', { name: 'Agent 提示词', exact: true }).click();
    dialog = page.getByRole('main', { name: 'Agent 提示词', exact: true });
    await expect(dialog.getByLabel('系统提示词', { exact: true })).toHaveValue(custom);
    const screenshot = testInfo.outputPath('agent-prompt.png');
    await dialog.screenshot({ path: screenshot });
    await testInfo.attach('Agent prompt editor', { path: screenshot, contentType: 'image/png' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByLabel('写作模型', { exact: true }).selectOption(f.provider.id);
    await start(page);
    await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
    const summary = (await (await request.get(`/api/v1/runs?projectId=${f.project.id}`)).json())
      .data[0];
    const run = (await (await request.get(`/api/v1/runs/${summary.id}`)).json()).data;
    expect(run.preview.request.systemPrompt.startsWith(custom)).toBe(true);
    await page.getByRole('link', { name: 'Agent 提示词', exact: true }).click();
    dialog = page.getByRole('main', { name: 'Agent 提示词', exact: true });
    await expect(dialog.getByLabel('系统提示词', { exact: true })).toHaveValue(custom);
    await dialog.getByRole('button', { name: '恢复默认', exact: true }).click();
    await expect(dialog.getByLabel('系统提示词', { exact: true })).toHaveValue(
      original.defaultPrompt,
    );
    await dialog.getByRole('button', { name: '保存提示词', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('提示词已保存');
    expect((await (await request.get('/api/v1/agent-prompt')).json()).data.prompt).toBe(
      original.defaultPrompt,
    );
  } finally {
    const latest = (await (await request.get('/api/v1/agent-prompt')).json()).data;
    await request.put('/api/v1/agent-prompt', {
      data: { prompt: original.prompt, revision: latest.revision },
    });
  }
});

test('real pi-ai HTTP path reads frozen material, stages a proposal, and authors accept it into history', async ({
  page,
  request,
}) => {
  const f = await setup(request);
  await open(page, f);
  await start(page);
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  await expect(page.getByLabel('助手回复', { exact: true })).toContainText('林舟用左手拨开窗栓。');
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('林舟用左手开窗。');
  await page.getByRole('button', { name: '在正文区查看差异', exact: true }).click();
  await page.getByRole('button', { name: '采纳修改', exact: true }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('林舟用左手拨开窗栓。');
  await page.getByRole('button', { name: '版本历史', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('版本');
  const saved = (await (await request.get(`/api/v1/documents/${f.chapter.document.id}`)).json())
    .data;
  expect(saved.version).toMatchObject({ source: 'proposal', versionNo: 2 });
});

test('selection rewriting replaces only the chosen saved UTF-16 range', async ({
  page,
  request,
}) => {
  const f = await setup(request);
  await open(page, f);
  const editor = page.getByLabel('文档正文', { exact: true });
  await editor.focus();
  await editor.press('Home');
  await editor.press('ArrowRight');
  await editor.press('ArrowRight');
  for (let i = 0; i < 3; i++) await editor.press('Shift+ArrowRight');
  await page.getByLabel('任务用途', { exact: true }).selectOption('rewrite');
  await start(page, '只改写所选句子');
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '在正文区查看差异', exact: true }).click();
  await page.getByRole('button', { name: '采纳修改', exact: true }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue(
    '林舟林舟用左手拨开窗栓。开窗。',
  );
});

test('cancellation survives a reload and retry preserves its parent run', async ({
  page,
  request,
}) => {
  const f = await setup(request, 'fixture-slow');
  await open(page, f);
  await start(page, '可取消的写作');
  await expect(page.getByRole('button', { name: '取消运行', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消运行', exact: true }).click();
  await expect(page.getByText('运行状态：已取消 · cancelled', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('运行状态：已取消 · cancelled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '从完整检查点重试', exact: true }).click();
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  const runs = (await (await request.get(`/api/v1/runs?projectId=${f.project.id}`)).json()).data;
  expect(runs).toHaveLength(2);
  const retried = (await (await request.get(`/api/v1/runs/${runs[0].id}`)).json()).data;
  expect(retried.retryOfRunId).toBe(runs[1].id);
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('林舟用左手开窗。');
});

test('old proposal conflicts preserve the newer document and candidate text', async ({
  page,
  request,
}) => {
  const f = await setup(request);
  await open(page, f);
  await start(page);
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  await page.getByLabel('文档正文', { exact: true }).fill('作者修改后的正文');
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '在正文区查看差异', exact: true }).click();
  await expect(
    page.getByText('当前内容已变化，以下为生成时的原文对比。请返回编辑并重新生成提议。'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '采纳修改', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('作者修改后的正文');
  await expect(page.getByLabel('助手回复', { exact: true })).toContainText('林舟用左手拨开窗栓。');
});

test('EventSource reconnect sends Last-Event-ID even though its original after remains unchanged', async ({
  page,
  request,
}) => {
  const f = await setup(request, 'fixture-slow');
  await open(page, f);
  await start(page, '浏览器断线重连');
  let runId = '';
  await expect
    .poll(async () => {
      const data = (await (await request.get(`/api/v1/runs?projectId=${f.project.id}`)).json())
        .data;
      runId = data[0]?.id ?? '';
      return runId;
    })
    .not.toBe('');
  let connections: { after: string; lastEventId: string | null }[] = [];
  await expect
    .poll(async () => {
      connections = await (await request.get(`/__test/sse?runId=${runId}`)).json();
      return connections.length;
    })
    .toBeGreaterThan(1);
  expect(Number(connections[1]?.lastEventId)).toBeGreaterThan(Number(connections[0]?.after));
  expect(connections[1]?.after).toBe(connections[0]?.after);
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  await expect(page.getByLabel('助手回复', { exact: true })).toHaveText('林舟用左手拨开窗栓。');
});

test('model settings persist non-sensitive configuration and record an explicit SDK connection check', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: '模型设置', exact: true }).click();
  const dialog = page.getByRole('main', { name: '模型设置' });
  await dialog.getByLabel('配置名称', { exact: true }).fill('设置界面验证');
  await dialog.getByLabel('模型 ID', { exact: true }).fill('fixture-check');
  await dialog.getByLabel('供应商标识', { exact: true }).fill('fixture');
  await dialog.getByLabel('接口地址', { exact: true }).fill('http://127.0.0.1:4179/v1');
  await dialog.getByLabel('上下文窗口', { exact: true }).fill('500000');
  await dialog.getByLabel('输出上限', { exact: true }).fill('65536');
  await dialog.getByLabel('API 密钥', { exact: true }).fill('');
  await dialog.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('模型配置已保存');
  await dialog.getByRole('button', { name: '检查已保存连接', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('fixture-check / completed / complete');
  await expect(dialog.getByRole('status')).toContainText('费用 未知');
  const provider = (await (await request.get('/api/v1/provider-configs')).json()).data.find(
    (p: { config: { name: string } }) => p.config.name === '设置界面验证',
  );
  const checks = (
    await (await request.get(`/api/v1/provider-configs/${provider.id}/checks`)).json()
  ).data;
  expect(provider.config.connection).toMatchObject({
    contextWindow: 500000,
    maxOutputTokens: 65536,
  });
  expect(checks[0]).toMatchObject({
    modelId: 'fixture-check',
    status: 'completed',
    usage: { known: { inputTokens: 20, outputTokens: 5, cost: null }, complete: false },
  });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await page.getByRole('link', { name: '模型设置', exact: true }).click();
  await page
    .getByRole('main', { name: '模型设置' })
    .getByRole('combobox')
    .first()
    .selectOption(provider.id);
  await expect(
    page.getByRole('main', { name: '模型设置' }).getByLabel('模型 ID', { exact: true }),
  ).toHaveValue('fixture-check');
  await expect(
    page.getByRole('main', { name: '模型设置' }).getByLabel('上下文窗口', { exact: true }),
  ).toHaveValue('500000');
  await expect(
    page.getByRole('main', { name: '模型设置' }).getByLabel('输出上限', { exact: true }),
  ).toHaveValue('65536');
});

test('a provider failure stays visible after reload and explicit retry resumes without repeating the read', async ({
  page,
  request,
}) => {
  const f = await setup(request, 'fixture-fail-once');
  await open(page, f);
  await start(page, '失败后继续');
  await expect(
    page.getByText('运行状态：失败 · PROVIDER_UNAVAILABLE', { exact: true }),
  ).toBeVisible();
  const first = (await (await request.get(`/api/v1/runs?projectId=${f.project.id}`)).json())
    .data[0];
  await page.reload();
  await expect(
    page.getByText('运行状态：失败 · PROVIDER_UNAVAILABLE', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '从完整检查点重试', exact: true }).click();
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  const next = (
    await (await request.get(`/api/v1/runs?projectId=${f.project.id}`)).json()
  ).data.find((run: { retryOfRunId: string }) => run.retryOfRunId === first.id);
  const detail = (await (await request.get(`/api/v1/runs/${next.id}`)).json()).data;
  expect(detail.turns[0].turnIndex).toBe(1);
  expect(detail.tools.map((t: { name: string }) => t.name)).toEqual(['propose_document_change']);
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('林舟用左手开窗。');
});

test('writing continues in the background after switching pages and returns to the same run', async ({
  page,
  request,
}) => {
  const f = await setup(request, 'fixture-slow');
  await open(page, f);
  await start(page, '离开页面后继续的写作');
  await expect(page.getByRole('button', { name: '取消运行', exact: true })).toBeVisible();
  let runId = '';
  await expect
    .poll(async () => {
      const runs = (await (await request.get(`/api/v1/runs?projectId=${f.project.id}`)).json())
        .data;
      runId = runs[0]?.id ?? '';
      return runId;
    })
    .not.toBe('');
  const navigation = page.getByRole('navigation', { name: '页面导航' });
  await navigation.getByRole('link', { name: '通用 Skill', exact: true }).click();
  await expect(page).toHaveURL('/skills');
  await navigation.getByRole('link', { name: '写作', exact: true }).click();
  await expect(page.getByText('运行状态：已完成', { exact: true })).toBeVisible();
  await expect(page.getByLabel('助手回复', { exact: true })).toContainText('林舟用左手拨开窗栓。');
  const runs = (await (await request.get(`/api/v1/runs?projectId=${f.project.id}`)).json()).data;
  expect(runs).toHaveLength(1);
  expect(runs[0].id).toBe(runId);
  expect(
    (await (await request.get(`/api/v1/documents/${f.chapter.document.id}`)).json()).data.version
      .content,
  ).toBe('林舟用左手开窗。');
});

test('returning from model settings refreshes options and retains the selected model', async ({
  page,
  request,
}) => {
  const f = await setup(request);
  await open(page, f);
  const navigation = page.getByRole('navigation', { name: '页面导航' });
  await navigation.getByRole('link', { name: '模型设置', exact: true }).click();
  const settings = page.getByRole('main', { name: '模型设置', exact: true });
  await settings.getByRole('combobox', { name: /已有配置/ }).selectOption(f.provider.id);
  const label = `更新的模型 ${crypto.randomUUID()}`;
  await settings.getByLabel('配置名称', { exact: true }).fill(label);
  await settings.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('模型配置已保存');
  await navigation.getByRole('link', { name: '写作', exact: true }).click();
  await expect(page.getByLabel('写作模型', { exact: true })).toHaveValue(f.provider.id);
  await expect(
    page.getByLabel('写作模型', { exact: true }).locator('option:checked'),
  ).toContainText(label);
});
