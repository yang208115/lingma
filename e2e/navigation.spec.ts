import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

async function fixture(request: APIRequestContext, format: 'short' | 'long' = 'short') {
  let project = (
    await (
      await request.post('/api/v1/projects', {
        data: { title: `页面验证 ${crypto.randomUUID()}`, format },
      })
    ).json()
  ).data;
  if (format === 'long')
    project = (
      await (
        await request.post(`/api/v1/projects/${project.id}/setup-completion`, {
          data: { baseStructureVersion: project.structureVersion },
        })
      ).json()
    ).data;
  const structure = (await (await request.get(`/api/v1/projects/${project.id}/structure`)).json())
    .data;
  const existing = structure.documents.find((item: { kind: string }) => item.kind === 'chapter');
  const document =
    existing ??
    (
      await (
        await request.post(`/api/v1/projects/${project.id}/documents`, {
          data: {
            kind: 'chapter',
            title: '页面测试正文',
            content: '原始正文',
            baseStructureVersion: structure.project.structureVersion,
          },
        })
      ).json()
    ).data.document;
  return { project, document, url: `/projects/${project.id}/writing?document=${document.id}` };
}
const nav = (page: Page) => page.getByRole('navigation', { name: '页面导航' });

test('removes the standalone collaboration entry and redirects old project links to writing', async ({
  page,
  request,
}) => {
  const { project, document, url } = await fixture(request);
  await page.goto(`/projects/${project.id}/workflows?document=${document.id}`);
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel('文档正文', { exact: true })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '协作写作', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '协作写作工作台' })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Agent 角色库', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: '协作创作功能' }).getByRole('link'),
  ).toHaveCount(2);
  await expect(page.getByRole('link', { name: '协作写作', exact: true })).toHaveCount(0);
});

test('every major module has a refreshable address and legacy URLs preserve document selection', async ({
  page,
  request,
}, testInfo) => {
  const { project, document, url } = await fixture(request, 'long');
  await page.goto(`/?project=${project.id}&document=${document.id}`);
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel('文档正文', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('multi-page-writing.png'), fullPage: true });
  for (const [label, path] of [
    ['作品管理', '/projects'],
    ['通用 Skill', '/skills'],
    ['项目 Skill', `/projects/${project.id}/skills`],
    ['Agent 角色库', '/agents'],
    ['工作流模板', '/workflow-templates'],
    ['模型设置', '/settings/models'],
    ['Agent 提示词', '/settings/agent-prompt'],
    ['大纲', `/projects/${project.id}/outline`],
    ['基本信息', `/projects/${project.id}/information`],
  ] as const) {
    await nav(page).getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path?.replaceAll('/', '\\/')}(?:\\?|$)`));
    await expect(nav(page).getByRole('link', { name: label, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.reload();
    await expect(page).toHaveTitle(`${label} · 灵码`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (label === '作品管理')
      await page.screenshot({
        path: testInfo.outputPath('multi-page-projects.png'),
        fullPage: true,
      });
  }
  await page.goto(`/?project=${project.id}&view=outline`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/outline`));
});

test('navigation saves pending text, preserves the composer and supports back and forward', async ({
  page,
  request,
}) => {
  const { document, url } = await fixture(request);
  await page.goto(url);
  await page.getByLabel('文档正文', { exact: true }).fill('切页前刚输入的新稿');
  await page.getByLabel('写作任务').fill('还没发送的创作要求');
  await nav(page).getByRole('link', { name: '通用 Skill', exact: true }).click();
  await expect(page).toHaveURL('/skills');
  const saved = (await (await request.get(`/api/v1/documents/${document.id}`)).json()).data;
  expect(saved.version.content).toBe('切页前刚输入的新稿');
  await page.goBack();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('切页前刚输入的新稿');
  await expect(page.getByLabel('写作任务')).toHaveValue('还没发送的创作要求');
  await page.goForward();
  await expect(page).toHaveURL('/skills');
});

test('failed saves block page navigation and retain the text for retry', async ({
  page,
  request,
}) => {
  const { document, url } = await fixture(request);
  await page.goto(url);
  await page.route(`**/api/v1/documents/${document.id}`, async (route) => {
    if (route.request().method() === 'PUT') await route.abort();
    else await route.continue();
  });
  await page.getByLabel('文档正文', { exact: true }).fill('网络错误时保留此稿');
  await nav(page).getByRole('link', { name: '模型设置', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '页面尚未离开' })).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('网络错误时保留此稿');
  await page.unroute(`**/api/v1/documents/${document.id}`);
  await nav(page).getByRole('link', { name: '模型设置', exact: true }).click();
  await expect(page).toHaveURL('/settings/models');
});

test('manual configuration edits guard links and browser back with cancel and discard', async ({
  page,
}) => {
  await page.goto('/projects');
  await nav(page).getByRole('link', { name: '模型设置', exact: true }).click();
  await page.getByLabel('配置名称', { exact: true }).fill('尚未保存的模型');
  await page.goBack();
  const prompt = page.getByRole('dialog', { name: '尚未保存的修改' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '留在此页' }).click();
  await expect(page).toHaveURL('/settings/models');
  await expect(page.getByLabel('配置名称', { exact: true })).toHaveValue('尚未保存的模型');
  await nav(page).getByRole('link', { name: '通用 Skill', exact: true }).click();
  await prompt.getByRole('button', { name: '放弃修改并离开' }).click();
  await expect(page).toHaveURL('/skills');
});

test('short books, onboarding, missing resources and mismatched document IDs have explicit outcomes', async ({
  page,
  request,
}) => {
  const short = await fixture(request);
  const other = await fixture(request);
  await page.goto(`/projects/${short.project.id}/information`);
  await expect(page).toHaveURL(new RegExp(`/projects/${short.project.id}/writing`));
  await expect(page.getByText('短篇作品不提供基本信息页面，已进入写作。')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '基本信息', exact: true })).toHaveCount(0);
  await page.goto(`/projects/${short.project.id}/writing?document=${other.document.id}`);
  await expect(page.getByRole('alert')).toContainText('文档不存在或不属于当前作品');
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveCount(0);
  const fresh = (
    await (
      await request.post('/api/v1/projects', { data: { title: '首次引导', format: 'long' } })
    ).json()
  ).data;
  await page.goto(`/projects/${fresh.id}/writing`);
  await expect(page).toHaveURL(`/projects/${fresh.id}/information`);
  await page.goto(`/projects/${crypto.randomUUID()}/writing`);
  await expect(page.getByRole('link', { name: '返回作品管理' })).toBeVisible();
  await page.goto('/does-not-exist');
  await expect(page.getByRole('heading', { name: '未找到页面' })).toBeVisible();
  expect(
    (await request.get('/assets/missing.js', { headers: { Accept: 'text/html' } })).status(),
  ).toBe(404);
  expect((await request.get('/api/missing', { headers: { Accept: 'text/html' } })).status()).toBe(
    404,
  );
});

test('mobile navigation opens, traps focus, closes with Escape and does not overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/projects');
  const toggle = page.getByRole('button', { name: '☰ 导航' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await toggle.click();
  await nav(page).getByRole('link', { name: '模型设置', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('配置名称', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
