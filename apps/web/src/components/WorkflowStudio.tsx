import {
  type AgentProfile,
  type AgentProfileConfig,
  agentProfileConfigSchema,
  type Document,
  documentKindSchema,
  elementLabels,
  type ProviderConfig,
  type RunDetail,
  type Skill,
  type WorkflowTemplate,
  type WorkflowTemplateConfig,
  workflowTemplateConfigSchema,
} from '@lingma/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { useLeaveGuard } from '../runtime.js';
import { skillApi } from '../skill-api.js';
import { workflowApi } from '../workflow-api.js';
import { writingApi } from '../writing-api.js';
import { WorkflowGraphEditor } from './WorkflowGraphEditor.js';

const capabilities = {
  plan: '章纲策划',
  draft: '正文 / 润色 / 修订',
  generate: '通用内容生成 / 修订',
  review: '审校',
  analysis: '辅助分析',
};
const statuses: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  awaiting_input: '等待作者处理',
  awaiting_acceptance: '等待接受',
  paused: '已暂停',
  completed: '已结束',
  failed: '失败',
  limited: '达到限制',
  cancelled: '已取消',
  interrupted: '已中断',
  pending: '待开始',
  succeeded: '已完成',
  skipped: '已跳过',
  invalidated: '已失效',
};
// Older prompts told the model to answer with JSON or call a submit tool; nodes now reply in Markdown.
const legacyFormat =
  /JSON|submit_workflow_artifact|repair_workflow_artifact|结构化产物|提交产物|review_report|chapter_draft|chapter_plan/i;
const stripLegacyFormat = (prompt: string) =>
  prompt
    .split(/(?<=[。！？\n])/)
    .filter((sentence) => !legacyFormat.test(sentence))
    .join('')
    .trim();
const freshProfile = () =>
  agentProfileConfigSchema.parse({
    name: '新 Agent',
    capability: 'review',
    prompt: '检查当前稿件，给出具体问题、原文引句和改进建议。',
  });
