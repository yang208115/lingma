import { expect, type Page, test } from '@playwright/test';

async function chooseWorkflow(page: Page, name: string) {
  await page.getByRole('button', { name: '执行方式', exact: true }).click();
  await page.getByRole('menuitemradio', { name: `${name} v1`, exact: true }).click();
}

test('creates a custom Agent, adds it to a template, resumes the chapter flow after reload and accepts the final draft', async ({
  page,
  request,
}, testInfo) => {
  const project = (
    await (
      await request.post('/api/v1/projects', { data: { title: `协作 ${crypto.randomUUID()}` } })
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
  const chapter = (
    await (
      await request.post(`/api/v1/projects/${project.id}/documents`, {
        data: {
          kind: 'chapter',
          title: '雨夜来客',
          content: '旧正文。',
          baseStructureVersion: project.structureVersion,
        },
      })
    ).json()
  ).data;
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: '协作测试模型',
          modelId: 'fixture-workflow',
          connection: {
            api: 'openai-completions',
            provider: 'fixture',
            baseUrl: 'http://127.0.0.1:4179/v1',
            credentialRef: null,
            contextWindow: 64000,
            maxOutputTokens: 4096,
          },
          parameters: {},
        },
      })
    ).json()
  ).data;
  await page.goto(`/?project=${project.id}&document=${chapter.document.id}`);
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('旧正文。');
  await page.getByRole('link', { name: 'Agent 角色库', exact: true }).click();
  const dialog = page.locator('main.management-page');
  await expect(
    dialog.getByRole('button', { name: '章纲策划', exact: false }).first(),
  ).toBeVisible();
  const name = `伏笔审校-${crypto.randomUUID().slice(0, 8)}`;
  await dialog.getByLabel('Agent 名称', { exact: true }).fill(name);
  await dialog.getByLabel('能力类型', { exact: true }).selectOption('review');
  await dialog
    .getByLabel('角色提示词', { exact: true })
    .fill('检查伏笔与人物知识边界，提交具体问题和引用。');
  await dialog.getByRole('button', { name: '保存并发布 Agent', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: '已发布角色版本' })).toBeVisible();
  await dialog.getByRole('link', { name: '工作流模板', exact: true }).click();
  await dialog.locator('aside button').first().click();
  await dialog.getByRole('button', { name: '复制为新模板', exact: true }).click();
  const templateName = `悬疑流程-${crypto.randomUUID().slice(0, 8)}`;
  await dialog.getByLabel('模板名称', { exact: true }).fill(templateName);
  await dialog.getByRole('button', { name: '列表编辑', exact: true }).click();
  await dialog.getByRole('button', { name: '＋ 添加阶段', exact: true }).click();
  const last = dialog.getByRole('region', { name: '工作流配置' }).locator('fieldset').last();
  await last.getByLabel('阶段名称', { exact: true }).fill('自定义伏笔检查');
  await last.getByLabel('执行 Agent 版本', { exact: true }).selectOption({ label: `${name} · v1` });
  await last.getByRole('button', { name: '上移', exact: true }).click();
  await dialog.getByRole('button', { name: '保存并发布模板', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: '模板已发布' })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('写作模型', { exact: true }).selectOption(provider.id);
  await chooseWorkflow(page, templateName);
  await page
    .getByLabel('写作任务', { exact: true })
    .fill('写雨夜来客一章，林舟惯用左手，保留铜铃伏笔。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const card = page.getByRole('article', { name: '编排运行', exact: true }).last();
  await expect(card.getByRole('button', { name: '采用并保存正文写作', exact: true })).toBeVisible();
  await expect(card.locator('.assistant-workflow-stages')).toContainText('自定义伏笔检查');
  await expect(card.locator('.assistant-workflow-stages')).toContainText('审校汇总');
  const runs = (await (await request.get(`/api/v1/workflows?projectId=${project.id}`)).json()).data;
  const started = runs.find(
    (run: { snapshot: { template: { config: { name: string } } } }) =>
      run.snapshot.template.config.name === templateName,
  );
  // Opening a bookmarked run also restores its conversation in a fresh tab state.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`/projects/${project.id}/workflows?run=${started.id}`);
  await expect(page).toHaveURL(
    `/projects/${project.id}/writing?workflow=${started.id}&document=${chapter.document.id}`,
  );
  await expect(card.getByRole('button', { name: '采用并保存正文写作', exact: true })).toBeVisible();
  await page.reload();
  await expect(card.getByRole('button', { name: '采用并保存正文写作', exact: true })).toBeVisible();
  // The run graph colours each node by its live status.
  await card.getByText('流程图（节点状态）', { exact: true }).click();
  await expect(card.locator('.workflow-graph-node.run-released').first()).toBeVisible();
  await card.getByText('流程图（节点状态）', { exact: true }).click();
  // Every node's returned content is readable without leaving the card.
  await card.getByText('查看返回内容', { exact: false }).first().click();
  await expect(card.locator('.workflow-plan-box').first()).toBeVisible();
  await card.getByText('用量', { exact: true }).click();
  await expect(card).toContainText('模型调用');
  const screen = testInfo.outputPath('collaborative-workflow.png');
  await page.screenshot({ path: screen, fullPage: true });
  await testInfo.attach('自定义 Agent 协作写作', { path: screen, contentType: 'image/png' });
  await card.getByRole('button', { name: '采用并保存正文写作', exact: true }).click();
  await expect(card.getByRole('status').first()).toHaveText('已结束');
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue(
    '林舟用左手拨开窗栓。雨声里，来客的说辞露出了破绽。',
  );
  // Manual gating: every node stops for the author, who can read it and release it.
  await page.goto(`/?project=${project.id}&document=${chapter.document.id}`);
  await page.getByLabel('写作模型', { exact: true }).selectOption(provider.id);
  await chooseWorkflow(page, templateName);
  await page.getByLabel('全部手动放行', { exact: true }).check();
  await page.getByLabel('写作任务', { exact: true }).fill('手动放行的新一章。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const manual = page.getByRole('article', { name: '编排运行', exact: true }).last();
  const release = manual.getByRole('button', { name: /^放行/ });
  await expect(release).toBeVisible();
  await expect(manual).toContainText('等待放行');
  for (let i = 0; i < 8; i++) {
    if (await manual.getByRole('button', { name: '采用并保存正文写作', exact: true }).isVisible())
      break;
    if (await release.isVisible()) await release.click();
    await page.waitForTimeout(400);
  }
  await expect(
    manual.getByRole('button', { name: '采用并保存正文写作', exact: true }),
  ).toBeVisible();
  const manualId = (
    (await (await request.get(`/api/v1/workflows?projectId=${project.id}`)).json()).data as {
      id: string;
      snapshot: { input: { input: string } };
    }[]
  ).find((run) => run.snapshot.input.input === '手动放行的新一章。')?.id as string;
  const other = (
    await (
      await request.post('/api/v1/projects', { data: { title: '不相关项目', format: 'short' } })
    ).json()
  ).data;
  await page.goto(`/projects/${other.id}/workflows?run=${manualId}`);
  await expect(page.getByRole('alert')).toContainText('运行记录不属于当前作品');
  await expect(card).toHaveCount(0);
  await page.goto(`/projects/${other.id}/writing?workflow=${manualId}`);
  await expect(page.getByRole('alert')).toContainText('运行记录不属于当前作品');
  await expect(card).toHaveCount(0);
});

