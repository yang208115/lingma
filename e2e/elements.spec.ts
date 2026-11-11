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
          modelId: 'fixture-workflow',
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
  await panel.getByRole('button', { name: '高级模式', exact: true }).click();
  // The AI assistant runs the shared basic-information orchestration; acceptance happens on its card.
  await panel.getByRole('button', { name: 'AI 助手', exact: false }).first().click();
  const assistant = page.getByRole('complementary', { name: 'AI 要素生成' });
  await expect(assistant).toBeVisible();
  await assistant.getByRole('textbox').first().fill('失去记忆的邮差在重置之城寻找明天');
  await assistant.getByText('生成设置与参考资料', { exact: true }).click();
  await assistant.getByRole('combobox', { name: '模型' }).selectOption(provider.id);
  await assistant.getByRole('button', { name: /运行基础信息编排|编排完善/ }).click();
  const card = page.getByRole('article', { name: '编排运行', exact: true }).last();
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card.getByRole('button', { name: /采用全部剩余条目|采用并保存/ })).toBeVisible({
    timeout: 30000,
  });
  expect(
    (await (await request.get(`/api/v1/projects/${project.id}/elements`)).json()).data,
  ).toHaveLength(0);
  await page.reload();
  await page.getByRole('link', { name: '基本信息', exact: true }).click();
  await panel.getByRole('button', { name: 'AI 助手', exact: false }).first().click();
  const restored = page.getByRole('article', { name: '编排运行', exact: true }).last();
  await expect(restored.getByRole('button', { name: /采用全部剩余条目/ })).toBeVisible();
  await restored.getByRole('button', { name: /采用全部剩余条目/ }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/v1/projects/${project.id}/elements`)).json()).data.length,
    )
    .toBeGreaterThan(0);
  const entries = (await (await request.get(`/api/v1/projects/${project.id}/elements`)).json())
    .data;
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every((e: { status: string }) => e.status === 'confirmed')).toBe(true);
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
  await panel.getByRole('button', { name: '高级模式', exact: true }).click();
  await panel.getByText('添加设定', { exact: true }).click();
  await panel.getByRole('button', { name: '新增世界与场景', exact: true }).click();
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill('回溯法则');
  await panel.getByRole('textbox', { name: '规则与使用条件', exact: true }).fill('最多回溯十分钟');
  await panel.getByText('高级设置：标签、内容性质与 AI 修改保护').click();
  await panel
    .locator('.element-lock-fields')
    .getByRole('checkbox', { name: '规则与使用条件', exact: true })
    .check();
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(panel.getByRole('button', { name: '确认用于写作', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '确认用于写作', exact: true }).click();
  await expect(panel.locator('.element-detail')).toContainText('已确认 · 当前版本 1');
  await panel.getByLabel('补充说明（Markdown）', { exact: true }).fill('每次使用会失去一段记忆');
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(panel.locator('.element-detail')).toContainText('草稿 · 当前版本 2');
  await panel.getByText('更多操作', { exact: true }).click();
  await panel.getByRole('button', { name: '版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史与差异', exact: true });
  await history.getByRole('button', { name: '将起点版本恢复为新版本', exact: true }).click();
  await expect(panel.locator('.element-detail')).toContainText('草稿 · 当前版本 3');
  const archive = panel.getByRole('button', { name: '归档', exact: true });
  if (!(await archive.isVisible())) await panel.getByText('更多操作', { exact: true }).click();
  await archive.click();
  const entries = (await (await request.get(`/api/v1/projects/${project.id}/elements`)).json())
    .data;
  expect(entries[0].data.locked).toContain('fields.rules');
  expect(entries[0].status).toBe('archived');
});