export function WorkflowStudio({
  projectId,
  mode,
  document,
  beforeRun,
  onClose,
}: {
  projectId: string;
  mode: 'profiles' | 'templates';
  document: Document | undefined;
  beforeRun(): Promise<void>;
  onClose(): void;
}) {
  const tab = mode;
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [config, setConfig] = useState(freshProfile);
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [templateConfig, setTemplateConfig] = useState<WorkflowTemplateConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [providerId, setProviderId] = useState('');
  const [trial, setTrial] = useState<{
    run: RunDetail;
    artifact: string | null;
  } | null>(null);
  const dirty =
    JSON.stringify(config) !== JSON.stringify(profile?.draft ?? freshProfile()) ||
    Boolean(templateConfig && JSON.stringify(templateConfig) !== JSON.stringify(template?.draft));
  useLeaveGuard(dirty, '角色或模板有尚未保存的修改，离开将放弃这些编辑。');
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const reload = useCallback(async () => {
    const [p, t, m, s] = await Promise.all([
      workflowApi.profiles(),
      workflowApi.templates(),
      writingApi.providers(),
      skillApi.list(undefined, projectId ? { projectId } : {}),
    ]);
    setProfiles(p);
    setTemplates(t);
    setProviders(m.data);
    setSkills(s.data);
  }, [projectId]);
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [reload]);
  const templateVersionId = templates[0]?.versions[0]?.id ?? '';
  useEffect(() => {
    if (!providerId && providers[0]) setProviderId(providers[0].id);
  }, [providers, providerId]);
  const trialId = trial?.run.id ?? '';
  useEffect(() => {
    if (!trialId) return;
    let alive = true;
    const source = new EventSource(`/api/v1/runs/${trialId}/events`);
    source.addEventListener('run.finished', () => {
      void workflowApi
        .testResult(trialId)
        .then((result) => {
          if (alive) setTrial(result);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
      source.close();
    });
    void workflowApi
      .testResult(trialId)
      .then((result) => {
        if (alive) setTrial(result);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      source.close();
    };
  }, [trialId]);
  const discard = () => !dirty || window.confirm('有未保存的角色或模板配置，确定放弃这些编辑？');
  const chooseProfile = (p: AgentProfile | null) => {
    if (!discard()) return;
    setProfile(p);
    setConfig(p?.draft ?? freshProfile());
    setTemplateConfig(null);
    setError('');
  };
  const saveProfile = async () => {
    const c = agentProfileConfigSchema.parse(config);
    const p = profile
      ? await workflowApi.saveProfile(profile.id, profile.revision, c)
      : await workflowApi.createProfile(c);
    setProfile(p);
    setConfig(p.draft);
    await reload();
    return p;
  };
  const saveTemplate = async () => {
    if (!templateConfig) throw new Error('请先选择模板');
    const c = workflowTemplateConfigSchema.parse(templateConfig);
    const t = template
      ? await workflowApi.saveTemplate(template.id, template.revision, c)
      : await workflowApi.createTemplate(c);
    setTemplate(t);
    setTemplateConfig(t.draft);
    await reload();
    return t;
  };
  return (
    <section>
      <div className="dialog workflow-studio">
        <header className="dialog-heading">
          <div>
            <p className="eyebrow">协作创作</p>
            <h2 id="workflow-title">{mode === 'profiles' ? 'Agent 角色库' : '工作流模板'}</h2>
          </div>
          <button
            type="button"
            onClick={() => {
              onClose();
            }}
          >
            关闭
          </button>
        </header>
        <nav className="workflow-tabs" aria-label="协作创作功能">
          {(
            [
              ['profiles', 'Agent 角色库'],
              ['templates', '工作流模板'],
            ] as const
          ).map(([id, label]) => (
            <Link
              key={id}
              aria-current={tab === id ? 'page' : undefined}
              to={
                id === 'profiles'
                  ? `/agents${projectId ? `?${new URLSearchParams({ project: projectId, ...(document ? { document: document.id } : {}) })}` : ''}`
                  : `/workflow-templates${projectId ? `?${new URLSearchParams({ project: projectId, ...(document ? { document: document.id } : {}) })}` : ''}`
              }
            >
              {label}
            </Link>
          ))}
          <button type="button" disabled={busy} onClick={() => void act(reload)}>
            刷新配置
          </button>
        </nav>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {tab === 'profiles' && (
          <div className="workflow-columns">
            <aside>
              <button type="button" onClick={() => chooseProfile(null)}>
                ＋ 新建 Agent
              </button>
              {profiles.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={profile?.id === p.id ? 'selected' : ''}
                  onClick={() => chooseProfile(p)}
                >
                  {p.draft.name}
                  {p.archived ? ' · 已归档' : ''}
                  <small>
                    {capabilities[p.draft.capability]} · {p.versions.length} 个版本
                  </small>
                </button>
              ))}
            </aside>
            <section aria-label="Agent 配置">
              <h3>{profile ? '编辑 Agent' : '创建 Agent'}</h3>
              <label>
                Agent 名称
                <input
                  aria-label="Agent 名称"
                  maxLength={100}
                  value={config.name}
                  onChange={(e) => setConfig({ ...config, name: e.target.value })}
                />
              </label>
              <label>
                介绍
                <input
                  aria-label="介绍"
                  maxLength={2000}
                  value={config.description}
                  onChange={(e) => setConfig({ ...config, description: e.target.value })}
                />
              </label>
              <label>
                能力类型
                <select
                  aria-label="能力类型"
                  value={config.capability}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      capability: e.target.value as AgentProfileConfig['capability'],
                    })
                  }
                >
                  {Object.entries(capabilities).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                角色提示词
                <textarea
                  aria-label="角色提示词"
                  rows={8}
                  maxLength={32000}
                  value={config.prompt}
                  onChange={(e) => setConfig({ ...config, prompt: e.target.value })}
                />
              </label>
              {legacyFormat.test(config.prompt) && (
                <p role="status" className="warning">
                  提示词里仍有 JSON / 提交工具的输出要求。节点现在直接用 Markdown
                  回复，输出格式由系统追加。
                  <button
                    type="button"
                    onClick={() =>
                      setConfig({
                        ...config,
                        prompt: stripLegacyFormat(config.prompt) || config.prompt,
                      })
                    }
                  >
                    移除旧格式要求
                  </button>
                </p>
              )}
              <label>
                角色模型
                <select
                  aria-label="角色模型"
                  value={config.providerConfigId ?? ''}
                  onChange={(e) =>
                    setConfig({ ...config, providerConfigId: e.target.value || null })
                  }
                >
                  <option value="">继承本次工作流模型</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.config.name} · {p.config.modelId}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>允许使用的工具</legend>
                {(
                  ['read_document', 'search_documents', 'load_skill', 'read_skill_file'] as const
                ).map((t, i) => (
                  <label className="checkbox" key={t}>
                    <input
                      type="checkbox"
                      checked={config.tools.includes(t)}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          tools: e.target.checked
                            ? [...config.tools, t]
                            : config.tools.filter((x) => x !== t),
                        })
                      }
                    />
                    {['读取资料', '检索资料', '加载 Skill', '读取 Skill 附件'][i]}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>资料类型偏好</legend>
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, contextKinds: documentKindSchema.options })}
                >
                  启用全部基本信息资料
                </button>
                <p className="muted fine">勾选后保存并发布新角色版本，旧版本权限保持不变。</p>
                {documentKindSchema.options.map((k) => (
                  <label className="checkbox" key={k}>
                    <input
                      type="checkbox"
                      checked={config.contextKinds.includes(k)}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          contextKinds: e.target.checked
                            ? [...config.contextKinds, k]
                            : config.contextKinds.filter((x) => x !== k),
                        })
                      }
                    />
                    {{ chapter: '正文', chapter_outline: '章纲', ...elementLabels }[k]}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Skill 版本</legend>
                {skills.length === 0 && (
                  <p className="muted">先通过通用 Skill 或项目 Skill 导入方法与参考资料。</p>
                )}
                {skills.map((s) => (
                  <label className="checkbox" key={s.id}>
                    <input
                      type="checkbox"
                      checked={config.skillVersionIds.includes(s.currentVersionId)}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          skillVersionIds: e.target.checked
                            ? [...config.skillVersionIds, s.currentVersionId]
                            : config.skillVersionIds.filter((v) => v !== s.currentVersionId),
                        })
                      }
                    />
                    {s.name} · {s.projectId ? '项目 Skill' : '通用 Skill'}
                  </label>
                ))}
                {config.skillVersionIds
                  .filter((id) => !skills.some((s) => s.currentVersionId === id))
                  .map((id) => (
                    <label className="checkbox" key={id}>
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          setConfig({
                            ...config,
                            skillVersionIds: config.skillVersionIds.filter((v) => v !== id),
                          })
                        }
                      />
                      保留旧 Skill 版本 {id}
                    </label>
                  ))}
              </fieldset>
              <div className="workflow-actions">
                <button
                  type="button"
                  disabled={busy || !projectId || document?.kind !== 'chapter' || !providerId}
                  onClick={() =>
                    void act(async () => {
                      await beforeRun();
                      if (!document) throw new Error('请先选择正文章节');
                      const p = await saveProfile();
                      const current = await api.document(document.id);
                      setTrial(
                        await workflowApi.testProfile(p.id, p.revision, {
                          projectId,
                          targetDocumentId: document.id,
                          baseVersionId: current.version.id,
                          templateVersionId,
                          providerConfigId: providerId,
                          input: '按角色职责处理当前章节，提交完整结构化产物。',
                          selectedVersionIds: [],
                          allowFutureOutline: false,
                        }),
                      );
                    })
                  }
                >
                  保存并试运行 Agent
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await saveProfile();
                      setNotice('Agent 草稿已保存');
                    })
                  }
                >
                  保存角色草稿
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || Boolean(profile?.archived)}
                  onClick={() =>
                    void act(async () => {
                      const p = await saveProfile();
                      const published = await workflowApi.publishProfile(p.id, p.revision);
                      setProfile(published);
                      setConfig(published.draft);
                      await reload();
                      setNotice('已发布角色版本，可在模板中选择');
                    })
                  }
                >
                  保存并发布 Agent
                </button>
                {profile && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setProfile(null);
                        setConfig({ ...config, name: `${config.name} 副本` });
                      }}
                    >
                      复制为新 Agent
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const p = await workflowApi.archiveProfile(
                            profile.id,
                            profile.revision,
                            !profile.archived,
                          );
                          setProfile(p);
                          await reload();
                        })
                      }
                    >
                      {profile.archived ? '取消归档' : '归档 Agent'}
                    </button>
                  </>
                )}
              </div>
              {trial && (
                <details open>
                  <summary>角色试运行 · {statuses[trial.run.status]}</summary>
                  <p>使用当前章节和本次默认模型，不产生正式文档提议。</p>
                  <pre>
                    {trial.artifact
                      ? trial.artifact
                      : trial.run.output?.text || trial.run.stopReason || '模型处理中…'}
                  </pre>
                  {['queued', 'running'].includes(trial.run.status) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await writingApi.cancel(trial.run.id);
                          setTrial(await workflowApi.testResult(trial.run.id));
                        })
                      }
                    >
                      停止试运行
                    </button>
                  )}
                </details>
              )}
              {profile && (
                <details>
                  <summary>已发布版本</summary>
                  {profile.versions.map((v) => (
                    <details key={v.id}>
                      <summary>
                        v{v.versionNo} · {new Date(v.createdAt).toLocaleString()}
                      </summary>
                      <pre>{JSON.stringify(v.config, null, 2)}</pre>
                    </details>
                  ))}
                </details>
              )}
            </section>
          </div>
        )}
        {tab === 'templates' && (
          <div className="workflow-columns workflow-template-columns">
            <aside>
              {templates.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => {
                    if (!discard()) return;
                    setTemplate(t);
                    setTemplateConfig(t.draft);
                    setConfig(profile?.draft ?? freshProfile());
                  }}
                >
                  {t.draft.name}
                  <small>{t.versions.length} 个发布版本</small>
                </button>
              ))}
              <p className="muted">选择模板后可复制、调整节点与 Agent。</p>
            </aside>
            <section aria-label="工作流配置">
              {templateConfig ? (
                <>
                  <div className="workflow-template-meta">
                    <label>
                      模板名称
                      <input
                        aria-label="模板名称"
                        value={templateConfig.name}
                        maxLength={100}
                        onChange={(e) =>
                          setTemplateConfig({ ...templateConfig, name: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      任务用途
                      <select
                        aria-label="模板任务用途"
                        value={templateConfig.taskType}
                        onChange={(event) =>
                          setTemplateConfig({
                            ...templateConfig,
                            taskType: event.target.value as typeof templateConfig.taskType,
                          })
                        }
                      >
                        <option value="chapter_write">正文写作</option>
                        <option value="basic_information">基础信息</option>
                        <option value="worldbuilding">世界观生成</option>
                        <option value="master_outline">故事总纲</option>
                        <option value="story_events">事件规划</option>
                      </select>
                    </label>
                  </div>
                  <WorkflowGraphEditor
                    key={template?.id ?? 'new'}
                    config={templateConfig}
                    profiles={profiles}
                    onChange={setTemplateConfig}
                  />
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={templateConfig.autoRevise}
                      onChange={(e) =>
                        setTemplateConfig({ ...templateConfig, autoRevise: e.target.checked })
                      }
                    />
                    自动修订并复审，直到重要问题解决
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={templateConfig.adoptionGate === 'manual'}
                      onChange={(e) =>
                        setTemplateConfig({
                          ...templateConfig,
                          adoptionGate: e.target.checked ? 'manual' : 'auto',
                        })
                      }
                    />
                    审校汇总后等待作者采纳意见
                  </label>
                  <div className="workflow-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await saveTemplate();
                          setNotice('模板草稿已保存');
                        })
                      }
                    >
                      保存模板草稿
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const t = await saveTemplate();
                          setTemplate(await workflowApi.publishTemplate(t.id, t.revision));
                          await reload();
                          setNotice('模板已发布，新流程可使用此版本');
                        })
                      }
                    >
                      保存并发布模板
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTemplate(null);
                        setTemplateConfig({
                          ...templateConfig,
                          name: `${templateConfig.name} 副本`,
                        });
                      }}
                    >
                      复制为新模板
                    </button>
                  </div>
                </>
              ) : (
                <p>请选择一个模板，配置阶段及角色。</p>
              )}
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
