import { type APIRequestContext, expect, test } from '@playwright/test';

async function sourcePlan(request: APIRequestContext) {
  const project = (
    await (
      await request.post('/api/v1/projects', {
        data: { title: `自动拆章 ${crypto.randomUUID()}` },
      })
    ).json()
  ).data;
  const ready = (
    await (
      await request.post(`/api/v1/projects/${project.id}/setup-completion`, {
        data: { baseStructureVersion: project.structureVersion },
      })
    ).json()
  ).data;
  const plan = (
    await (
      await request.post(`/api/v1/projects/${project.id}/documents`, {
        data: {
          kind: 'chapter_outline',
          title: '第一卷 雨港',
          content: '初遇、试探、互相信任。',
          baseStructureVersion: ready.structureVersion,
        },
      })
    ).json()
  ).data;
  return { project, plan };
}

for (const count of [undefined, 2]) {
  test(`starts chapter planning in one click with ${count ?? 'AI-selected'} chapter count`, async ({
    page,
    request,
  }) => {
    const { project, plan } = await sourcePlan(request);
    const provider = (
      await (
        await request.post('/api/v1/provider-configs', {
          data: {
            name: '自动拆章模型',
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
    await page.getByRole('button', { name: '大纲助手', exact: true }).click();
    await page.getByLabel('写作模型', { exact: true }).selectOption(provider.id);
    await page
      .getByRole('region', { name: '分章计划', exact: true })
      .getByRole('button', { name: 'AI 拆分章纲', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('combobox', { name: '来源规划', exact: true })).toHaveValue(
      plan.document.id,
    );
    await expect(
      dialog.getByRole('spinbutton', { name: '指定章数', exact: true, includeHidden: true }),
    ).toBeHidden();
    if (count) {
      await dialog.getByText('高级设置（可选）', { exact: true }).click();
      await dialog
        .getByRole('spinbutton', { name: '指定章数', exact: true, includeHidden: true })
        .fill(String(count));
    }
    await dialog.getByRole('button', { name: '开始 AI 拆分', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const card = page.getByRole('article', { name: '编排运行', exact: true }).last();
    await expect(
      card.getByRole('button', { name: '采用并保存章纲拆分', exact: true }),
    ).toBeEnabled();
    const runs = (await (await request.get(`/api/v1/workflows?projectId=${project.id}`)).json())
      .data;
    expect(runs).toHaveLength(1);
    expect(runs[0].snapshot.input.chapterCount).toBe(count);
    expect(runs[0].snapshot.input.sourceOutlineId).toBe(plan.document.id);
    expect(runs[0].snapshot.input.providerConfigId).toBe(provider.id);
    expect(runs[0].result.items).toHaveLength(count ?? 3);
    const before = (await (await request.get(`/api/v1/projects/${project.id}/structure`)).json())
      .data;
    expect(
      before.documents.filter((doc: { kind: string }) => doc.kind === 'chapter_plan'),
    ).toHaveLength(0);
    expect(before.volumes).toHaveLength(0);
    await card.getByRole('button', { name: '采用并保存章纲拆分', exact: true }).click();
    await expect(card).toContainText(`已保存 ${count ?? 3} 份文档`);
    const after = (await (await request.get(`/api/v1/projects/${project.id}/structure`)).json())
      .data;
    const plans = after.documents.filter((doc: { kind: string }) => doc.kind === 'chapter_plan');
    expect(plans).toHaveLength(count ?? 3);
    expect(after.volumes).toHaveLength(1);
    expect(
      plans.every(
        (doc: { parentOutlineId: string; volumeId: string }) =>
          doc.parentOutlineId === plan.document.id && doc.volumeId === after.volumes[0].id,
      ),
    ).toBe(true);
  });
}

test('keeps the splitting request available when no model is configured', async ({
  page,
  request,
}) => {
  const { project, plan } = await sourcePlan(request);
  await page.route('**/api/v1/provider-configs', (route) => route.fulfill({ json: { data: [] } }));
  await page.goto(`/projects/${project.id}/outline?document=${plan.document.id}`);
  await page
    .getByRole('region', { name: '分章计划', exact: true })
    .getByRole('button', { name: 'AI 拆分章纲', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: '开始 AI 拆分', exact: true }).click();
  await expect(
    page.getByText('请先配置并选择模型，再点击发送开始拆分。拆分要求已保留。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: '写作任务', exact: true })).toHaveValue(
    /自动拆分为合理数量/,
  );
  expect(
    (await (await request.get(`/api/v1/workflows?projectId=${project.id}`)).json()).data,
  ).toHaveLength(0);
});
