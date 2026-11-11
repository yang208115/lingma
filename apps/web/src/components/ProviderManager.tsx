import { type ProviderConfig, type ProviderInput, providerInputSchema } from '@lingma/shared';
import { useCallback, useEffect, useState } from 'react';
import { useLeaveGuard } from '../runtime.js';
import { writingApi } from '../writing-api.js';

const blank: ProviderInput = {
  name: '默认模型',
  modelId: '',
  connection: {
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    credentialRef: null,
    contextWindow: 16000,
    maxOutputTokens: 1024,
    reasoning: false,
    pricing: null,
  },
  parameters: {},
};
export function ProviderManager({ onClose }: { onClose(): void }) {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]),
    [selected, setSelected] = useState<ProviderConfig | null>(null),
    [form, setForm] = useState<ProviderInput>(structuredClone(blank));
  const [error, setError] = useState(''),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseline, setBaseline] = useState(() => JSON.stringify(blank));
  useLeaveGuard(
    JSON.stringify(form) !== baseline || Boolean(apiKey),
    '模型配置尚未保存，离开将放弃这些编辑。',
  );
  const refresh = useCallback(async () => setConfigs((await writingApi.providers()).data), []);
  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);
  function connection(patch: Partial<ProviderInput['connection']>) {
    setForm({ ...form, connection: { ...form.connection, ...patch } });
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="模型设置">
      <div className="dialog provider-settings">
        <div className="section-heading">
          <h2 id="provider-title">模型设置</h2>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="muted">填写接口地址、模型和 API 密钥后保存，即可检查连接。</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {note && <p role="status">{note}</p>}
        <label>
          已有配置
          <select
            disabled={busy}
            value={selected?.id ?? ''}
            onChange={(e) => {
              const config = configs.find((item) => item.id === e.target.value) ?? null;
              setSelected(config);
              setForm(structuredClone(config?.config ?? blank));
              setBaseline(JSON.stringify(config?.config ?? blank));
              setError('');
              setNote('');
              setApiKey('');
            }}
          >
            <option value="">新建配置</option>
            {configs.map((config) => (
              <option key={config.id} value={config.id}>
                {config.config.name} · {config.credentialConfigured ? '凭据可用' : '凭据未配置'}
              </option>
            ))}
          </select>
        </label>
        <form
          className="provider-fields"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const checked = providerInputSchema.safeParse(
                apiKey.trim()
                  ? { ...form, connection: { ...form.connection, credentialRef: null } }
                  : form,
              );
              if (!checked.success) {
                const field = checked.error.issues[0]?.path.join('.') ?? '';
                throw new Error(
                  field.includes('baseUrl')
                    ? '接口地址必须是完整 HTTP(S) URL，且不能包含用户名、密码、查询参数或片段。'
                    : field.includes('contextWindow')
                      ? '上下文窗口须为正整数。'
                      : field.includes('maxOutputTokens')
                        ? '输出上限须为正整数。'
                        : field.includes('modelId')
                          ? '请填写模型 ID（最多 200 字符）。'
                          : field.includes('name')
                            ? '请填写配置名称（最多 100 字符）。'
                            : field.includes('provider')
                              ? '请填写供应商标识（最多 200 字符）。'
                              : '输出上限必须小于上下文窗口；请检查模型参数。',
                );
              }
              const saved = await writingApi.saveProvider(
                checked.data,
                selected?.id,
                selected?.revision,
                apiKey.trim() || undefined,
              );
              setSelected(saved);
              setForm(saved.config);
              setBaseline(JSON.stringify(saved.config));
              setApiKey('');
              await refresh();
              setNote('模型配置已保存');
            });
          }}
        >
          <label>
            配置名称
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            接口协议
            <select
              value={form.connection.api}
              onChange={(e) =>
                connection({ api: e.target.value as ProviderInput['connection']['api'] })
              }
            >
              <option value="openai-completions">OpenAI Chat Completions</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </label>
          <label>
            供应商标识
            <input
              required
              value={form.connection.provider}
              onChange={(e) => connection({ provider: e.target.value })}
            />
          </label>
          <label>
            接口地址
            <input
              required
              type="url"
              value={form.connection.baseUrl}
              onChange={(e) => connection({ baseUrl: e.target.value })}
            />
          </label>
          <label>
            模型 ID
            <input
              required
              value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })}
            />
          </label>
          <div className="credential-field">
            <label htmlFor="provider-api-key">
              API 密钥
              <input
                id="provider-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                aria-describedby="provider-credential-help"
                autoComplete="off"
                placeholder={
                  selected?.credentialConfigured
                    ? '已设置，留空保留现有密钥'
                    : '直接粘贴 API 密钥；免密接口可留空'
                }
              />
            </label>
            <p id="provider-credential-help" className="muted">
              密钥会保存在运行服务的机器上；留空保留已设置的密钥。
            </p>
          </div>
          <div className="row">
            <label>
              上下文窗口
              <input
                type="number"
                min={1}
                step={1}
                required
                value={form.connection.contextWindow}
                onChange={(e) => connection({ contextWindow: Number(e.target.value) })}
              />
            </label>
            <label>
              输出上限
              <input
                type="number"
                min={1}
                step={1}
                required
                value={form.connection.maxOutputTokens}
                onChange={(e) => connection({ maxOutputTokens: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.connection.reasoning}
              onChange={(e) => connection({ reasoning: e.target.checked })}
            />
            启用模型推理
          </label>
          <p className="fine">需模型支持；接口返回的可见思考文本或摘要会显示在 AI 输出中。</p>
          <div className="row">
            <button className="primary" disabled={busy} type="submit">
              保存模型配置
            </button>
            <button
              disabled={busy || !selected}
              type="button"
              onClick={() => {
                if (selected)
                  void run(async () => {
                    const check = await writingApi.check(selected.id);
                    setNote(
                      `连接检查：${check.modelId} / ${check.status} / ${check.stopReason}；输入 ${check.usage.known.inputTokens ?? '未知'}，输出 ${check.usage.known.outputTokens ?? '未知'}，费用 ${check.usage.known.cost ? `${check.usage.known.cost.amount} ${check.usage.known.cost.currency}` : '未知'}。记录 ${check.id}`,
                    );
                  });
              }}
            >
              检查已保存连接
            </button>
            <button
              className="danger"
              disabled={busy || !selected}
              type="button"
              onClick={() => {
                if (
                  !selected ||
                  !window.confirm(
                    `确定删除模型配置“${selected.config.name}”？删除后无法恢复，当前未保存的编辑也会丢弃。使用此配置的角色需重新选择模型，历史写作记录保留。`,
                  )
                )
                  return;
                void run(async () => {
                  await writingApi.deleteProvider(selected.id, selected.revision);
                  setConfigs((items) => items.filter((item) => item.id !== selected.id));
                  setSelected(null);
                  setForm(structuredClone(blank));
                  setBaseline(JSON.stringify(blank));
                  setApiKey('');
                  setNote('模型配置已删除');
                });
              }}
            >
              删除配置
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
