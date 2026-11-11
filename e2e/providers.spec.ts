import { expect, test } from '@playwright/test';

test('model settings confirm deletion, preserve other configurations and reset unsaved edits', async ({
  page,
  request,
}) => {
  const create = async (name: string) => {
    const response = await request.post('/api/v1/provider-configs', {
      data: {
        name,
        modelId: 'fixture-check',
        connection: {
          api: 'openai-completions',
          provider: 'fixture',
          baseUrl: 'http://127.0.0.1:4179/v1',
          credentialRef: null,
          contextWindow: 16000,
          maxOutputTokens: 1024,
        },
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).data;
  };
  const removed = await create('待删除的模型');
  const kept = await create('保留的模型');
  await page.goto('/settings/models');
  const settings = page.getByRole('main', { name: '模型设置', exact: true });
  const select = settings.getByRole('combobox', { name: '已有配置', exact: true });
  const remove = settings.getByRole('button', { name: '删除配置', exact: true });
  await expect(remove).toBeDisabled();
  await select.selectOption(removed.id);
  await settings.getByLabel('模型 ID', { exact: true }).fill('尚未保存的编辑');
  await settings.getByLabel('API 密钥', { exact: true }).fill('unsaved-test-key');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('待删除的模型');
    await dialog.dismiss();
  });
  await remove.click();
  await expect(select).toHaveValue(removed.id);
  expect((await request.get(`/api/v1/provider-configs/${removed.id}`)).ok()).toBe(true);

  // Another editor's save must prevent deleting the stale revision.
  const update = await request.put(`/api/v1/provider-configs/${removed.id}`, {
    data: { config: removed.config, revision: removed.revision },
  });
  expect(update.ok()).toBe(true);
  page.once('dialog', (dialog) => dialog.accept());
  await remove.click();
  await expect(settings.getByRole('alert')).toHaveText('模型配置已变化，请刷新后再删除');
  await expect(select).toHaveValue(removed.id);
  await expect(settings.getByLabel('模型 ID', { exact: true })).toHaveValue('尚未保存的编辑');
  // Reload discards the edits and loads the current revision.
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await select.selectOption(removed.id);
  await settings.getByLabel('API 密钥', { exact: true }).fill('unsaved-test-key');
  page.once('dialog', (dialog) => dialog.accept());
  await remove.click();
  await expect(settings.getByRole('status')).toHaveText('模型配置已删除');
  await expect(select).toHaveValue('');
  await expect(settings.getByLabel('配置名称', { exact: true })).toHaveValue('默认模型');
  await expect(settings.getByLabel('模型 ID', { exact: true })).toHaveValue('');
  await expect(settings.getByLabel('API 密钥', { exact: true })).toHaveValue('');
  await expect(remove).toBeDisabled();
  await expect(select.locator(`option[value="${removed.id}"]`)).toHaveCount(0);
  await expect(select.locator(`option[value="${kept.id}"]`)).toHaveCount(1);
  expect((await request.get(`/api/v1/provider-configs/${removed.id}`)).status()).toBe(404);
  await page.reload();
  await expect(select.locator(`option[value="${removed.id}"]`)).toHaveCount(0);
  await select.selectOption(kept.id);
  await expect(settings.getByLabel('配置名称', { exact: true })).toHaveValue('保留的模型');
});
