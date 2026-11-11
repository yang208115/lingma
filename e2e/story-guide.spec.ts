import { expect, test } from '@playwright/test';

test('guides a new story, preserves answers and shares adopted settings with advanced mode', async ({
  page,
  request,
}, testInfo) => {
  const project = (
    await (await request.post('/api/v1/projects', { data: { title: '故事引导测试作品' } })).json()
  ).data;
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: '故事引导模拟模型',
          modelId: 'fixture-guide',
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
  await page.goto(`/projects/${project.id}/information`);
  const panel = page.getByRole('region', { name: '基本信息管理', exact: true });
  await expect(panel.getByRole('button', { name: '引导模式', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const guide = page.getByRole('region', { name: '故事引导对话' });
  await expect(guide).toBeVisible();
  const answer = guide.getByRole('textbox');
  await answer.fill('一名钟表匠在海边小镇寻找失踪的姐姐');
  await panel.getByRole('button', { name: '高级模式', exact: true }).click();
  await expect(guide).not.toBeVisible();
  await expect(panel.getByRole('navigation', { name: '要素分类' })).toBeVisible();
  await panel.getByRole('button', { name: '引导模式', exact: true }).click();
  await expect(answer).toHaveValue('一名钟表匠在海边小镇寻找失踪的姐姐');
  await guide.getByRole('combobox', { name: '引导对话模型' }).selectOption(provider.id);
  await guide.getByRole('button', { name: '开始聊故事' }).click();
  await expect(
    guide.getByText('你希望故事偏甜蜜日常，还是带一点暗恋的酸涩？', { exact: true }),
  ).toBeVisible();
  const suggestion = guide.getByRole('region', { name: '设定建议：重置之城' });
  await expect(suggestion).toBeVisible();
  expect(
    (await (await request.get(`/api/v1/projects/${project.id}/elements`)).json()).data,
  ).toHaveLength(0);
  await page.reload();
  await expect(suggestion).toBeVisible();
  await suggestion.getByRole('button', { name: '采用这条设定' }).click();
  const archive = page.getByRole('complementary', { name: '故事档案' });
  await expect(archive.getByRole('button').filter({ hasText: '重置之城' })).toBeVisible();
  await archive.getByRole('button').filter({ hasText: '重置之城' }).click();
  await expect(panel.getByRole('button', { name: '高级模式', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await panel
    .getByRole('textbox', { name: '简述', exact: true })
    .fill('钟表匠在旧码头找到姐姐留下的线索。');
  await expect(panel.getByRole('button', { name: '引导模式', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(panel.getByRole('button', { name: '引导模式', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '引导模式', exact: true }).click();
  await expect(archive).toContainText('钟表匠在旧码头找到姐姐留下的线索。');
  await answer.fill('我更喜欢甜甜的日常');
  await guide.getByRole('button', { name: '继续聊', exact: true }).click();
  await expect(guide.getByRole('article', { name: '创作搭档回复' })).toHaveCount(2);
  await expect(guide.getByRole('button', { name: '采用这条设定' })).toBeVisible();
  const screenshot = testInfo.outputPath('story-guide-desktop.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('故事引导模式', { path: screenshot, contentType: 'image/png' });
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(answer).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('adopts mutually linked character suggestions together', async ({ page, request }) => {
  const project = (
    await (await request.post('/api/v1/projects', { data: { title: '关联人物测试' } })).json()
  ).data;
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: '关联人物模拟模型',
          modelId: 'fixture-guide-linked',
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
  await page.goto(`/projects/${project.id}/information`);
  const guide = page.getByRole('region', { name: '故事引导对话' });
  await guide.getByRole('combobox', { name: '引导对话模型' }).selectOption(provider.id);
  await guide.getByRole('textbox').fill('两位主角互相信任，一起寻找失落的城市。');
  await guide.getByRole('button', { name: '开始聊故事' }).click();
  const adoptAll = guide.getByRole('button', { name: '采用本轮全部建议', exact: true });
  await expect(adoptAll).toBeEnabled();
  await expect(
    guide
      .getByRole('region', { name: '设定建议：角色甲' })
      .getByRole('button', { name: '采用这条设定' }),
  ).toBeDisabled();
  await adoptAll.click();
  await expect(
    page.getByRole('complementary', { name: '故事档案' }).getByRole('button'),
  ).toHaveCount(2);
  const entries = (await (await request.get(`/api/v1/projects/${project.id}/elements`)).json())
    .data as {
    document: { id: string };
    data: { links: { targetId: string }[] };
    status: string;
  }[];
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.status).toBe('confirmed');
    expect(entry.data.links[0]?.targetId).toBe(
      entries.find((other) => other.document.id !== entry.document.id)?.document.id,
    );
  }
});

test('retries a failed message in place and preserves later turns and the unsent draft', async ({
  page,
  request,
}, testInfo) => {
  const project = (
    await (await request.post('/api/v1/projects', { data: { title: '单条重试测试' } })).json()
  ).data;
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: '重试模拟模型',
          modelId: 'fixture-guide-retry',
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
  await page.goto(`/projects/${project.id}/information`);
  const guide = page.getByRole('region', { name: '故事引导对话' });
  const answer = guide.getByRole('textbox');
  await guide.getByRole('combobox', { name: '引导对话模型' }).selectOption(provider.id);
  await answer.fill('之前的故事想法');
  await guide.getByRole('button', { name: '开始聊故事' }).click();
  await expect(guide.getByRole('region', { name: '设定建议：重置之城' })).toBeVisible();
  const original = `重试原始输入：补全两位主角的性格 ${crypto.randomUUID()}`;
  await answer.fill(original);
  await guide.getByRole('button', { name: '继续聊', exact: true }).click();
  const failedTurn = guide.locator('.story-guide-turn').filter({ hasText: original });
  await expect(failedTurn.getByRole('button', { name: '重试这条', exact: true })).toBeEnabled();
  const before = (
    await (await request.get(`/api/v1/projects/${project.id}/element-generations`)).json()
  ).data;
  const failedId = before.find(
    (job: { input: { idea: string } }) => job.input.idea === original,
  ).id;
  await answer.fill('之后的聊天内容');
  await guide.getByRole('button', { name: '继续聊', exact: true }).click();
  await expect(guide.getByRole('region', { name: '设定建议：重置之城' })).toHaveCount(2);
  await answer.fill('尚未发送的草稿');
  const screenshot = testInfo.outputPath('story-guide-retry.png');
  await failedTurn.screenshot({ path: screenshot });
  await testInfo.attach('单条失败重试', { path: screenshot, contentType: 'image/png' });
  await failedTurn.getByRole('button', { name: '重试这条', exact: true }).click();
  await expect(failedTurn.getByRole('region', { name: '设定建议：重置之城' })).toBeVisible();
  await expect(failedTurn.getByRole('button', { name: '重试这条', exact: true })).not.toBeVisible();
  await expect(guide.getByRole('article', { name: '创作搭档回复' })).toHaveCount(3);
  await expect(answer).toHaveValue('尚未发送的草稿');
  const after = (
    await (await request.get(`/api/v1/projects/${project.id}/element-generations`)).json()
  ).data;
  expect(after).toHaveLength(3);
  expect(after.find((job: { id: string }) => job.id === failedId).status).toBe('completed');
  expect(after.find((job: { id: string }) => job.id === failedId).callCount).toBe(4);
  await page.reload();
  await expect(guide.getByRole('article', { name: '创作搭档回复' })).toHaveCount(3);
  await expect(answer).toHaveValue('尚未发送的草稿');
});

test('updates premise, character and conflict together through the batch tool', async ({
  page,
  request,
}) => {
  const project = (
    await (
      await request.post('/api/v1/projects', {
        data: { title: '跨分类批量修改测试' },
      })
    ).json()
  ).data;
  const provider = (
    await (
      await request.post('/api/v1/provider-configs', {
        data: {
          name: '批量设定模型',
          modelId: 'fixture-guide-batch',
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
  await page.goto(`/projects/${project.id}/information`);
  const guide = page.getByRole('region', { name: '故事引导对话' });
  await guide.getByRole('combobox', { name: '引导对话模型' }).selectOption(provider.id);
  await guide.getByRole('textbox').fill('邮差在校园寻找真相，主题是信任。');
  await guide.getByRole('button', { name: '开始聊故事' }).click();
  await expect(guide.getByText(/本轮共 3 条修改/)).toContainText(
    '故事定位与主题、人物与关系、核心冲突',
  );
  const adoptAll = guide.getByRole('button', { name: '采用本轮全部建议', exact: true });
  await adoptAll.click();
  const entriesUrl = `/api/v1/projects/${project.id}/elements`;
  const before = (await (await request.get(entriesUrl)).json()).data as {
    document: { id: string; kind: string };
    version: { id: string; content: string };
    status: string;
  }[];
  expect(before).toHaveLength(3);
  await guide.getByRole('textbox').fill('两人要一起解决危机，最后圆满。');
  await guide.getByRole('button', { name: '继续聊', exact: true }).click();
  await expect(adoptAll).toBeEnabled();
  const pending = (await (await request.get(entriesUrl)).json()).data;
  expect(pending.map((entry: { version: { id: string } }) => entry.version.id).sort()).toEqual(
    before.map((entry) => entry.version.id).sort(),
  );
  await adoptAll.click();
  const after = (await (await request.get(entriesUrl)).json()).data as typeof before;
  expect(after).toHaveLength(3);
  for (const entry of after) {
    const original = before.find((item) => item.document.id === entry.document.id);
    expect(original).toBeDefined();
    expect(entry.version.id).not.toBe(original?.version.id);
    expect(entry.version.content).toBe('两人要一起解决危机，最后圆满。');
    expect(entry.status).toBe('confirmed');
  }
  const jobs = (
    await (await request.get(`/api/v1/projects/${project.id}/element-generations`)).json()
  ).data;
  expect(
    jobs.every(
      (job: { callCount: number; candidates: unknown[] }) =>
        job.callCount === 2 && job.candidates.length === 3,
    ),
  ).toBe(true);
  await page.reload();
  await expect(guide.getByRole('region', { name: '设定建议：记忆与真相' })).toHaveCount(2);
});
