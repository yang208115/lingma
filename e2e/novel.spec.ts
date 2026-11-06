import { readFile } from 'node:fs/promises';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

async function project(request: APIRequestContext) {
  const response = await request.post('/api/v1/projects', {
    data: { title: `雾港 ${crypto.randomUUID().slice(0, 8)}` },
  });
  expect(response.ok()).toBe(true);
  const created = (await response.json()).data;
  const ready = await request.post(`/api/v1/projects/${created.id}/setup-completion`, {
    data: { baseStructureVersion: created.structureVersion },
  });
  expect(ready.ok()).toBe(true);
  return (await ready.json()).data as { id: string; title: string };
}
async function chapter(
  request: APIRequestContext,
  project: string,
  title: string,
  content = '原始正文',
) {
  const structure = (await (await request.get(`/api/v1/projects/${project}/structure`)).json())
    .data;
  const response = await request.post(`/api/v1/projects/${project}/documents`, {
    data: {
      title,
      kind: 'chapter',
      content,
      baseStructureVersion: structure.project.structureVersion,
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).data as { document: { id: string }; version: { id: string } };
}
async function open(page: Page, project: string, document: string) {
  await page.goto(`/?project=${project}&document=${document}`);
  await expect(page.getByLabel('文档正文', { exact: true })).toBeVisible();
}
async function content(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/v1/documents/${id}`)).json()).data.version
    .content as string;
}
test('export waits for pending text before starting the TXT download', async ({
  page,
  request,
}) => {
  const book = await project(request);
  const doc = await chapter(request, book.id, '导出章节');
  await open(page, book.id, doc.document.id);
  await page.getByLabel('文档正文', { exact: true }).fill('尚未触发自动保存的新稿');
  const downloadEvent = page.waitForEvent('download');
  await openMenu(page, '导出整部作品 TXT');
  const download = await downloadEvent;
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(await readFile(path ?? '', 'utf8')).toContain('尚未触发自动保存的新稿');
  expect(await content(request, doc.document.id)).toBe('尚未触发自动保存的新稿');
});
test('a pending draft in another chapter is recovered on reload and blocks export until resolved', async ({
  page,
  request,
}) => {
  const book = await project(request);
  const first = await chapter(request, book.id, '待保存的第一章');
  const second = await chapter(request, book.id, '已保存的第二章');
  await open(page, book.id, first.document.id);
  await page.route(`**/api/v1/documents/${first.document.id}`, async (route) => {
    if (route.request().method() === 'PUT') await route.abort('failed');
    else await route.continue();
  });
  await page.getByLabel('文档正文', { exact: true }).fill('第一章未保存稿');
  await page.getByRole('button', { name: '立即保存' }).click();
  await expect(page.getByRole('main', { name: '正文编辑区' }).getByRole('status')).toHaveText(
    '保存失败',
  );
  await pickChapter(page, '已保存的第二章');
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await page.reload();
  await page.getByText('待处理草稿', { exact: true }).click();
  await expect(page.getByRole('button', { name: /待处理：待保存的第一章/ })).toBeVisible();
  await openMenu(page, '导出整部作品 TXT');
  await expect(page.getByRole('alert')).toContainText('导出前请先处理');
  await page.getByRole('button', { name: /待处理：待保存的第一章/ }).click();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('第一章未保存稿');
  await page.unroute(`**/api/v1/documents/${first.document.id}`);
  await page.getByRole('button', { name: '重试保存' }).click();
  await expect(page.getByRole('main', { name: '正文编辑区' }).getByRole('status')).toHaveText(
    '已保存',
  );
  expect(await content(request, second.document.id)).toBe('原始正文');
});
async function openMenu(page: Page, item: string) {
  await page.getByLabel('文档操作', { exact: true }).click();
  await page.getByRole('button', { name: item, exact: true }).click();
}
async function pickChapter(page: Page, title: string) {
  await page.getByLabel('切换章节', { exact: true }).selectOption({ label: title });
}
async function save(page: Page, value: string) {
  await page.getByLabel('文档正文', { exact: true }).fill(value);
  await page.getByRole('button', { name: '立即保存', exact: true }).click();
  await expect(page.getByRole('main', { name: '正文编辑区' }).getByRole('status')).toHaveText(
    '已保存',
  );
}

test('serial autosave preserves typing during a request, chapter switching and reopening', async ({
  page,
  request,
}) => {
  const book = await project(request);
  const first = await chapter(request, book.id, '第一章');
  const second = await chapter(request, book.id, '第二章');
  await open(page, book.id, first.document.id);
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route(`**/api/v1/documents/${first.document.id}`, async (route) => {
    if (route.request().method() === 'PUT' && !intercepted) {
      intercepted = true;
      await blocked;
    }
    await route.continue();
  });
  await page.getByLabel('文档正文', { exact: true }).fill('第一次输入');
  await page.getByRole('button', { name: '立即保存', exact: true }).click();
  await expect.poll(() => intercepted).toBe(true);
  await page.getByLabel('文档正文', { exact: true }).fill('保存中继续输入的完整新稿');
  await pickChapter(page, '第二章');
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('原始正文');
  release();
  await expect.poll(() => content(request, first.document.id)).toBe('保存中继续输入的完整新稿');
  await pickChapter(page, '第一章');
  await expect(page.getByRole('main', { name: '正文编辑区' }).getByRole('status')).toHaveText(
    '已保存',
  );
  await page.reload();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue(
    '保存中继续输入的完整新稿',
  );
  expect(await content(request, second.document.id)).toBe('原始正文');
});

test('two tabs keep a conflicting draft and explicitly merge using the latest version', async ({
  page,
  context,
  request,
}) => {
  const book = await project(request);
  const doc = await chapter(request, book.id, '冲突章节');
  const other = await context.newPage();
  await open(page, book.id, doc.document.id);
  await open(other, book.id, doc.document.id);
  await save(page, '标签页一的新稿');
  await other.getByLabel('文档正文', { exact: true }).fill('标签页二的草稿');
  await other.getByRole('button', { name: '立即保存' }).click();
  await expect(other.getByRole('heading', { name: '比较并处理版本冲突' })).toBeVisible();
  await expect(other.getByLabel('文档正文', { exact: true })).toHaveValue('标签页二的草稿');
  await expect(other.getByLabel('文本差异').first()).toContainText('标签页一的新稿');
  await other.getByLabel('文档正文', { exact: true }).fill('人工合并后的新稿');
  await other.getByRole('button', { name: '以当前合并草稿保存' }).click();
  await expect(other.getByRole('main', { name: '正文编辑区' }).getByRole('status')).toHaveText(
    '已保存',
  );
  expect(await content(request, doc.document.id)).toBe('人工合并后的新稿');
  await other.close();
});

test('a failed save is recoverable after reload and can be retried without losing text', async ({
  page,
  request,
}) => {
  const book = await project(request);
  const doc = await chapter(request, book.id, '失败重试');
  await open(page, book.id, doc.document.id);
  await page.route(`**/api/v1/documents/${doc.document.id}`, async (route) => {
    if (route.request().method() === 'PUT') await route.abort('failed');
    else await route.continue();
  });
  await page.getByLabel('文档正文', { exact: true }).fill('需要找回的未保存稿');
  await page.getByRole('button', { name: '立即保存' }).click();
  await expect(page.getByRole('main', { name: '正文编辑区' }).getByRole('status')).toHaveText(
    '保存失败',
  );
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await page.reload();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('需要找回的未保存稿');
  await expect(page.getByRole('main', { name: '正文编辑区' }).getByRole('status')).toHaveText(
    '保存失败',
  );
  await page.unroute(`**/api/v1/documents/${doc.document.id}`);
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByRole('main', { name: '正文编辑区' }).getByRole('status')).toHaveText(
    '已保存',
  );
  expect(await content(request, doc.document.id)).toBe('需要找回的未保存稿');
});

test('history compares changes and restores into a new version with the prior content retained', async ({
  page,
  request,
}) => {
  const book = await project(request);
  const doc = await chapter(request, book.id, '历史章节', '历史原稿');
  await open(page, book.id, doc.document.id);
  await save(page, '修订后的正文');
  await page.getByRole('button', { name: '版本历史' }).click();
  const history = page.getByRole('dialog', { name: '版本历史与差异' });
  await history.getByLabel('比较起点').selectOption(doc.version.id);
  await expect(history.getByLabel('文本差异').first()).toContainText('修订后的正文');
  await history.getByRole('button', { name: '将起点版本恢复为新版本' }).click();
  await expect(history).not.toBeVisible();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('历史原稿');
  const versions = (
    await (await request.get(`/api/v1/documents/${doc.document.id}/versions`)).json()
  ).data as { id: string; source: string }[];
  expect(versions).toHaveLength(3);
  expect(versions[0]?.source).toBe('restore');
  const saved = await request.get(
    `/api/v1/documents/${doc.document.id}/versions/${versions[1]?.id}`,
  );
  expect((await saved.json()).data.content).toBe('修订后的正文');
});

test('UI creates materials, versions metadata, organizes a volume and exports only chapter text', async ({
  page,
  request,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建作品', exact: true }).click();
  await page.getByLabel('作品名称').fill('界面验收作品');
  await page.getByRole('button', { name: '创建作品', exact: true }).click();
  await page.getByRole('button', { name: '规划大纲', exact: true }).click();
  await page
    .getByRole('navigation', { name: '页面导航' })
    .getByRole('link', { name: '写作', exact: true })
    .click();
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  await page.getByLabel('文档名称').fill('第一章 界面验收');
  await page.getByRole('button', { name: '创建文档', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新建文档', exact: true })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '第一章 界面验收', exact: true })).toBeVisible();
  await save(page, '林舟用左手拨开窗栓。');
  // Materials are authored on the basic-information page now; seed one to prove export excludes it.
  const id = new URL(page.url()).pathname.split('/')[2] as string;
  const structure = (await (await request.get(`/api/v1/projects/${id}/structure`)).json()).data;
  await request.post(`/api/v1/projects/${id}/documents`, {
    data: {
      kind: 'character',
      title: '人物 林舟',
      content: '惯用左手，铜铃交给苏禾。',
      baseStructureVersion: structure.project.structureVersion,
    },
  });
  await page.reload();
  await openMenu(page, '卷章管理');
  await page.getByRole('button', { name: '添加卷' }).click();
  await page.getByLabel('卷标题', { exact: true }).fill('第一卷 雾港');
  const volume = await page
    .getByLabel('第一章 界面验收 所属卷')
    .locator('option')
    .last()
    .getAttribute('value');
  expect(volume).toBeTruthy();
  await page.getByLabel('第一章 界面验收 所属卷').selectOption(volume ?? '');
  await page.getByRole('button', { name: '保存修改' }).click();
  await pickChapter(page, '第一章 界面验收');
  const text = await (await request.get(`/api/v1/projects/${id}/export.txt`)).text();
  expect(text).toContain('第一卷 雾港');
  expect(text).toContain('林舟用左手');
  expect(text).not.toContain('惯用左手，铜铃交给苏禾');
  await page.screenshot({ path: info.outputPath('workspace.png'), fullPage: true });
});

test('import previews keep empty and duplicate chapters and allow manual correction before confirming', async ({
  page,
  request,
}) => {
  const book = await project(request);
  await page.goto(`/?project=${book.id}`);
  await page.getByRole('button', { name: '导入存稿', exact: true }).click();
  await page.getByLabel('存稿文件').setInputFiles({
    name: '合成样本.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('第一章 重复\n\n第一章 重复\n旧正文', 'utf8'),
  });
  await page.getByRole('button', { name: '生成拆章预览' }).click();
  const dialog = page.getByRole('dialog', { name: '导入 Markdown / TXT' });
  await expect(dialog.getByText(/空章，已保留/)).toBeVisible();
  await expect(dialog.getByLabel('章节标题')).toHaveCount(2);
  await dialog.getByLabel('章节标题').first().fill('第一章 人工修正');
  await dialog.getByLabel('章节内容').first().fill('人工补齐空章');
  await dialog.getByRole('button', { name: '确认导入 2 章' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('人工补齐空章');
  const exported = await (await request.get(`/api/v1/projects/${book.id}/export.txt`)).text();
  expect(exported.indexOf('人工补齐空章')).toBeLessThan(exported.indexOf('旧正文'));
});
