import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

async function imported(request: APIRequestContext, content: string) {
  const upload = await request.post('/api/v1/skills/import/local', {
    multipart: {
      files: { name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(content) },
      paths: JSON.stringify(['SKILL.md']),
    },
  });
  expect(upload.status()).toBe(202);
  const job = (await upload.json()).data;
  let completed = job;
  await expect
    .poll(async () => {
      completed = (await (await request.get(`/api/v1/skill-imports/${job.id}`)).json()).data;
      return completed.status;
    })
    .toBe('completed');
  return (await (await request.get(`/api/v1/skills/${completed.skillId}`)).json()).data as {
    skill: { id: string; name: string };
    version: { id: string; entryContent: string; versionNo: number };
  };
}
async function manager(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: '通用 Skill', exact: true }).click();
  await expect(page.getByRole('main', { name: '通用 Skill' })).toBeVisible();
}
async function openSkill(page: Page, name: string) {
  await manager(page);
  await page
    .getByRole('complementary', { name: 'Skill 列表' })
    .getByRole('button', { name: `${name} 本地副本` })
    .click();
  await expect(page.getByLabel('skillVersionId', { exact: true })).not.toHaveValue('');
}

test('imports a parent directory as separate Skills, ignoring unrelated files and continuing after a failed upload', async ({
  page,
  request,
}) => {
  const root = await mkdtemp(resolve(tmpdir(), 'lingma-skill-collection-'));
  const suffix = crypto.randomUUID();
  const names = [`批量写作 ${suffix}`, `批量审校 ${suffix}`];
  try {
    await writeFile(resolve(root, 'README.md'), 'collection notes');
    for (const [index, directory] of ['writing', 'review'].entries()) {
      await mkdir(resolve(root, directory, 'references'), { recursive: true });
      await writeFile(
        resolve(root, directory, 'SKILL.md'),
        `---\nname: ${names[index]}\n---\n[附件](references/0.txt)`,
      );
      // The collection exceeds 200 files, while each Skill stays below that limit.
      await Promise.all(
        Array.from({ length: 101 }, (_, file) =>
          writeFile(
            resolve(root, directory, 'references', `${file}.txt`),
            `${directory} attachment ${file}`,
          ),
        ),
      );
    }
    await mkdir(resolve(root, 'bad'));
    await writeFile(resolve(root, 'bad', 'SKILL.md'), '# oversized attachment');
    await writeFile(resolve(root, 'bad', 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await manager(page);
    await page.getByRole('button', { name: '导入 Skill', exact: true }).click();
    await page.getByLabel('上传完整目录', { exact: true }).setInputFiles(root);
    for (const name of names)
      await expect(
        page
          .getByRole('complementary', { name: 'Skill 列表' })
          .getByRole('button', { name: `${name} 本地副本`, exact: true }),
      ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('bad');
    await expect(page.getByRole('alert')).toContainText('单个文件不能超过 2 MiB');
    const list = (await (await request.get('/api/v1/skills?limit=200')).json()).data;
    for (const [index, name] of names.entries()) {
      const owner = list.find((skill: { name: string }) => skill.name === name);
      const detail = (await (await request.get(`/api/v1/skills/${owner.id}`)).json()).data;
      expect(detail.version.files).toHaveLength(102);
      expect(
        detail.version.files.every(
          (file: { relativePath: string }) =>
            file.relativePath === 'SKILL.md' || file.relativePath.startsWith('references/'),
        ),
      ).toBe(true);
      const attachment = await request.get(
        `/api/v1/skills/${owner.id}/versions/${detail.version.id}/file?path=references%2F0.txt`,
      );
      expect(await attachment.text()).toBe(`${index === 0 ? 'writing' : 'review'} attachment 0`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('directory import displays attachments and examples, edits immutable versions and compares history', async ({
  page,
  request,
}, testInfo) => {
  await manager(page);
  await page.getByRole('button', { name: '导入 Skill', exact: true }).click();
  await page
    .getByLabel('上传完整目录', { exact: true })
    .setInputFiles(resolve('fixtures/skills/continuity'));
  await page
    .getByRole('complementary', { name: 'Skill 列表' })
    .getByRole('button', { name: '雾港一致性审查 本地副本', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '雾港一致性审查', exact: true })).toBeVisible();
  const firstId = await page.getByLabel('skillVersionId', { exact: true }).inputValue();
  await page
    .getByRole('region', { name: 'Skill 示例', exact: true })
    .getByRole('button', { name: 'examples/continuity.md' })
    .click();
  await expect(page.getByRole('region', { name: '附件预览' })).toContainText('钥匙');
  await page.getByRole('button', { name: '编辑 SKILL.md', exact: true }).click();
  const editor = page.getByLabel('SKILL.md 源码', { exact: true });
  await editor.fill(`${await editor.inputValue()}\n\n新增审查规则：记录依据不足。`);
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存为版本 2');
  await expect(page.getByLabel('skillVersionId', { exact: true })).not.toHaveValue(firstId);
  await page.getByLabel('选择 Skill 对照版本').selectOption(firstId);
  await expect(page.getByRole('region', { name: 'Skill 版本对照' })).toContainText('新增审查规则');
  await page.getByLabel('查看 Skill 版本').selectOption(firstId);
  await expect(page.getByRole('button', { name: '编辑 SKILL.md', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Skill 正文预览' })).not.toContainText(
    '新增审查规则',
  );
  const list = (await (await request.get('/api/v1/skills?limit=200')).json()).data;
  const owner = list.find((item: { name: string; id: string }) => item.name === '雾港一致性审查');
  const original = (
    await (await request.get(`/api/v1/skills/${owner.id}/versions/${firstId}`)).json()
  ).data;
  expect(original.version.entryContent).not.toContain('新增审查规则');
  expect(original.version.metadata['sample-origin']).toBe('synthetic');
  const attachment = await request.get(
    `/api/v1/skills/${owner.id}/versions/${firstId}/file?path=references%2Fstyle.md`,
  );
  expect(attachment.ok()).toBe(true);
  expect(await attachment.text()).toContain('文风');
  await page.getByRole('heading', { name: '通用 Skill', exact: true }).scrollIntoViewIfNeeded();
  const screenshot = testInfo.outputPath('skill-manager.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Skill workspace', { path: screenshot, contentType: 'image/png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('main', { name: '通用 Skill' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('single-entry malicious Markdown stays inert and missing files are explicit', async ({
  page,
  request,
}) => {
  const name = `安全预览 ${crypto.randomUUID()}`;
  await imported(
    request,
    `---\nname: ${name}\ncustom-key: retained\n---\n# 检查\n<script>window.skillExecuted = true</script>\n<img src=x onerror="window.skillExecuted=true">\n\n![remote](https://example.invalid/tracking.png)\n[危险](javascript:alert(1))\n[缺少文风](references/missing.md)`,
  );
  const external: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('example.invalid')) external.push(req.url());
  });
  await openSkill(page, name);
  await expect(page.getByText('缺失文件：references/missing.md', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Skill 正文预览' }).locator('script,img,iframe'),
  ).toHaveCount(0);
  expect(await page.evaluate(() => 'skillExecuted' in window)).toBe(false);
  expect(external).toEqual([]);
  await page
    .getByRole('region', { name: 'Skill 正文预览' })
    .getByRole('button', { name: '缺少文风' })
    .click();
  await expect(page.getByRole('alert')).toContainText('关联文件缺失');
  await expect(page.getByRole('region', { name: 'Skill 示例', exact: true })).toContainText(
    '没有 examples',
  );
});

test('stale Skill saves retain the edit and require explicit merging with the latest base', async ({
  page,
  request,
}) => {
  const name = `冲突 ${crypto.randomUUID()}`;
  const original = await imported(request, `---\nname: ${name}\n---\n# 原始规则`);
  await openSkill(page, name);
  await page.getByRole('button', { name: '编辑 SKILL.md', exact: true }).click();
  const local = `---\nname: ${name}\n---\n# 我的编辑`;
  await page.getByLabel('SKILL.md 源码', { exact: true }).fill(local);
  expect(
    (
      await request.put(`/api/v1/skills/${original.skill.id}`, {
        data: {
          baseVersionId: original.version.id,
          entryContent: `---\nname: ${name}\n---\n# 服务端新规则`,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Skill 版本冲突' })).toContainText('服务端新规则');
  await expect(page.getByLabel('SKILL.md 源码', { exact: true })).toHaveValue(local);
  await page.getByRole('button', { name: '保留编辑并采用最新基准' }).click();
  await page.getByLabel('SKILL.md 源码', { exact: true }).fill(`${local}\n合并服务端规则`);
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存为版本 3');
  const latest = (await (await request.get(`/api/v1/skills/${original.skill.id}`)).json()).data;
  expect(latest.version.entryContent).toContain('合并服务端规则');
  expect(
    (
      await (
        await request.get(`/api/v1/skills/${original.skill.id}/versions/${original.version.id}`)
      ).json()
    ).data.version.entryContent,
  ).toContain('原始规则');
});

test('failed Skill save preserves text for retry', async ({ page, request }) => {
  const name = `重试 ${crypto.randomUUID()}`;
  const original = await imported(request, `---\nname: ${name}\n---\n# 原稿`);
  await openSkill(page, name);
  await page.getByRole('button', { name: '编辑 SKILL.md', exact: true }).click();
  await page.route(`**/api/v1/skills/${original.skill.id}`, async (route) => {
    if (route.request().method() === 'PUT') await route.abort('failed');
    else await route.continue();
  });
  await page.getByLabel('SKILL.md 源码', { exact: true }).fill(`# 重试新稿 ${name}`);
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('连接失败');
  await expect(page.getByLabel('SKILL.md 源码', { exact: true })).toHaveValue(`# 重试新稿 ${name}`);
  await page.unroute(`**/api/v1/skills/${original.skill.id}`);
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存为版本 2');
  await page.getByRole('button', { name: '关闭 Skill 管理' }).click();
  await expect(page.getByRole('main', { name: '通用 Skill' })).toHaveCount(0);
});

test('Git import reports a blocked private source and its task remains visible after reload', async ({
  page,
}) => {
  await manager(page);
  await page.getByRole('button', { name: '导入 Skill', exact: true }).click();
  await page.getByLabel('公开 HTTPS 仓库').fill('https://127.0.0.1/skills.git');
  await page.getByRole('button', { name: '从 Git 导入', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Skill 导入记录' })).toContainText(
    'Git 来源必须解析到公网地址',
  );
  await page.reload();
  await page.getByRole('link', { name: '通用 Skill', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Skill 导入记录' })).toContainText(
    'Git 来源必须解析到公网地址',
  );
});

test('general and project Skill pages import separately, switch projects and preserve moved history', async ({
  page,
  request,
}, testInfo) => {
  const createProject = async (title: string) =>
    (await (await request.post('/api/v1/projects', { data: { title, format: 'short' } })).json())
      .data;
  const first = await createProject(`Skill 项目一 ${crypto.randomUUID()}`);
  const second = await createProject(`Skill 项目二 ${crypto.randomUUID()}`);
  const name = `项目专属规则 ${crypto.randomUUID()}`;
  const generalName = `通用规则 ${crypto.randomUUID()}`;
  await imported(request, `# ${generalName}`);
  await page.goto(`/projects/${first.id}/skills`);
  await expect(page.getByRole('main', { name: '项目 Skill' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目 Skill', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '导入 Skill', exact: true }).click();
  await page.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: 'SKILL.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# ${name}`),
  });
  const list = page.getByRole('complementary', { name: 'Skill 列表' });
  await list.getByRole('button', { name: `${name} 本地副本`, exact: true }).click();
  await expect(page.getByLabel('Skill 归属', { exact: true })).toHaveValue(first.id);
  const versionId = await page.getByLabel('skillVersionId', { exact: true }).inputValue();
  await expect(
    list.getByRole('button', { name: `${generalName} 本地副本`, exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(list.getByRole('button', { name: `${name} 本地副本`, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('project-skills.png'), fullPage: true });
  await page.getByRole('button', { name: '当前作品', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索作品' }).fill(second.title);
  await page.getByRole('option', { name: `${second.title} · 短篇`, exact: true }).click();
  await expect(page).toHaveURL(`/projects/${second.id}/skills`);
  await expect(list.getByRole('button', { name: `${name} 本地副本`, exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '通用 Skill', exact: true }).click();
  await expect(
    list.getByRole('button', { name: `${generalName} 本地副本`, exact: true }),
  ).toBeVisible();
  await expect(list.getByRole('button', { name: `${name} 本地副本`, exact: true })).toHaveCount(0);
  await page.goto(`/projects/${first.id}/skills`);
  await list.getByRole('button', { name: `${name} 本地副本`, exact: true }).click();
  await page.getByLabel('Skill 归属', { exact: true }).selectOption('');
  await expect(page.getByRole('status')).toContainText('已修改 Skill 归属');
  await expect(list.getByRole('button', { name: `${name} 本地副本`, exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '通用 Skill', exact: true }).click();
  await list.getByRole('button', { name: `${name} 本地副本`, exact: true }).click();
  await expect(page.getByLabel('skillVersionId', { exact: true })).toHaveValue(versionId);
  await expect(page.getByLabel('Skill 归属', { exact: true })).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
