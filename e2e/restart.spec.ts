import { expect, test } from '@playwright/test';

for (const view of ['projects', 'writing'] as const) {
  test(`${view} recovers after the backend becomes ready without a page reload`, async ({
    page,
    request,
  }) => {
    const project = (
      await (
        await request.post('/api/v1/projects', {
          data: { title: `重启恢复 ${crypto.randomUUID()}`, format: 'short' },
        })
      ).json()
    ).data;
    const structure = (await (await request.get(`/api/v1/projects/${project.id}/structure`)).json())
      .data;
    const document = structure.documents.find((item: { kind: string }) => item.kind === 'chapter');
    const url =
      view === 'projects' ? '/projects' : `/projects/${project.id}/writing?document=${document.id}`;
    let unavailable = true;
    let failedReads = 0;
    await page.route('**/api/v1/**', async (route) => {
      if (unavailable && route.request().method() === 'GET') {
        failedReads++;
        await route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' });
      } else await route.continue();
    });
    await page.goto(url);
    await expect.poll(() => failedReads).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole('alert')).toHaveCount(0);
    unavailable = false;
    await page.getByRole('button', { name: '当前作品', exact: true }).click();
    await expect(
      page.getByRole('option', { name: `${project.title} · 短篇`, exact: true }),
    ).toBeVisible();
    await page.getByRole('combobox', { name: '搜索作品' }).press('Escape');
    if (view === 'projects')
      await expect(page.getByRole('article', { name: project.title, exact: true })).toBeVisible();
    else await expect(page.getByLabel('文档正文', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page).toHaveURL(url);
  });
}
