import {
  type AgentProfile,
  type AgentProfileConfig,
  agentProfileConfigSchema,
  type Document,
  documentKindSchema,
  elementLabels,
  orderedChapters,
  type ProviderConfig,
  type RunDetail,
  type Skill,
  type WorkflowArtifactPayload,
  type WorkflowDecision,
  type WorkflowPreview,
  type WorkflowRun,
  type WorkflowTemplate,
  type WorkflowTemplateConfig,
  workflowTemplateConfigSchema,
} from '@lingma/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { useLeaveGuard } from '../runtime.js';
import { skillApi } from '../skill-api.js';
import { workflowApi } from '../workflow-api.js';
import { writingApi } from '../writing-api.js';
import { AssistantWorkflowCard } from './AssistantWorkflows.js';
import { DiffView } from './DiffView.js';
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
  onApplied,
  onClose,
}: {
  projectId: string;
  mode: 'profiles' | 'templates' | 'runs';
  document: Document | undefined;
  beforeRun(): Promise<void>;
  onApplied(id: string): Promise<void>;
  onClose(): void;
}) {
  const tab = mode;
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedRun = searchParams.get('run') ?? '';
  const requestedRunRef = useRef(requestedRun);
  requestedRunRef.current = requestedRun;
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
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [run, setRunState] = useState<WorkflowRun | null>(null);
  const setRun = useCallback(
    (value: WorkflowRun, replace = false) => {
      if (value.projectId !== projectId) throw new Error('运行记录不属于当前作品');
      setRunState(value);
      if (mode === 'runs' && requestedRunRef.current !== value.id) {
        requestedRunRef.current = value.id;
        setSearchParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            next.set('run', value.id);
            return next;
          },
          { replace },
        );
      }
    },
    [projectId, mode, setSearchParams],
  );
  const [templateVersionId, setTemplateVersionId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [task, setTask] = useState('');
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [feedback, setFeedback] = useState('');
  const [edited, setEdited] = useState('');
  const [original, setOriginal] = useState<string | null>(null);
  const [sources, setSources] = useState<Document[]>([]);
  const [trial, setTrial] = useState<{
    run: RunDetail;
    artifact: WorkflowArtifactPayload | null;
  } | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [future, setFuture] = useState(false);
  const selectedRun = useRef('');
  const createKey = useRef<string>(crypto.randomUUID());
  const dirty =
    JSON.stringify(config) !== JSON.stringify(profile?.draft ?? freshProfile()) ||
    Boolean(templateConfig && JSON.stringify(templateConfig) !== JSON.stringify(template?.draft));
  useLeaveGuard(
    dirty || Boolean(edited) || Boolean(feedback),
    '角色、模板或协作稿件有尚未保存的修改，离开将放弃这些编辑。',
  );
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
      skillApi.list(),
    ]);
    setProfiles(p);
    setTemplates(t);
    setProviders(m.data);
    setSkills(s.data);
  }, []);
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [reload]);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void Promise.all([workflowApi.runs(projectId), api.structure(projectId)])
      .then(([r, s]) => {
        if (!alive) return;
        setRuns(r);
        setSources([...orderedChapters(s), ...s.documents.filter((d) => d.kind !== 'chapter')]);
        setAllowed(s.documents.map((d) => d.currentVersionId));
        if (r[0] && !requestedRunRef.current && mode === 'runs') {
          setRun(r[0], true);
          selectedRun.current = r[0].id;
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [projectId, mode, setRun]);
  useEffect(() => {
    if (mode !== 'runs' || !requestedRun) return;
    setError('');
    let live = true;
    setRunState(null);
    void workflowApi
      .run(requestedRun)
      .then((value) => {
        if (!live) return;
        if (value.projectId !== projectId) {
          setError('运行记录不属于当前作品');
          return;
        }
        setRunState(value);
        selectedRun.current = value.id;
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [requestedRun, projectId, mode]);
  useEffect(() => {
    if (!templateVersionId && templates[0]?.versions[0])
      setTemplateVersionId(templates[0].versions[0].id);
    if (!providerId && providers[0]) setProviderId(providers[0].id);
  }, [templates, providers, templateVersionId, providerId]);
  const runId = run?.id ?? '';
  const trackRun = !['completed', 'cancelled'].includes(run?.status ?? '');
  const draftEditKey = `${runId}:${run?.latestDraftId ?? ''}:${run?.snapshot.input.baseVersionId ?? ''}`;
  useEffect(() => {
    if (draftEditKey) {
      setEdited('');
      setOriginal(null);
    }
  }, [draftEditKey]);
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
  useEffect(() => {
    if (!runId || !trackRun) return;
    selectedRun.current = runId;
    const id = runId;
    let alive = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const latest = await workflowApi.run(id);
        if (alive && selectedRun.current === id) {
          setRun(latest);
          setRuns((old) => [latest, ...old.filter((r) => r.id !== id)]);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '刷新失败');
      } finally {
        inFlight = false;
      }
    };
    const stream = new EventSource(`/api/v1/workflows/${id}/events`);
    stream.addEventListener('change', () => {
      void refresh();
    });
    const timer = window.setInterval(() => {
      if (!window.document.hidden) void refresh();
    }, 5000);
    return () => {
      alive = false;
      stream.close();
      window.clearInterval(timer);
    };
  }, [runId, trackRun, setRun]);
  const previewInputs = JSON.stringify({
    templateVersionId,
    providerId,
    task,
    allowed,
    pins,
    future,
  });
  useEffect(() => {
    if (previewInputs) {
      setPreview(null);
      createKey.current = crypto.randomUUID();
    }
  }, [previewInputs]);
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
  const decide = async (action: WorkflowDecision['action'], content?: string) => {
    if (!run) return;
    const result = await workflowApi.decide(
      run.id,
      { expectedRevision: run.revision, action, content, feedback },
      crypto.randomUUID(),
    );
    setRun(result);
    setFeedback('');
    if (action === 'confirm_plan') setEdited('');
  };
  const draft = run?.artifacts.find((a) => a.id === run.latestDraftId);
  const plan = [...(run?.artifacts ?? [])].reverse().find((a) => a.payload.type === 'chapter_plan');
  return (
    <section>
      <div className="dialog workflow-studio">
        <header className="dialog-heading">
          <div>
            <p className="eyebrow">协作创作</p>
            <h2 id="workflow-title">
              {mode === 'profiles'
                ? 'Agent 角色库'
                : mode === 'templates'
                  ? '工作流模板'
                  : '协作写作'}
            </h2>
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
              ['runs', '协作写作'],
            ] as const
          ).map(([id, label]) => (
            <Link
              key={id}
              aria-current={tab === id ? 'page' : undefined}
              to={
                id === 'profiles'
                  ? `/agents${projectId ? `?${new URLSearchParams({ project: projectId, ...(document ? { document: document.id } : {}) })}` : ''}`
                  : id === 'templates'
                    ? `/workflow-templates${projectId ? `?${new URLSearchParams({ project: projectId, ...(document ? { document: document.id } : {}) })}` : ''}`
                    : projectId
                      ? `/projects/${projectId}/workflows${document ? `?${new URLSearchParams({ document: document.id })}` : ''}`
                      : '/projects'
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
                  <p className="muted">先通过 Skill 管理导入方法与参考资料。</p>
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
                    {s.name}
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
                          input: task.trim() || '按角色职责处理当前章节，提交完整结构化产物。',
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
                      ? JSON.stringify(trial.artifact, null, 2)
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
                      checked={templateConfig.confirmPlan}
                      onChange={(e) =>
                        setTemplateConfig({ ...templateConfig, confirmPlan: e.target.checked })
                      }
                    />
                    生成章纲后等待作者确认
                  </label>
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
        {tab === 'runs' && (
          <section aria-label="协作写作工作台">
            {!projectId ? (
              <p>请先打开作品和目标章节。</p>
            ) : (
              <>
                <details open={!run}>
                  <summary>启动新的协作写作</summary>
                  <p>
                    目标：
                    {document?.kind === 'chapter' ? document.title : '请在正文工作区选择一个章节'}
                  </p>
                  <label>
                    模板发布版本
                    <select
                      aria-label="模板发布版本"
                      value={templateVersionId}
                      onChange={(e) => setTemplateVersionId(e.target.value)}
                    >
                      <option value="">选择模板版本</option>
                      {templates.flatMap((t) =>
                        t.versions.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.config.name} · v{v.versionNo}
                          </option>
                        )),
                      )}
                    </select>
                  </label>
                  <label>
                    默认模型
                    <select
                      aria-label="默认模型"
                      value={providerId}
                      onChange={(e) => setProviderId(e.target.value)}
                    >
                      <option value="">选择模型配置</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.config.name} · {p.config.modelId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    本章创作要求
                    <textarea
                      aria-label="本章创作要求"
                      rows={4}
                      maxLength={32000}
                      value={task}
                      onChange={(e) => setTask(e.target.value)}
                      placeholder="视角、篇幅、冲突、必写内容与禁止事项…"
                    />
                  </label>
                  <details>
                    <summary>资料授权与固定全文</summary>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={future}
                        onChange={(e) => setFuture(e.target.checked)}
                      />
                      允许未来规划（章纲、事件、伏笔等）
                    </label>
                    {sources.map((d) => (
                      <div key={d.id} className="context-choice">
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={d.id === document?.id || allowed.includes(d.currentVersionId)}
                            disabled={d.id === document?.id}
                            onChange={(e) => {
                              setAllowed((old) =>
                                e.target.checked
                                  ? [...old, d.currentVersionId]
                                  : old.filter((x) => x !== d.currentVersionId),
                              );
                              if (!e.target.checked)
                                setPins((old) => old.filter((x) => x !== d.currentVersionId));
                            }}
                          />
                          {d.title}
                        </label>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={pins.includes(d.currentVersionId)}
                            disabled={!allowed.includes(d.currentVersionId)}
                            onChange={(e) =>
                              setPins((old) =>
                                e.target.checked
                                  ? [...old, d.currentVersionId]
                                  : old.filter((x) => x !== d.currentVersionId),
                              )
                            }
                          />
                          固定全文
                        </label>
                      </div>
                    ))}
                  </details>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !task.trim() ||
                      !providerId ||
                      !templateVersionId ||
                      document?.kind !== 'chapter'
                    }
                    onClick={() =>
                      void act(async () => {
                        await beforeRun();
                        if (!document) throw new Error('请选择章节');
                        const current = await api.document(document.id);
                        const latest = await api.structure(projectId);
                        const chapterOrder = orderedChapters(latest).map((d) => d.id);
                        const targetIndex = chapterOrder.indexOf(document.id);
                        const allowedDocuments = new Set(
                          sources
                            .filter((d) => allowed.includes(d.currentVersionId))
                            .map((d) => d.id),
                        );
                        const pinnedDocuments = new Set(
                          sources.filter((d) => pins.includes(d.currentVersionId)).map((d) => d.id),
                        );
                        const safe = latest.documents.filter((d) => {
                          if (d.id === document.id || !allowedDocuments.has(d.id)) return false;
                          const index = chapterOrder.indexOf(
                            d.kind === 'chapter' ? d.id : (d.chapterId ?? ''),
                          );
                          if (d.kind === 'chapter' && index > targetIndex) return false;
                          if (
                            d.kind === 'chapter_outline' &&
                            !future &&
                            (!d.chapterId || index > targetIndex)
                          )
                            return false;
                          return true;
                        });
                        const p = await workflowApi.preview({
                          projectId,
                          targetDocumentId: document.id,
                          baseVersionId: current.version.id,
                          templateVersionId,
                          providerConfigId: providerId,
                          input: task,
                          selectedVersionIds: safe
                            .filter((d) => pinnedDocuments.has(d.id))
                            .map((d) => d.currentVersionId),
                          allowedVersionIds: [
                            current.version.id,
                            ...safe.map((d) => d.currentVersionId),
                          ],
                          allowFutureOutline: future,
                        });
                        setPreview(p);
                      })
                    }
                  >
                    保存并预览流程
                  </button>
                  {preview && (
                    <div className="context-preview">
                      <p>
                        流程包含 {preview.template.config.steps.length} 个阶段，模型按需调用工具。
                      </p>
                      {preview.profiles.map((p) => (
                        <p key={p.id}>
                          {p.config.name} · {preview.contexts[p.id]?.request.modelId} · 输入估算{' '}
                          {preview.contexts[p.id]?.estimatedInputTokens} Token
                        </p>
                      ))}
                      {preview.warnings.map((w) => (
                        <p key={w}>{w}</p>
                      ))}
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await beforeRun();
                            const w = await workflowApi.create(
                              { ...preview.input, expectedPreviewHash: preview.hash },
                              createKey.current,
                            );
                            setRun(w);
                            setRuns((old) => [w, ...old.filter((r) => r.id !== w.id)]);
                            setPreview(null);
                          })
                        }
                      >
                        开始协作写作
                      </button>
                    </div>
                  )}
                </details>
                <label>
                  协作运行记录
                  <select
                    aria-label="协作运行记录"
                    value={run?.id ?? ''}
                    onChange={(e) =>
                      void act(async () => {
                        setSearchParams((previous) => {
                          const next = new URLSearchParams(previous);
                          if (e.target.value) next.set('run', e.target.value);
                          else next.delete('run');
                          return next;
                        });
                      })
                    }
                  >
                    <option value="">选择运行记录</option>
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {statuses[r.status]} · {r.snapshot.template.config.name} ·{' '}
                        {new Date(r.createdAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
                {run &&
                  (run.snapshot.input.taskType !== 'chapter_write' || !run.targetDocumentId) && (
                    <AssistantWorkflowCard
                      run={run}
                      onChange={setRun}
                      beforeAccept={beforeRun}
                      onSaved={async (ids) => {
                        if (ids[0]) await onApplied(ids[0]);
                      }}
                    />
                  )}
                {run && run.snapshot.input.taskType === 'chapter_write' && run.targetDocumentId && (
                  <>
                    <h3>{statuses[run.status]}</h3>
                    <p role="status">{run.reason}</p>
                    <p>
                      模型调用 {run.modelCalls} 次 · 输入 {run.usage.known.inputTokens ?? '未知'} /
                      输出 {run.usage.known.outputTokens ?? '未知'} Token · 费用{' '}
                      {run.usageByCurrency.length
                        ? run.usageByCurrency
                            .map(
                              (c) =>
                                `${c.amount} ${c.currency}${c.source === 'estimate' ? '（估算）' : ''}`,
                            )
                            .join('；')
                        : '未知'}
                      {!run.usage.complete ? ' · 统计不完整' : ''}
                    </p>
                    {run.sourceChanges.length > 0 &&
                      !['completed', 'cancelled'].includes(run.status) && (
                        <section aria-label="资料版本变化">
                          <p className="error">
                            运行后资料已有变化：{run.sourceChanges.join('、')}。
                            {run.sourceSnapshotAccepted
                              ? '已明确选择沿用冻结资料；正文基准仍需一致。'
                              : '接受前请选择资料处理方式。'}
                          </p>
                          {['awaiting_input', 'awaiting_acceptance', 'paused'].includes(
                            run.status,
                          ) && (
                            <div className="workflow-actions">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void act(() => decide('use_snapshot'))}
                              >
                                明确沿用冻结资料
                              </button>
                              {run.latestDraftId && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(async () => {
                                      await beforeRun();
                                      setRun(
                                        await workflowApi.refreshSources(
                                          run.id,
                                          run.revision,
                                          edited.trim() ? edited : undefined,
                                        ),
                                      );
                                      setEdited('');
                                    })
                                  }
                                >
                                  刷新资料并复审当前稿
                                </button>
                              )}
                            </div>
                          )}
                          <p className="muted">
                            若正文也已修改，请在下方填写合并后的完整稿，再刷新资料复审。
                          </p>
                        </section>
                      )}
                    <ol className="workflow-progress">
                      {run.nodes.map((n) => (
                        <li key={n.key}>
                          <strong>{n.name}</strong>
                          <span>{statuses[n.status]}</span>
                          {n.error && <p className="error">{n.error}</p>}
                          {n.runIds.length > 0 && (
                            <details>
                              <summary>执行记录（{n.runIds.length} 次尝试）</summary>
                              {n.runIds.map((id) => (
                                <button
                                  key={id}
                                  type="button"
                                  onClick={() =>
                                    void act(async () => {
                                      const r = await writingApi.run(id);
                                      setNotice(r.output?.text || r.stopReason || '任务执行中');
                                    })
                                  }
                                >
                                  查看本次模型输出
                                </button>
                              ))}
                            </details>
                          )}
                        </li>
                      ))}
                    </ol>
                    <div className="workflow-actions">
                      {['queued', 'running'].includes(run.status) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(() => decide('pause'))}
                        >
                          节点结束后暂停
                        </button>
                      )}
                      {['paused', 'interrupted', 'failed', 'limited'].includes(run.status) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(() => decide('resume'))}
                        >
                          恢复 / 重试当前节点
                        </button>
                      )}
                      {!['completed', 'cancelled'].includes(run.status) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(() => decide('cancel'))}
                        >
                          结束并释放作品
                        </button>
                      )}
                    </div>
                    {run.status === 'awaiting_input' && (
                      <>
                        <label>
                          处理意见
                          <textarea
                            aria-label="处理意见"
                            rows={3}
                            value={feedback}
                            maxLength={8000}
                            onChange={(e) => setFeedback(e.target.value)}
                          />
                        </label>
                        {!run.planConfirmed && plan && plan.payload.type === 'chapter_plan' ? (
                          <>
                            <pre className="workflow-prose">{plan.payload.content}</pre>
                            <label>
                              修改章纲（留空则采用原稿）
                              <textarea
                                aria-label="修改章纲（留空则采用原稿）"
                                rows={5}
                                value={edited}
                                onChange={(e) => setEdited(e.target.value)}
                              />
                            </label>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void act(() => decide('confirm_plan', edited || undefined))
                              }
                            >
                              确认章纲并继续
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy || !feedback.trim()}
                              onClick={() => void act(() => decide('continue'))}
                            >
                              提交意见并继续
                            </button>
                            {run.latestDraftId && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void act(() => decide('use_candidate'))}
                              >
                                明确使用当前完整候选
                              </button>
                            )}
                          </>
                        )}
                      </>
                    )}
                    {draft && draft.payload.type === 'chapter_draft' && (
                      <section aria-label="工作流正文候选">
                        <h3>当前完整候选</h3>
                        <pre className="workflow-prose">{draft.payload.content}</pre>
                        {['awaiting_input', 'awaiting_acceptance'].includes(run.status) && (
                          <>
                            <label>
                              编辑候选后重新审校
                              <textarea
                                aria-label="编辑候选后重新审校"
                                rows={8}
                                value={edited}
                                maxLength={1000000}
                                onChange={(e) => setEdited(e.target.value)}
                                placeholder="填写完整的新稿…"
                              />
                            </label>
                            <button
                              type="button"
                              disabled={busy || !edited.trim()}
                              onClick={() => void act(() => decide('edit_candidate', edited))}
                            >
                              提交完整新稿并复审
                            </button>
                          </>
                        )}
                      </section>
                    )}
                    {run.artifacts
                      .filter((a) => a.payload.type === 'review_report')
                      .map((a) => (
                        <details
                          key={a.id}
                          open={
                            a.payload.type === 'review_report' &&
                            a.payload.reviewedArtifactId === run.latestDraftId
                          }
                        >
                          <summary>
                            {run.nodes.find((n) => n.key === a.nodeKey)?.name} ·{' '}
                            {a.payload.type === 'review_report' &&
                            a.payload.reviewedArtifactId === run.latestDraftId
                              ? '当前稿'
                              : '历史稿'}
                            审校
                          </summary>
                          {a.payload.type === 'review_report' && (
                            <>
                              <p>范围：{a.payload.coverage.join('、')}</p>
                              {[...new Set(a.payload.uncovered)].map((s) => (
                                <p key={s}>未覆盖：{s}</p>
                              ))}
                              {a.payload.issues.length === 0 && <p>本次未发现问题。</p>}
                              {a.payload.issues.map((i) => (
                                <article key={i.id} className="review-issue">
                                  <strong>
                                    {i.severity} · {i.description}
                                  </strong>
                                  <blockquote>{i.quote}</blockquote>
                                  <p>{i.suggestion}</p>
                                </article>
                              ))}
                            </>
                          )}
                        </details>
                      ))}
                    {run.proposal && (
                      <section aria-label="工作流最终提议">
                        <h3>最终提议 · {run.proposal.status}</h3>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              if (!run.proposal) return;
                              setOriginal(
                                (
                                  await api.version(
                                    run.proposal.targetDocumentId,
                                    run.proposal.baseVersionId,
                                  )
                                ).content,
                              );
                            })
                          }
                        >
                          比较候选与原文
                        </button>
                        {original !== null && (
                          <DiffView before={original} after={run.proposal.content} />
                        )}
                        <div className="workflow-actions">
                          {run.proposal.status === 'pending' && (
                            <button
                              type="button"
                              className="primary"
                              disabled={busy}
                              onClick={() =>
                                void act(async () => {
                                  if (!run.proposal) return;
                                  await beforeRun();
                                  await writingApi.accept(run.proposal.id, crypto.randomUUID());
                                  if (run.targetDocumentId) await onApplied(run.targetDocumentId);
                                  setRun(await workflowApi.run(run.id));
                                })
                              }
                            >
                              接受最终稿并保存正文
                            </button>
                          )}
                          {['pending', 'stale'].includes(run.proposal.status) && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void act(() => decide('reject'))}
                            >
                              拒绝并结束
                            </button>
                          )}
                        </div>
                        {run.proposal.status === 'stale' && (
                          <p className="error">
                            正文基准已变化，请保留候选，合并后基于最新正文新建流程。
                          </p>
                        )}
                      </section>
                    )}
                    <details>
                      <summary>全部产物与冻结配置</summary>
                      <pre>
                        {JSON.stringify(
                          { snapshot: run.snapshot, artifacts: run.artifacts },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