test('trial-runs an unpublished custom Agent without changing formal text', async ({
  page,
  request,
}) => {
  const project = (
    await (
      await request.post('/api/v1/projects', {
        data: { title: `角色试运行 ${crypto.randomUUID()}` },
      })
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
  const chapter = (
    await (
      await request.post(`/api/v1/projects/${project.id}/documents`, {
        data: {
          kind: 'chapter',
          title: '试验章节',
          content: '来客停在门外。',
          baseStructureVersion: project.structureVersion,
        },
      })
    ).json()
  ).data;
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: '试运行模型',
          modelId: 'fixture-workflow',
          connection: {
            api: 'openai-completions',
            provider: 'fixture',
            baseUrl: 'http://127.0.0.1:4179/v1',
            credentialRef: null,
            contextWindow: 64000,
            maxOutputTokens: 4096,
          },
          parameters: {},
        },
      })
    ).json()
  ).data;
  await page.goto(`/?project=${project.id}&document=${chapter.document.id}`);
  await page.getByRole('link', { name: 'Agent 角色库', exact: true }).click();
  const dialog = page.locator('main.management-page');
  await dialog.getByLabel('Agent 名称', { exact: true }).fill('未发布的对白检查');
  await dialog.getByLabel('角色模型', { exact: true }).selectOption(provider.id);
  await dialog.getByRole('button', { name: '保存并试运行 Agent', exact: true }).click();
  await expect(dialog.getByText('角色试运行 · 已结束', { exact: true })).toBeVisible();
  await expect(dialog.getByText('无重要问题', { exact: false }).first()).toBeVisible();
  const roles = (await (await request.get('/api/v1/agent-profiles')).json()).data;
  expect(
    roles.find((r: { draft: { name: string } }) => r.draft.name === '未发布的对白检查').versions,
  ).toHaveLength(0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('来客停在门外。');
});

