import { expect, test } from '@playwright/test';

test('a chapter-free work generates one category, survives refresh and accepts its candidates', async ({
  page,
  request,
}, testInfo) => {
  const project = (
    await (
      await request.post('/api/v1/projects', { data: { title: `创作要素 ${crypto.randomUUID()}` } })
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
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: '要素模拟模型',
          modelId: 'fixture-elements',
          connection: {
            api: 'openai-completions',
            provider: 'fixture',
            baseUrl: 'http://127.0.0.1:4179/v1',
            credentialRef: null,
            contextWindow: 200000,
            maxOutputTokens: 16000,
          },
          parameters: {},
        },
      })
    ).json()
  ).data;
  await page.goto(`/?project=${project.id}`);
  await page.getByRole('link', { name: '基本信息', exact: true }).click();
  const panel = page.getByRole('region', { name: '基本信息管理', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByLabel('一句话灵感', { exact: true }).fill('失去记忆的邮差在重置之城寻找明天');
  await panel.getByRole('combobox', { name: '模型', exact: true }).selectOption(provider.id);
  await expect(panel.getByRole('button', { name: 'AI 一键生成', exact: true })).toHaveCount(0);
  await panel
    .getByRole('navigation', { name: '要素分类' })
    .getByRole('button', { name: /^2\. 世界观/ })
    .click();
  await panel.getByRole('button', { name: '生成世界观', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('生成完成', { timeout: 20000 });
  const tasks = (
    await (await request.get(`/api/v1/projects/${project.id}/element-generations`)).json()
  ).data;
  expect(tasks[0].candidates).toHaveLength(1);
  expect(
    (await (await request.get(`/api/v1/projects/${project.id}/elements`)).json()).data,
  ).toHaveLength(0);
  await page.reload();
  await page.getByRole('link', { name: '基本信息', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('生成完成');
  await panel
    .getByRole('navigation', { name: '要素分类' })
    .getByRole('button', { name: /^2\. 世界观/ })
    .click();
  await panel.getByRole('button', { name: '采用', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('全部采用');
  const entries = (await (await request.get(`/api/v1/projects/${project.id}/elements`)).json())
    .data;
  expect(entries).toHaveLength(1);
  expect(entries.every((e: { status: string }) => e.status === 'confirmed')).toBe(true);
  const world = entries.find(
    (e: { document: { kind: string } }) => e.document.kind === 'worldbuilding',
  );
  expect(world).toBeDefined();
  await panel
    .locator('.element-list')
    .getByRole('button', { name: /十分钟法则/ })
    .click();
  await expect(panel.getByLabel('规则与使用条件', { exact: true })).toHaveValue(/设定/);
  const screenshot = testInfo.outputPath('creation-elements.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Creation elements', { path: screenshot, contentType: 'image/png' });
  await page.getByRole('link', { name: '写作', exact: true }).click();
  await expect(panel).not.toBeVisible();
  expect(
    (
      await (await request.get(`/api/v1/projects/${project.id}/structure`)).json()
    ).data.documents.filter((d: { kind: string }) => d.kind === 'chapter'),
  ).toHaveLength(0);
});

test('authors create a world rule, lock fields, confirm, edit, restore and archive without JSON editing', async ({
  page,
  request,
}) => {
  const project = (
    await (
      await request.post('/api/v1/projects', { data: { title: `手动设定 ${crypto.randomUUID()}` } })
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
  await page.goto(`/?project=${project.id}`);
  await page.getByRole('link', { name: '基本信息', exact: true }).click();
  const panel = page.getByRole('region', { name: '基本信息管理', exact: true });
  await panel.getByRole('button', { name: '＋ 新建要素', exact: true }).click();
  await panel.getByLabel('名称', { exact: true }).fill('回溯法则');
  await panel.getByLabel('规则与使用条件', { exact: true }).fill('最多回溯十分钟');
  const field = panel
    .locator('.element-field')
    .filter({ has: page.getByRole('textbox', { name: '规则与使用条件', exact: true }) });
  await field.getByRole('button', { name: '锁定 AI 修改', exact: true }).click();
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(panel.getByRole('button', { name: '确认当前版本', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '确认当前版本', exact: true }).click();
  await expect(panel.locator('.element-detail')).toContainText('已确认 · 当前版本 1');
  await panel.getByLabel('补充说明（Markdown）', { exact: true }).fill('每次使用会失去一段记忆');
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(panel.locator('.element-detail')).toContainText('草稿 · 当前版本 2');
  await panel.getByRole('button', { name: '版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史与差异', exact: true });
  await history.getByRole('button', { name: '将起点版本恢复为新版本', exact: true }).click();
  await expect(panel.locator('.element-detail')).toContainText('草稿 · 当前版本 3');
  await panel.getByRole('button', { name: '归档', exact: true }).click();
  await expect(panel.getByRole('button', { name: '恢复归档', exact: true })).toBeVisible();
  const entries = (await (await request.get(`/api/v1/projects/${project.id}/elements`)).json())
    .data;
  expect(entries[0].data.locked).toContain('fields.rules');
  expect(entries[0].status).toBe('archived');
});
