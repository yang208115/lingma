import { type AgentPrompt, agentPromptTextSchema } from '@lingma/shared';
import { useEffect, useState } from 'react';
import { ApiError } from '../api.js';
import { useLeaveGuard } from '../runtime.js';
import { writingApi } from '../writing-api.js';

export function AgentPromptEditor({ onClose }: { onClose(): void }) {
  const [config, setConfig] = useState<AgentPrompt | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const dirty = config !== null && draft !== config.prompt;
  useLeaveGuard(dirty, 'Agent 提示词尚未保存，离开将放弃这些编辑。');
  const valid = agentPromptTextSchema.safeParse(draft).success;
  useEffect(() => {
    let live = true;
    void writingApi
      .agentPrompt()
      .then((value) => {
        if (!live) return;
        setConfig(value);
        setDraft(value.prompt);
      })
      .catch((error: unknown) => {
        if (live) setError(error instanceof Error ? error.message : '加载提示词失败');
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);
  function close() {
    if (!busy) onClose();
  }
  async function save() {
    if (!config || !valid) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await writingApi.saveAgentPrompt(draft, config.revision);
      setConfig(saved);
      setDraft(saved.prompt);
      setConflict(false);
      setNotice('提示词已保存，将用于新任务');
    } catch (error) {
      setConflict(error instanceof ApiError && error.code === 'VERSION_CONFLICT');
      setError(error instanceof Error ? error.message : '保存失败，编辑内容已保留');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Agent 提示词">
      <div className="dialog wide agent-prompt-settings">
        <div className="section-heading">
          <h2 id="agent-prompt-title">Agent 提示词</h2>
          <button type="button" disabled={busy} onClick={close}>
            关闭
          </button>
        </div>
        <p className="muted">
          设置所有作品共用的 Agent 系统提示词，保存后用于新任务。可用 Skill 目录会自动附加。
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {busy && !config && <p>正在加载提示词…</p>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor="agent-system-prompt">系统提示词</label>
          <textarea
            id="agent-system-prompt"
            className="agent-prompt-input"
            rows={18}
            maxLength={32000}
            disabled={busy || !config}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setNotice('');
            }}
            spellCheck={false}
            aria-describedby="agent-prompt-help"
          />
          <p id="agent-prompt-help" className="muted">
            {draft.length} / 32000 字符{dirty ? ' · 尚未保存' : ''}
          </p>
          <div className="row">
            <button
              className="primary"
              type="submit"
              disabled={busy || !dirty || !valid || conflict}
            >
              保存提示词
            </button>
            <button
              type="button"
              disabled={busy || !config}
              onClick={() => {
                if (config) {
                  setDraft(config.defaultPrompt);
                  setNotice('已恢复默认内容，保存后生效');
                }
              }}
            >
              恢复默认
            </button>
            {(!config || conflict) && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (dirty && !window.confirm('放弃当前编辑并加载最新提示词？')) return;
                  setBusy(true);
                  try {
                    const latest = await writingApi.agentPrompt();
                    setConfig(latest);
                    setDraft(latest.prompt);
                    setConflict(false);
                    setError('');
                    setNotice('');
                  } catch (error) {
                    setError(error instanceof Error ? error.message : '加载失败');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                加载最新版本
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