test('runs worldbuilding, total outline and event workflows inside the writing assistant without changing the open chapter', async ({
  page,
  request,
}, testInfo) => {
  const projectResponse = await request.post('/api/v1/projects', {
    data: { title: `通用编排 ${crypto.randomUUID()}` },
  });
  const project = (await projectResponse.json()).data;
  await request.post(`/api/v1/projects/${project.id}/setup-completion`, {
    data: { baseStructureVersion: project.structureVersion },
  });
  const structure = (await (await request.get(`/api/v1/projects/${project.id}/structure`)).json())
    .data;
  const chapter = (
    await (
      await request.post(`/api/v1/projects/${project.id}/documents`, {
        data: {
          kind: 'chapter',
          title: '保留的正文',
          content: '这是作者的原文。',
          baseStructureVersion: structure.project.structureVersion,
        },
      })
    ).json()
  ).data;
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: `通用编排模型-${crypto.randomUUID().slice(0, 6)}`,
          modelId: 'fixture-workflow',
          connection: {
            api: 'openai-completions',
            provider: 'fixture',
            baseUrl: 'http://127.0.0.1:4179/v1',
            credentialRef: null,
            contextWindow: 64000,
            maxOutputTokens: 4096,
          },
          parameters: {},
        },
      })
    ).json()
  ).data;
  await page.goto(`/?project=${project.id}&document=${chapter.document.id}`);
  await page.getByLabel('写作模型', { exact: true }).selectOption(provider.id);
  await chooseWorkflow(page, '世界观构建与审校');
  await page.getByLabel('写作任务', { exact: true }).fill('设计一个施法会失去记忆的港城世界观。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  let card = page.getByRole('article', { name: '编排运行', exact: true }).last();
  await expect(card).toContainText('雾港世界观');
  await expect(card.getByRole('button', { name: '采用全部剩余条目', exact: true })).toBeEnabled();
  await page.reload();
  card = page.getByRole('article', { name: '编排运行', exact: true }).last();
  await expect(card.getByRole('button', { name: '采用全部剩余条目', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: '采用全部剩余条目', exact: true }).click();
  await expect(card).toContainText('已保存 1 份文档');
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('这是作者的原文。');
  await chooseWorkflow(page, '故事总纲规划');
  await page.getByLabel('写作任务', { exact: true }).fill('根据刚采用的世界观规划故事总纲。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  card = page.getByRole('article', { name: '编排运行', exact: true }).last();
  await expect(card.getByRole('button', { name: '采用并保存故事总纲', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: '采用并保存故事总纲', exact: true }).click();
  await expect(card).toContainText('已保存 1 份文档');
  await chooseWorkflow(page, '故事事件规划');
  await page.getByLabel('写作任务', { exact: true }).fill('根据总纲拆分开篇两个故事事件。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  card = page.getByRole('article', { name: '编排运行', exact: true }).last();
  await expect(card.getByRole('button', { name: '采用并保存事件规划', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: '采用并保存事件规划', exact: true }).click();
  await expect(card).toContainText('已保存 2 份文档');
  const after = (await (await request.get(`/api/v1/projects/${project.id}/structure`)).json()).data;
  expect(
    after.documents.filter((item: { kind: string }) => item.kind === 'worldbuilding'),
  ).toHaveLength(1);
  expect(
    after.documents.filter((item: { kind: string }) => item.kind === 'master_outline'),
  ).toHaveLength(1);
  expect(
    after.documents.filter((item: { kind: string }) => item.kind === 'chapter_outline'),
  ).toHaveLength(2);
  const original = (await (await request.get(`/api/v1/documents/${chapter.document.id}`)).json())
    .data;
  expect(original.version.id).toBe(chapter.version.id);
  expect(original.version.content).toBe('这是作者的原文。');
  await page.screenshot({
    path: testInfo.outputPath('generic-workflow-assistant.png'),
    fullPage: true,
  });
});

test('edits workflow graphs with draggable nodes, real connections and a persisted inspector', async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 1680, height: 1100 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/workflow-templates');
  const studio = page.locator('main.management-page');
  await studio
    .locator('.workflow-template-columns > aside button')
    .filter({ hasText: '世界观构建与审校' })
    .click();
  await studio.getByRole('button', { name: '复制为新模板', exact: true }).click();
  const name = `画布编排-${crypto.randomUUID().slice(0, 8)}`;
  await studio.getByLabel('模板名称', { exact: true }).fill(name);
  const canvas = studio.getByRole('region', { name: '工作流节点画布' });
  await expect(canvas.locator('.react-flow__node')).toHaveCount(6);
  await expect(canvas.locator('.react-flow__node[data-id="__review_gate"]')).toContainText(
    '审校汇总',
  );
  await canvas.locator('.react-flow__node[data-id="review"]').click();
  const inspector = studio.getByRole('complementary', { name: '节点配置' });
  await inspector.getByLabel('阶段名称', { exact: true }).fill('设定一致性检查');
  await inspector.getByRole('button', { name: '移除来自生成方案的连线' }).click();
  await expect(
    studio.getByRole('status').filter({ hasText: '需要连接到最终生成节点' }),
  ).toBeVisible();
  const source = canvas.locator('.react-flow__node[data-id="generate"] .react-flow__handle-right');
  const target = canvas.locator('.react-flow__node[data-id="review"] .react-flow__handle-left');
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('missing graph handles');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(studio.getByRole('status').filter({ hasText: '流程配置有效' })).toBeVisible();
  await inspector.getByRole('button', { name: '关闭节点配置' }).click();
  const heading = canvas.locator('.react-flow__node[data-id="generate"] .workflow-node-heading');
  const before = await heading.boundingBox();
  if (!before) throw new Error('missing node');
  await page.mouse.move(before.x + 30, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + 100, before.y + 80, { steps: 12 });
  await page.mouse.up();
  await studio.getByRole('button', { name: '保存并发布模板', exact: true }).click();
  await expect(studio.getByRole('status').filter({ hasText: '模板已发布' })).toBeVisible();
  const templates = (await (await request.get('/api/v1/workflow-templates')).json()).data;
  const saved = templates.find((t: { draft: { name: string } }) => t.draft.name === name);
  expect(saved.draft.steps.find((s: { key: string }) => s.key === 'review').dependsOn).toEqual([
    'generate',
  ]);
  const position = saved.draft.steps.find((s: { key: string }) => s.key === 'generate').position;
  expect(position).toBeTruthy();
  expect(position.y).toBeGreaterThan(80);
  await page.reload();
  await studio
    .locator('.workflow-template-columns > aside button')
    .filter({ hasText: name })
    .click();
  await expect(canvas.locator('.react-flow__node[data-id="review"]')).toContainText(
    '设定一致性检查',
  );
  const restored = await canvas
    .locator('.react-flow__node[data-id="generate"]')
    .evaluate((node) => {
      const matrix = new DOMMatrix(getComputedStyle(node).transform);
      return { x: matrix.m41, y: matrix.m42 };
    });
  expect(restored.x).toBeCloseTo(position.x, 2);
  expect(restored.y).toBeCloseTo(position.y, 2);
  await canvas.locator('.react-flow__controls-fitview').click();
  const overview = testInfo.outputPath('workflow-graph-overview.png');
  await page.screenshot({ path: overview, fullPage: true });
  await testInfo.attach('流程画布总览', { path: overview, contentType: 'image/png' });
  await canvas.locator('.react-flow__node[data-id="review"]').click();
  await expect(inspector.getByLabel('阶段名称', { exact: true })).toHaveValue('设定一致性检查');
  await expect(inspector.getByText('生成方案', { exact: true })).toBeVisible();
  await canvas.locator('.react-flow__controls-fitview').click();
  const screenshot = testInfo.outputPath('workflow-graph-editor.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('可视化编排画布', { path: screenshot, contentType: 'image/png' });
  expect(errors).toEqual([]);
});
