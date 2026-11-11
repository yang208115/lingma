import { expect, test } from '@playwright/test';

test('reads a plan, prepares prose without creating a chapter, and links the accepted draft', async ({
  page,
  request,
}, info) => {
  const project = (
    await (
      await request.post('/api/v1/projects', {
        data: { title: `规划阅读 ${crypto.randomUUID()}`, format: 'short' },
      })
    ).json()
  ).data;
  const structure = (await (await request.get(`/api/v1/projects/${project.id}/structure`)).json())
    .data;
  const event = (
    await (
      await request.post(`/api/v1/projects/${project.id}/documents`, {
        data: {
          baseStructureVersion: structure.project.structureVersion,
          kind: 'chapter_outline',
          title: '第三卷：雪夜站台',
          storyTime: '寒假前',
          summary: '在雪夜重逢。',
          content: '**雪夜站台：** 两人计划在站台相遇。',
        },
      })
    ).json()
  ).data;
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: '本地规划验证',
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
  const url = `/projects/${project.id}/outline?document=${event.document.id}`;
  await page.goto(url);
  const reader = page.getByRole('region', { name: '当前故事规划' });
  await expect(
    reader.getByRole('heading', { name: event.document.title, exact: true }),
  ).toBeVisible();
  await expect(reader.getByRole('heading', { name: '内容摘要' })).toBeVisible();
  await expect(reader.getByRole('heading', { name: '关联正文 · 0 章' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '新标签页' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'AI 聊天侧栏', exact: true })).toBeHidden();
  await page.getByRole('button', { name: '编辑规划', exact: true }).click();
  await page.getByLabel('文档正文', { exact: true }).fill('**雪夜站台：** 两人计划在初雪时重逢。');
  await page.getByRole('button', { name: '立即保存', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
  await page.getByRole('button', { name: '返回规划预览', exact: true }).click();
  await expect(reader).toContainText('两人计划在初雪时重逢');
  await page.screenshot({ path: info.outputPath('outline-reader.png'), fullPage: true });
  await page.getByRole('button', { name: '按此规划起草正文', exact: true }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/writing?sourcePlan=${event.document.id}`);
  await expect(page.getByRole('button', { name: '执行方式', exact: true })).toContainText(
    '单章协作写作',
  );
  await expect(page.getByRole('textbox', { name: '写作任务', exact: true })).toHaveValue(
    /第三卷：雪夜站台/,
  );
  expect(
    (
      await (await request.get(`/api/v1/projects/${project.id}/structure`)).json()
    ).data.documents.filter((item: { kind: string }) => item.kind === 'chapter'),
  ).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('button', { name: '执行方式', exact: true })).toContainText(
    '单章协作写作',
  );
  await page.getByLabel('写作模型', { exact: true }).selectOption(provider.id);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '预览当前正文', exact: true }).click();
  await expect(page.getByRole('region', { name: '正文预览', exact: true })).toContainText(
    '林舟用左手拨开窗栓',
  );
  await page.getByRole('button', { name: '关闭正文预览', exact: true }).click();
  await expect(page.getByRole('region', { name: '按规划起草正文', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '采用并保存正文写作', exact: true }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue(
    '林舟用左手拨开窗栓。雨声里，来客的说辞露出了破绽。',
  );
  await page.goto(url);
  await expect(reader.getByRole('heading', { name: '关联正文 · 1 章' })).toBeVisible();
  await expect(reader.getByRole('button', { name: '雨夜来客', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(reader.getByRole('button', { name: '按此规划起草正文', exact: true })).toBeVisible();
});

test('keeps the outline assistant reachable in saved and generated previews without covering the content', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const project = (
    await (
      await request.post('/api/v1/projects', {
        data: { title: '总纲助手布局回归' },
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
  const plan = (
    await (
      await request.post(`/api/v1/projects/${project.id}/documents`, {
        data: {
          kind: 'master_outline',
          title: '海边故事总纲',
          content: Array.from(
            { length: 35 },
            (_, index) =>
              `## 第 ${index + 1} 个转折\n\n两人在校园相识，在日常相处中逐渐建立信任，共同面对新的挑战。`,
          ).join('\n\n'),
          baseStructureVersion: project.structureVersion,
        },
      })
    ).json()
  ).data;
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: '总纲布局验证模型',
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
  await page.goto(`/projects/${project.id}/outline?document=${plan.document.id}`);
  const main = page.getByRole('main', { name: '大纲编辑区', exact: true });
  const aside = page.getByRole('complementary', { name: 'AI 聊天侧栏', exact: true });
  const toggle = main.getByRole('button', { name: '大纲助手', exact: true });
  const close = aside.getByRole('button', { name: '收起大纲助手', exact: true });
  const initialWidth = await main.evaluate((element) => element.getBoundingClientRect().width);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const task = aside.getByRole('textbox', { name: '写作任务', exact: true });
  await task.fill('保留尚未发送的要求');
  for (const width of [1440, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => {
      const reader = document.querySelector('.outline-reader-layout > .writing-area');
      const assistant = document.querySelector('#workspace-ai-assistant');
      if (!reader || !assistant) throw new Error('missing panels');
      return {
        right: reader.getBoundingClientRect().right,
        left: assistant.getBoundingClientRect().left,
        overflowing: reader.scrollWidth > reader.clientWidth,
      };
    });
    expect(geometry.right).toBeLessThanOrEqual(geometry.left + 1);
    expect(geometry.overflowing).toBe(false);
    expect(await main.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(
      initialWidth,
    );
    await main.evaluate((element) => {
      element.scrollTop = 900;
    });
    await close.click();
    await expect(toggle).toBeInViewport();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await toggle.click();
    await expect(aside).toBeVisible();
    await expect(task).toHaveValue('保留尚未发送的要求');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: info.outputPath('outline-assistant-docked.png') });
  await aside.getByLabel('写作模型', { exact: true }).selectOption(provider.id);
  await aside.getByRole('button', { name: '执行方式', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '故事总纲规划 v1', exact: true }).click();
  await task.fill('根据现有总纲生成完整故事总纲。');
  await aside.getByRole('button', { name: '发送', exact: true }).click();
  const card = aside.getByRole('article', { name: '编排运行', exact: true }).last();
  await card.getByRole('button', { name: '采用并保存故事总纲', exact: true }).click();
  await card.getByRole('button', { name: '查看生成稿', exact: true }).click();
  await expect(main.getByRole('region', { name: '生成内容预览', exact: true })).toBeVisible();
  await close.click();
  await expect(toggle).toBeInViewport();
  await toggle.click();
  await expect(aside).toBeVisible();
  await expect(main.getByRole('region', { name: '生成内容预览', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    bottom: document
      .querySelector('.outline-reader-layout > .writing-area')
      ?.getBoundingClientRect().bottom,
    top: document.querySelector('#workspace-ai-assistant')?.getBoundingClientRect().top,
    overflowing: document.documentElement.scrollWidth > innerWidth,
  }));
  expect(mobile.top).toBeGreaterThanOrEqual(mobile.bottom ?? 0);
  expect(mobile.overflowing).toBe(false);
  await close.click();
  await toggle.click();
  await expect(close).toBeInViewport();
});
