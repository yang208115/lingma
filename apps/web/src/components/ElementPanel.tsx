import {
  basicInformationKinds,
  type ElementCandidate,
  type ElementData,
  type ElementEntry,
  type ElementGeneration,
  type ElementGenerationInput,
  type ElementKind,
  elementDataSchema,
  elementFields,
  elementLabels,
  hasElementContent,
  isBasicInformationKind,
  isElementKind,
  type ProviderConfig,
  type Structure,
  singleElementGenerationInputSchema,
  workflowInputSchema,
} from '@lingma/shared';
import { ArrowLeft, BookOpen, Plus, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { elementApi } from '../element-api.js';
import { useProjectProvider } from '../provider-selection.js';
import { useLeaveGuard } from '../runtime.js';
import { writingApi } from '../writing-api.js';
import { AssistantWorkflowCard } from './AssistantWorkflowCard.js';
import { useAssistantWorkflows } from './AssistantWorkflows.js';
import { DiffView } from './DiffView.js';
import { ExecutionModeMenu } from './ExecutionModeMenu.js';
import {
  primaryElementFields,
  singletonKinds,
  worldbuildingTypes,
} from './element-presentation.js';
import { History } from './History.js';

const statusLabels = {
  draft: '草稿',
  confirmed: '已确认',
  archived: '已归档',
  pending: '待采用',
  accepted: '已采用',
  rejected: '已拒绝',
};
const jobLabels = {
  queued: '排队中',
  running: '生成中',
  completed: '生成完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
const reviewLabels = {
  pending: '待审阅',
  partially_accepted: '部分采用',
  accepted: '全部采用',
  rejected: '全部拒绝',
  processed: '已处理',
};
const foreshadowKinds: readonly ElementKind[] = ['foreshadow'];
const natureLabels = {
  rule: '世界规则 / 固定设定',
  established: '已发生事实',
  planned: '未来规划',
};
type Value = { title: string; content: string; data: ElementData };
const fieldNames = Object.assign({}, ...Object.values(elementFields)) as Record<string, string>;
const textValue = (value: Value) =>
  [
    value.title,
    value.data.summary,
    natureLabels[value.data.nature],
    value.data.tags.join('、'),
    ...Object.entries(value.data.fields).map(([key, text]) => `${fieldNames[key] ?? key}：${text}`),
    value.content,
  ]
    .filter(Boolean)
    .join('\n\n');
function initialData(kind: ElementKind) {
  return elementDataSchema.parse({
    nature: ['master_outline', 'timeline_event', 'foreshadow'].includes(kind) ? 'planned' : 'rule',
  });
}

function ElementForm({
  formKey,
  kind,
  initial,
  busy,
  targets,
  onSave,
  onDirty,
  baseVersionId,
  onReset,
}: {
  formKey: string;
  kind: ElementKind;
  initial: Value;
  busy: boolean;
  targets: { id: string; title: string }[];
  onSave(value: Value): Promise<void>;
  onDirty(dirty: boolean): void;
  baseVersionId: string | null;
  onReset(): void;
}) {
  const [value, setValue] = useState(initial);
  const [tagsText, setTagsText] = useState(initial.data.tags.join('，'));
  const [recovered, setRecovered] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [linkTarget, setLinkTarget] = useState('');
  const [linkLabel, setLinkLabel] = useState('关联');
  const [linkNature, setLinkNature] = useState<ElementData['nature']>('planned');
  const [stale, setStale] = useState(false);
  const [addedFields, setAddedFields] = useState<string[]>([]);
  const initialRef = useRef(initial);
  const baseRef = useRef(baseVersionId);
  const dirty = JSON.stringify(value) !== JSON.stringify(initialRef.current);
  const storageKey = `lingma:element-draft:${formKey}`;
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as { baseVersionId: string | null; value: Value };
        const data = elementDataSchema.parse(parsed.value.data);
        if (typeof parsed.value.title === 'string' && typeof parsed.value.content === 'string') {
          setValue({ ...parsed.value, data });
          setTagsText(data.tags.join('，'));
          setRecovered(true);
          if (parsed.baseVersionId !== baseVersionId) setStale(true);
        }
      }
    } catch {
      setDraftError('浏览器草稿恢复不可用，请及时保存并保持页面打开。');
    }
  }, [storageKey, baseVersionId]);
  useEffect(() => {
    onDirty(dirty);
    try {
      if (dirty)
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ baseVersionId: baseRef.current, value }),
        );
      else sessionStorage.removeItem(storageKey);
    } catch {
      setDraftError('浏览器草稿保存失败，请立即保存到服务端。');
    }
  }, [dirty, onDirty, storageKey, value]);
  useEffect(() => {
    if (baseRef.current === baseVersionId) return;
    if (dirty) {
      setStale(true);
      return;
    }
    initialRef.current = initial;
    baseRef.current = baseVersionId;
    setValue(initial);
    setTagsText(initial.data.tags.join('，'));
  }, [baseVersionId, dirty, initial]);
  const setData = (data: ElementData) => setValue((old) => ({ ...old, data }));
  const lock = (key: string) =>
    setData({
      ...value.data,
      locked: value.data.locked.includes(key)
        ? value.data.locked.filter((v) => v !== key)
        : [...value.data.locked, key],
    });
  const primaryFields =
    kind === 'worldbuilding'
      ? (worldbuildingTypes[value.data.fields.subtype ?? '总设定'] ??
        primaryElementFields.worldbuilding)
      : primaryElementFields[kind];
  const visibleFields = Object.keys(elementFields[kind]).filter(
    (key) =>
      key !== 'subtype' &&
      (primaryFields.includes(key) ||
        addedFields.includes(key) ||
        Boolean(value.data.fields[key]?.trim())),
  );
  const optionalFields = Object.entries(elementFields[kind]).filter(
    ([key]) => key !== 'subtype' && !visibleFields.includes(key),
  );
  const lockFields = {
    title: '名称',
    summary: '简述',
    content: '补充说明',
    nature: '内容性质',
    tags: '标签',
    links: '关联',
    ...Object.fromEntries(
      Object.entries(elementFields[kind]).map(([key, label]) => [`fields.${key}`, label]),
    ),
  };
  return (
    <form
      className="element-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!stale)
          void onSave(value)
            .then(() => {
              sessionStorage.removeItem(storageKey);
            })
            .catch(() => {});
      }}
    >
      {recovered && (
        <p className="muted" role="status">
          已恢复此标签页的未保存草稿。
        </p>
      )}
      {stale && (
        <p role="alert" className="error">
          草稿基准已变化，请先复制要保留的内容，再重新载入当前版本。
          <button
            type="button"
            onClick={() => {
              sessionStorage.removeItem(storageKey);
              onReset();
            }}
          >
            重新载入当前版本
          </button>
        </p>
      )}
      {draftError && (
        <p role="alert" className="error">
          {draftError}
        </p>
      )}
      <label>
        名称
        <input
          required
          maxLength={200}
          value={value.title}
          onChange={(e) => setValue({ ...value, title: e.target.value })}
        />
      </label>
      <label>
        简述
        <textarea
          rows={2}
          maxLength={4000}
          value={value.data.summary}
          onChange={(e) => setData({ ...value.data, summary: e.target.value })}
        />
      </label>
      {kind === 'worldbuilding' && (
        <label>
          设定类型
          <select
            value={value.data.fields.subtype || '总设定'}
            onChange={(change) =>
              setData({
                ...value.data,
                fields: { ...value.data.fields, subtype: change.target.value },
              })
            }
          >
            {value.data.fields.subtype && !(value.data.fields.subtype in worldbuildingTypes) && (
              <option>{value.data.fields.subtype}</option>
            )}
            {Object.keys(worldbuildingTypes).map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
      )}
      <section className="element-primary-fields" aria-label="设定内容">
        {visibleFields.map((key) => (
          <label key={key}>
            {elementFields[kind][key]}
            <textarea
              rows={key === 'sample' ? 5 : 3}
              maxLength={16000}
              value={value.data.fields[key] ?? ''}
              onChange={(change) =>
                setData({
                  ...value.data,
                  fields: { ...value.data.fields, [key]: change.target.value },
                })
              }
            />
          </label>
        ))}
      </section>
      {optionalFields.length > 0 && (
        <label className="element-add-field">
          按需添加设定字段
          <select
            value=""
            onChange={(change) => {
              if (change.target.value) {
                const key = change.target.value;
                setAddedFields((old) => [...old, key]);
              }
            }}
          >
            <option value="">＋ 选择补充字段</option>
            {optionalFields.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        补充说明（Markdown）
        <textarea
          rows={5}
          value={value.content}
          onChange={(e) => setValue({ ...value, content: e.target.value })}
        />
      </label>
      <details className="element-advanced-settings">
        <summary>高级设置：标签、内容性质与 AI 修改保护</summary>
        <label>
          标签（逗号分隔）
          <input
            value={tagsText}
            onChange={(change) => {
              setTagsText(change.target.value);
              setData({
                ...value.data,
                tags: change.target.value
                  .split(/[,，]/)
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              });
            }}
          />
        </label>
        <label>
          内容性质
          <select
            value={value.data.nature}
            onChange={(change) =>
              setData({ ...value.data, nature: change.target.value as ElementData['nature'] })
            }
          >
            {Object.entries(natureLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted fine">规划与已发生事实分开使用；确认资料不会改变其内容性质。</p>
        <fieldset className="element-lock-fields">
          <legend>保护以下内容不被 AI 改写</legend>
          {Object.entries(lockFields).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={value.data.locked.includes(key)}
                onChange={() => lock(key)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          onClick={() =>
            setData({
              ...value.data,
              locked: Object.keys(lockFields).every((key) => value.data.locked.includes(key))
                ? []
                : Object.keys(lockFields),
            })
          }
        >
          {Object.keys(lockFields).every((key) => value.data.locked.includes(key))
            ? '解除全部保护'
            : '保护全部内容'}
        </button>
      </details>
      <details open={kind === 'character' || kind === 'foreshadow'}>
        <summary>关联条目与章节</summary>
        {value.data.links.map((link, index) => (
          <div className="element-link row" key={`${link.targetId}:${link.label}:${link.nature}`}>
            <span>
              {targets.find((t) => t.id === link.targetId)?.title ?? link.targetId} · {link.label} ·{' '}
              {natureLabels[link.nature]}
            </span>
            <button
              type="button"
              onClick={() =>
                setData({ ...value.data, links: value.data.links.filter((_, i) => i !== index) })
              }
            >
              移除关联
            </button>
          </div>
        ))}
        <label>
          关联目标
          <select value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)}>
            <option value="">选择条目或章节</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          关系说明
          <input
            maxLength={200}
            value={linkLabel}
            onChange={(e) => setLinkLabel(e.target.value)}
            placeholder="例如：单方面信任，计划在高潮反转"
          />
        </label>
        <label>
          关联性质
          <select
            value={linkNature}
            onChange={(e) => setLinkNature(e.target.value as ElementData['nature'])}
          >
            {Object.entries(natureLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!linkTarget || !linkLabel.trim()}
          onClick={() => {
            setData({
              ...value.data,
              links: [
                ...value.data.links,
                { targetId: linkTarget, label: linkLabel, nature: linkNature },
              ],
            });
            setLinkTarget('');
          }}
        >
          添加关联
        </button>
      </details>
      <div className="element-save">
        <span className="muted">{dirty ? '有未保存修改' : '与已保存内容一致'}</span>
        <button className="primary" type="submit" disabled={busy || stale}>
          {busy ? '保存中…' : '保存草稿'}
        </button>
      </div>
    </form>
  );
}

export function ElementPanel({
  projectId,
  structure,
  active,
  beforeOperation,
  onChanged,
  onModels,
  onOpenDocument,
  onboarding = false,
  onFinishSetup,
  scope = 'information',
  onOpenOutline,
  initialDocumentId,
}: {
  projectId: string;
  structure: Structure;
  active: boolean;
  beforeOperation(): Promise<void>;
  onChanged(): Promise<void>;
  onModels(): void;
  onOpenDocument(id: string): void;
  onboarding?: boolean;
  onFinishSetup?(): Promise<void>;
  scope?: 'information' | 'foreshadow';
  onOpenOutline?(): void | Promise<void>;
  initialDocumentId?: string;
}) {
  const planning = scope === 'foreshadow';
  const panelKinds: readonly ElementKind[] = planning ? foreshadowKinds : basicInformationKinds;
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [entries, setEntries] = useState<ElementEntry[]>([]);
  const [jobs, setJobs] = useState<ElementGeneration[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useProjectProvider(projectId);
  const [kind, setKind] = useState<ElementKind | 'overview'>(
    planning ? 'foreshadow' : onboarding ? 'story_premise' : 'overview',
  );
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('active');
  const [tagFilter, setTagFilter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useLeaveGuard(
    dirty,
    `${planning ? '伏笔' : '基本信息'}尚未保存到服务端。离开后可在本标签页恢复草稿，请及时返回保存。`,
  );
  const [workflowSessionId, setWorkflowSessionId] = useState(() => {
    try {
      return sessionStorage.getItem(`lingma:element-workflow:${projectId}`) ?? '';
    } catch {
      return '';
    }
  });
  const informationWorkflows = useAssistantWorkflows(projectId, workflowSessionId);
  const [workflowScope, setWorkflowScope] = useState<'all' | 'current'>('all');
  const workflowChoiceMade = useRef(false);
  const basicWorkflow =
    !planning && informationWorkflows.template?.config.taskType === 'basic_information';
  useEffect(() => {
    if (planning || workflowChoiceMade.current) return;
    const version = informationWorkflows.templates
      .flatMap((template) => template.versions.slice(0, 1))
      .find((version) => version.config.taskType === 'basic_information');
    if (version) {
      workflowChoiceMade.current = true;
      informationWorkflows.setVersionId(version.id);
    }
  }, [planning, informationWorkflows.templates, informationWorkflows.setVersionId]);

  const [idea, setIdea] = useState('');
  const [preferences, setPreferences] = useState('');
  const [mode, setMode] = useState<ElementGenerationInput['mode']>('fill');
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [count, setCount] = useState(3);
  const [maxCalls, setMaxCalls] = useState(12);
  const [jobId, setJobId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [history, setHistory] = useState(false);
  const [formRevision, setFormRevision] = useState(0);
  const decisionKeys = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const setupStarted = useRef(false);
  const focusedDocument = useRef('');
  const [loaded, setLoaded] = useState(false);
  const entry = entries.find(
    (e) => e.document.id === selected && (kind === 'overview' || e.document.kind === kind),
  );
  const categoryEntries = entries.filter(
    (item) => item.document.kind === kind && item.status !== 'archived',
  );
  const categoryJobs = jobs.filter(
    (j) =>
      (kind === 'overview' && j.input.kinds.some((item) => panelKinds.includes(item))) ||
      (j.input.kinds.length === 1 && j.input.kinds[0] === kind) ||
      j.candidates.some((c) => c.kind === kind),
  );
  const job = categoryJobs.find((j) => j.id === jobId) ?? categoryJobs[0];
  const visibleCandidates =
    job?.candidates.filter(
      (c) => panelKinds.includes(c.kind) && (kind === 'overview' || c.kind === kind),
    ) ?? [];
  const candidate = visibleCandidates.find((c) => c.id === candidateId);
  const pendingCandidates = visibleCandidates.filter((c) => c.status === 'pending');
  const selectedPending = pendingCandidates.filter((c) => checked.includes(c.id));
  const allPendingChecked =
    pendingCandidates.length > 0 && selectedPending.length === pendingCandidates.length;
  const jobRunning = Boolean(job && ['queued', 'running'].includes(job.status));
  const decisionBlocked = busy || dirty || jobRunning;
  const effectiveKind =
    candidate?.kind ??
    (entry?.document.kind as ElementKind | undefined) ??
    (kind === 'overview' ? 'worldbuilding' : kind);
  const reload = useCallback(async () => {
    const [items, historyJobs, models] = await Promise.all([
      elementApi.list(projectId),
      elementApi.jobs(projectId),
      writingApi.providers(),
    ]);
    if (!mounted.current) return;
    setEntries(items);
    setJobs(historyJobs);
    setProviders(models.data);
    setLoaded(true);
    setProviderId((old) =>
      models.data.some((provider) => provider.id === old) ? old : models.data[0]?.id || '',
    );
  }, [projectId, setProviderId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    void reload().catch((e: Error) => setError(e.message));
  }, [active, reload]);
  useEffect(() => {
    if ((!onboarding && !planning) || !loaded || setupStarted.current) return;
    setupStarted.current = true;
    const first =
      panelKinds.find(
        (kind) =>
          !entries.some(
            (entry) =>
              entry.document.kind === kind &&
              entry.status !== 'archived' &&
              hasElementContent(entry),
          ),
      ) ??
      panelKinds[0] ??
      'story_premise';
    const existing = entries.find(
      (entry) => entry.document.kind === first && entry.status !== 'archived',
    );
    setKind(first);
    setSelected(existing?.document.id ?? '');
    setCreating(!existing);
  }, [onboarding, planning, loaded, entries, panelKinds]);
  useEffect(() => {
    if (!loaded || dirty || !initialDocumentId || focusedDocument.current === initialDocumentId)
      return;
    const target = entries.find(
      (item) =>
        item.document.id === initialDocumentId &&
        panelKinds.includes(item.document.kind as ElementKind),
    );
    if (!target) return;
    focusedDocument.current = initialDocumentId;
    setKind(target.document.kind as ElementKind);
    setSelected(target.document.id);
    setCandidateId('');
    setCreating(false);
    if (target.status === 'archived') setFilter('archived');
  }, [loaded, dirty, initialDocumentId, entries, panelKinds]);
  const activeJobs = jobs
    .filter((j) => ['queued', 'running'].includes(j.status))
    .map((j) => j.id)
    .join(',');
  useEffect(() => {
    if (!activeJobs) return;
    let stopped = false;
    const update = () => {
      if (!stopped) void reload().catch((e: Error) => setError(e.message));
    };
    const streams = activeJobs.split(',').map((id) => {
      const stream = new EventSource(`/api/v1/element-generations/${id}/events`);
      stream.addEventListener('change', update);
      stream.onerror = update;
      return stream;
    });
    // Snapshot fallback also covers an expired cursor or a lost final event.
    const timer = window.setInterval(update, 4000);
    return () => {
      stopped = true;
      for (const stream of streams) stream.close();
      clearInterval(timer);
    };
  }, [activeJobs, reload]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      throw e;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const act = (action: () => Promise<void>) => {
    void run(action).catch(() => {});
  };
  function choose(id: string, nextKind?: ElementKind) {
    if (dirty) {
      setError('请先保存当前修改，再切换条目');
      return;
    }
    if (nextKind && !panelKinds.includes(nextKind)) {
      onOpenDocument(id);
      return;
    }
    setSelected(id);
    setCandidateId('');
    setCreating(false);
    if (nextKind && nextKind !== kind) {
      setKind(nextKind);
      if (
        nextKind !== 'worldbuilding' &&
        informationWorkflows.template?.config.taskType === 'worldbuilding'
      )
        informationWorkflows.setVersionId('');
      setJobId('');
      setChecked([]);
    }
    setDirty(false);
  }
  function chooseKind(nextKind: ElementKind | 'overview') {
    if (dirty) {
      setError('请先保存当前要素草稿，再切换分类');
      return;
    }
    setKind(nextKind);
    if (
      nextKind !== 'worldbuilding' &&
      informationWorkflows.template?.config.taskType === 'worldbuilding'
    )
      informationWorkflows.setVersionId('');
    const existing =
      nextKind !== 'overview'
        ? entries.find((entry) => entry.document.kind === nextKind && entry.status !== 'archived')
        : undefined;
    choose(existing?.document.id ?? '');
    if (nextKind !== 'overview' && (onboarding || singletonKinds.includes(nextKind)))
      setCreating(!existing);
    setQuery('');
    setFilter('active');
    setTagFilter('');
    setJobId('');
    setChecked([]);
  }
  async function generateBasicInformation(
    requestScope: 'kind' | 'target',
    replacement: boolean,
    requestedMode?: ElementGenerationInput['mode'],
  ) {
    if (dirty) throw new Error('请先保存当前修改，再运行基础信息编排');
    if (informationWorkflows.active) throw new Error('请先处理或结束当前编排');
    if (!providerId || !providers.some((provider) => provider.id === providerId)) {
      onModels();
      throw new Error('请先选择可用模型，已填写的灵感会保留');
    }
    const whole = workflowScope === 'all' && !replacement && requestedMode !== 'create';
    const kinds = whole ? [...basicInformationKinds] : isBasicInformationKind(kind) ? [kind] : [];
    if (!kinds.length) throw new Error('请先选择要完善的基础信息分类');
    if (kinds.includes('character') && (!Number.isInteger(count) || count < 1 || count > 10))
      throw new Error('人物目标数须为 1 到 10 的整数');
    const generationMode = replacement ? 'replace' : (requestedMode ?? mode);
    const currentEntries = entries.filter(
      (item) => item.status !== 'archived' && kinds.some((kind) => item.document.kind === kind),
    );
    if (
      generationMode === 'create' &&
      currentEntries.some((item) => singletonKinds.includes(item.document.kind as ElementKind))
    )
      throw new Error('故事定位和文风已有设置，请选择补全或替代候选，或切换到可新增条目的分类');
    const targets =
      generationMode === 'create'
        ? []
        : !whole && requestScope === 'target' && entry
          ? [entry]
          : currentEntries;
    if (targets.length > 30) throw new Error('当前条目较多，请切换到当前分类或当前条目分次完善');
    if (
      generationMode === 'extract' &&
      !sourceIds.length &&
      !entries.some((item) => item.status !== 'archived' && hasElementContent(item))
    )
      throw new Error('整理已有资料时，请先选择实际来源文档');
    await beforeOperation();
    let session = workflowSessionId;
    if (!session) {
      session = (await writingApi.session(projectId, '基础信息编排', null)).id;
      setWorkflowSessionId(session);
      try {
        sessionStorage.setItem(`lingma:element-workflow:${projectId}`, session);
      } catch {
        /* Optional navigation state. */
      }
    }
    await informationWorkflows.start(
      workflowInputSchema.parse({
        projectId,
        sessionId: session,
        taskType: 'basic_information',
        mode: generationMode,
        elementKinds: kinds,
        elementTargets: targets.map((item) => ({
          documentId: item.document.id,
          baseVersionId: item.version.id,
        })),
        templateVersionId: informationWorkflows.versionId,
        providerConfigId: providerId,
        input: [
          idea.trim() ||
            '统筹完善基础信息，保留已有设定，补齐缺项，使主题、世界、人物、冲突和文风相互一致。',
          `本次范围：${kinds.map((kind) => elementLabels[kind]).join('、')}。`,
          kinds.includes('character')
            ? `人物目标数：${count}，结合已有角色安排，每个人物单独成条目。`
            : '',
          preferences,
        ]
          .filter(Boolean)
          .join('\n'),
        selectedVersionIds: sourceIds,
        allowFutureOutline: true,
      }),
    );
  }
  async function generate(
    scope: 'kind' | 'target',
    replacement = false,
    requestedMode?: ElementGenerationInput['mode'],
  ) {
    if (basicWorkflow) {
      await generateBasicInformation(scope, replacement, requestedMode);
      return;
    }
    const generationKind = scope === 'target' ? entry?.document.kind : kind;
    if (!generationKind || !isElementKind(generationKind))
      throw new Error('请先选择要生成的要素分类或条目');
    if (
      entry &&
      singletonKinds.includes(generationKind) &&
      !replacement &&
      (requestedMode ?? mode) === 'create'
    )
      throw new Error('作品定位与文风直接维护当前设置，请选择补全或生成替代候选');
    if (dirty) throw new Error('请先保存当前要素或候选草稿，再生成');
    if (!providerId) {
      onModels();
      throw new Error('请先配置模型，已填写的灵感会保留');
    }
    await beforeOperation();
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) throw new Error('所选模型已失效，请刷新模型列表');
    const input = singleElementGenerationInputSchema.parse({
      providerConfigId: providerId,
      modelId: provider.config.modelId,
      idea,
      preferences,
      kinds: [generationKind],
      mode: replacement ? 'replace' : (requestedMode ?? mode),
      ...(scope === 'target' && entry && (replacement || (requestedMode ?? mode) !== 'create')
        ? { targetDocumentId: entry.document.id }
        : {}),
      selectedVersionIds: sourceIds,
      useDrafts: true,
      characterCount: count,
      maxCalls,
    });
    if (
      input.mode === 'extract' &&
      !sourceIds.length &&
      !entries.some((e) => e.status !== 'archived' && hasElementContent(e))
    )
      throw new Error('整理已有资料时，请先选择实际来源文档');
    if (
      informationWorkflows.template?.config.taskType === 'worldbuilding' &&
      generationKind === 'worldbuilding'
    ) {
      if (informationWorkflows.active) throw new Error('请先处理或结束当前编排');
      let session = workflowSessionId;
      if (!session) {
        session = (await writingApi.session(projectId, '世界观编排', null)).id;
        setWorkflowSessionId(session);
        try {
          sessionStorage.setItem(`lingma:element-workflow:${projectId}`, session);
        } catch {
          /* Optional navigation state. */
        }
      }
      const target = input.targetDocumentId
        ? entries.find((item) => item.document.id === input.targetDocumentId)
        : null;
      await informationWorkflows.start(
        workflowInputSchema.parse({
          projectId,
          sessionId: session,
          taskType: 'worldbuilding',
          targetDocumentId: target?.document.id ?? null,
          baseVersionId: target?.version.id ?? null,
          mode: target ? input.mode : input.mode === 'extract' ? 'extract' : 'create',
          templateVersionId: informationWorkflows.versionId,
          providerConfigId: providerId,
          input: [idea.trim() || '完善世界观，保持既有设定一致。', preferences]
            .filter(Boolean)
            .join('\n'),
          selectedVersionIds: sourceIds,
          allowFutureOutline: true,
        }),
      );
      return;
    }
    const preview = await elementApi.preview(projectId, input);
    const created = await elementApi.start(
      projectId,
      { ...input, expectedHash: preview.hash },
      crypto.randomUUID(),
    );
    setJobs((old) => [created, ...old.filter((j) => j.id !== created.id)]);
    setJobId(created.id);
    setCandidateId('');
    setChecked([]);
  }
  async function save(value: Value) {
    await run(async () => {
      await beforeOperation();
      if (candidate && job) {
        await elementApi.edit(candidate, value);
        setCandidateId(candidate.id);
      } else {
        const saved =
          entry && !creating
            ? await elementApi.save(
                entry.document.id,
                entry.version.id,
                value.title,
                value.content,
                value.data,
              )
            : await elementApi.create(
                projectId,
                effectiveKind,
                value.title,
                value.content,
                value.data,
              );
        setSelected(saved.document.id);
        setCreating(false);
        setKind(saved.document.kind as ElementKind);
      }
      try {
        sessionStorage.removeItem(
          `lingma:element-draft:${projectId}:${candidate?.id ?? entry?.document.id ?? `new:${effectiveKind}`}`,
        );
      } catch {
        /* Server save succeeded; browser recovery is best effort. */
      }
      setDirty(false);
      await reload();
      setFormRevision((old) => old + 1);
      await onChanged();
    });
  }
  async function decide(action: 'accept' | 'reject', selectedCandidates: ElementCandidate[]) {
    if (!job || !selectedCandidates.length) throw new Error('请先勾选待审候选');
    if (dirty) throw new Error('请先保存候选改稿');
    if (jobRunning) throw new Error('请等待生成完成后再处理候选');
    const requestedIds = new Set(selectedCandidates.map((c) => c.id));
    const currentCandidates = visibleCandidates.filter(
      (c) => requestedIds.has(c.id) && c.status === 'pending',
    );
    if (currentCandidates.length !== requestedIds.size)
      throw new Error('候选状态已变化，请重新查看待采用候选');
    await beforeOperation();
    const signature = JSON.stringify([
      job.id,
      action,
      currentCandidates.map((c) => [c.id, c.revision]),
    ]);
    if (!decisionKeys.current.has(signature))
      decisionKeys.current.set(signature, crypto.randomUUID());
    let result: ElementGeneration;
    try {
      result = await elementApi.decide(
        job.id,
        action,
        currentCandidates,
        decisionKeys.current.get(signature) as string,
      );
    } catch (cause) {
      await reload().catch(() => {});
      throw cause;
    }
    setJobs((old) => old.map((j) => (j.id === result.id ? result : j)));
    setChecked([]);
    setCandidateId('');
    setDirty(false);
    const adopted = result.candidates.find(
      (c) => requestedIds.has(c.id) && c.status === 'accepted' && c.acceptedDocumentId,
    );
    if (action === 'accept' && adopted?.acceptedDocumentId) {
      setSelected(adopted.acceptedDocumentId);
      setKind(adopted.kind);
      setCreating(false);
    } else {
      const next = result.candidates.find(
        (c) =>
          c.status === 'pending' &&
          panelKinds.includes(c.kind) &&
          (kind === 'overview' || c.kind === kind),
      );
      if (next) {
        setSelected('');
        setCreating(false);
        setCandidateId(next.id);
      }
    }
    setFormRevision((value) => value + 1);
    await reload();
    await onChanged();
  }
  function reviewCandidate(item: ElementCandidate) {
    if (busy) return;
    if (dirty) {
      setError('请先保存当前改稿，再查看其他候选或已采用的要素');
      return;
    }
    setKind(item.kind);
    setJobId(item.jobId);
    setChecked([]);
    if (item.status === 'accepted' && item.acceptedDocumentId) {
      setSelected(item.acceptedDocumentId);
      setCandidateId('');
    } else {
      setCandidateId(item.id);
      setSelected('');
    }
    setCreating(false);
  }
  const list = entries.filter(
    (e) =>
      panelKinds.includes(e.document.kind as ElementKind) &&
      (kind === 'overview' || e.document.kind === kind) &&
      (filter === 'active' ? e.status !== 'archived' : !filter || e.status === filter) &&
      (!tagFilter || e.data.tags.includes(tagFilter)) &&
      (!query ||
        `${e.document.title}\n${e.data.summary}\n${e.version.content}\n${Object.values(e.data.fields).join('\n')}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const targets = [
    ...structure.documents
      .filter((d) => d.id !== selected)
      .map((d) => ({ id: d.id, title: d.title })),
    ...(job?.candidates
      .filter((c) => c.id !== candidateId && c.status !== 'rejected')
      .map((c) => ({ id: c.tempId, title: `候选：${c.title}` })) ?? []),
  ];
  const currentValue = candidate
    ? { title: candidate.title, content: candidate.content, data: candidate.data }
    : entry && !creating
      ? { title: entry.document.title, content: entry.version.content, data: entry.data }
      : {
          title:
            singletonKinds.includes(effectiveKind) || (onboarding && effectiveKind !== 'character')
              ? elementLabels[effectiveKind]
              : '',
          content: '',
          data: initialData(effectiveKind),
        };
  function startCreating(nextKind: ElementKind) {
    if (dirty) {
      setError('请先保存当前修改，再新增设定');
      return;
    }
    if (singletonKinds.includes(nextKind)) {
      const existing = entries.find(
        (item) => item.document.kind === nextKind && item.status !== 'archived',
      );
      if (existing) {
        choose(existing.document.id, nextKind);
        return;
      }
    }
    setKind(nextKind);
    setCreating(true);
    setSelected('');
    setCandidateId('');
    setChecked([]);
    setJobId('');
  }
  return (
    <section
      className={`element-panel element-focused-panel${assistantOpen ? ' has-assistant' : ''}`}
      aria-label={planning ? '伏笔与悬念管理' : '基本信息管理'}
      hidden={!active}
    >
      <header className="element-header">
        <div>
          <p className="eyebrow">{structure.project.title} · 故事的骨架</p>
          <h1>{planning ? '伏笔与悬念' : onboarding ? '长篇基本信息' : '基本信息'}</h1>
          <p className="muted">
            {planning
              ? '安排埋设、关联事件与章节，跟踪回收进度。'
              : '设定作品、人物与世界，剧情发展在大纲中统一规划。'}
          </p>
        </div>
        <div className="row element-header-actions">
          {onOpenOutline && (
            <button
              type="button"
              disabled={busy || dirty}
              onClick={() =>
                act(async () => {
                  await onOpenOutline();
                })
              }
            >
              {planning ? (
                <ArrowLeft size={14} aria-hidden="true" />
              ) : (
                <BookOpen size={14} aria-hidden="true" />
              )}
              {planning ? '返回故事大纲' : '规划故事大纲'}
            </button>
          )}
          <details className="element-create-menu">
            <summary>
              <Plus size={14} aria-hidden="true" />
              {planning ? '新增伏笔' : '添加设定'}
            </summary>
            <div>
              {panelKinds.map((item) => (
                <button
                  type="button"
                  key={item}
                  disabled={busy || dirty}
                  onClick={(event) => {
                    startCreating(item);
                    event.currentTarget.closest('details')?.removeAttribute('open');
                  }}
                >
                  {singletonKinds.includes(item) ? '编辑' : '新增'}
                  {elementLabels[item]}
                </button>
              ))}
            </div>
          </details>
          <button
            type="button"
            aria-expanded={assistantOpen}
            aria-controls="element-ai-assistant"
            onClick={() => setAssistantOpen((old) => !old)}
          >
            <Sparkles size={14} aria-hidden="true" />
            {assistantOpen ? '收起 AI 助手' : 'AI 助手'}
          </button>
        </div>
      </header>
      {onboarding && (
        <section className="element-onboarding" aria-label="长篇要素引导">
          <div className="element-onboarding-copy">
            <div className="element-onboarding-heading">
              <strong>
                {kind === 'overview'
                  ? '先搭好故事的骨架'
                  : `第 ${panelKinds.indexOf(kind) + 1} / ${panelKinds.length} 项：${elementLabels[kind]}`}
              </strong>
              <span className="muted fine">
                已填写{' '}
                {
                  panelKinds.filter((kind) =>
                    entries.some(
                      (entry) =>
                        entry.document.kind === kind &&
                        entry.status !== 'archived' &&
                        hasElementContent(entry),
                    ),
                  ).length
                }{' '}
                / {panelKinds.length} 类
              </span>
              {dirty && <span className="element-setup-unsaved">请先保存当前修改</span>}
            </div>
            <p className="muted fine">按需填写，也可展开 AI 助手补全；已有草稿会保留。</p>
          </div>
          <div className="row">
            {kind !== 'overview' && panelKinds.indexOf(kind) > 0 && (
              <button
                type="button"
                disabled={busy || dirty}
                onClick={() => chooseKind(panelKinds[panelKinds.indexOf(kind) - 1] as ElementKind)}
              >
                上一项
              </button>
            )}
            {kind !== panelKinds.at(-1) && (
              <button
                type="button"
                disabled={busy || dirty}
                onClick={() =>
                  chooseKind(
                    panelKinds[
                      (kind === 'overview' ? -1 : panelKinds.indexOf(kind)) + 1
                    ] as ElementKind,
                  )
                }
              >
                下一项
              </button>
            )}
            <button
              type="button"
              className="primary"
              title={
                kind === panelKinds.at(-1)
                  ? '完成基本信息，规划大纲'
                  : '稍后完善基本信息，先规划大纲'
              }
              disabled={busy || dirty}
              onClick={() =>
                act(async () => {
                  if (onFinishSetup) await onFinishSetup();
                })
              }
            >
              规划大纲
            </button>
          </div>
        </section>
      )}
      {error && (
        <div className="global-error" role="alert">
          {error}
          <button type="button" onClick={() => act(reload)}>
            刷新资料
          </button>
          <button type="button" onClick={() => setError('')}>
            关闭提示
          </button>
        </div>
      )}
      <div className="element-layout element-focused-layout">
        <div className="element-navigation">
          <nav className="element-nav" aria-label="要素分类">
            <button
              type="button"
              aria-current={kind === 'overview' ? 'page' : undefined}
              onClick={() => chooseKind('overview')}
            >
              总览
            </button>
            {panelKinds.map((k) => (
              <button
                type="button"
                key={k}
                className={kind === k ? 'selected' : ''}
                aria-current={kind === k ? 'page' : undefined}
                onClick={() => chooseKind(k)}
              >
                <span>{elementLabels[k]}</span>
                <small>
                  {entries.filter((e) => e.document.kind === k && e.status === 'confirmed').length}{' '}
                  已确认 ·{' '}
                  {entries.filter((e) => e.document.kind === k && e.status === 'draft').length} 草稿
                </small>
              </button>
            ))}
          </nav>
          <div className="element-browser">
            <details className="element-search-filters">
              <summary>
                搜索与筛选{query || filter !== 'active' || tagFilter ? ' · 已筛选' : ''}
              </summary>
              <div className="row">
                <label>
                  搜索要素
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="名称、摘要或字段"
                  />
                </label>
                <label>
                  采用状态
                  <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="active">使用中的设定</option>
                    <option value="">全部状态</option>
                    {(['draft', 'confirmed', 'archived'] as const).map((s) => (
                      <option key={s} value={s}>
                        {statusLabels[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  标签筛选
                  <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                    <option value="">全部标签</option>
                    {[...new Set(entries.flatMap((e) => e.data.tags))].map((tag) => (
                      <option key={tag}>{tag}</option>
                    ))}
                  </select>
                </label>
              </div>
            </details>
            {!list.length && (
              <p className="muted">暂无匹配要素。可以从一句灵感生成，也可以手动新建。</p>
            )}
            <div className="element-list">
              {list.map((e) => {
                return (
                  <button
                    type="button"
                    key={e.document.id}
                    className={`element-card ${selected === e.document.id ? 'selected' : ''}`}
                    onClick={() => choose(e.document.id, e.document.kind as ElementKind)}
                  >
                    <span className="row">
                      <strong>{e.document.title}</strong>
                      <small>{statusLabels[e.status]}</small>
                    </span>
                    <span>{e.data.summary || e.version.content.slice(0, 90) || '暂无摘要'}</span>
                    <small>
                      {elementLabels[e.document.kind as ElementKind]} ·{' '}
                      {
                        entries.filter((other) =>
                          other.data.links.some((link) => link.targetId === e.document.id),
                        ).length
                      }{' '}
                      处引用
                    </small>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <aside className="element-detail" aria-label="要素详情">
          {kind === 'overview' && (
            <div className="element-overview">
              {panelKinds.map((k) => (
                <button
                  type="button"
                  className="element-card"
                  key={k}
                  onClick={() => chooseKind(k)}
                >
                  <strong>{elementLabels[k]}</strong>
                  <span>
                    {entries.filter((e) => e.document.kind === k && e.status !== 'archived').length}{' '}
                    条资料
                  </span>
                  <small>
                    {entries.some((e) => e.document.kind === k && e.status === 'confirmed')
                      ? '已有确认资料，仍可继续补全'
                      : '尚无确认资料，可手动创建或 AI 生成'}
                  </small>
                </button>
              ))}
            </div>
          )}

          {singletonKinds.includes(effectiveKind) && categoryEntries.length > 1 && (
            <nav
              className="element-entry-switcher"
              aria-label={kind === 'character' ? '角色列表' : '同类要素列表'}
            >
              <div className="element-entry-switcher-heading">
                <strong>已有设置</strong>
                <span>
                  {categoryEntries.length} {kind === 'character' ? '个角色' : '项'}
                </span>
                <span className="element-entry-switcher-hint">点击名称切换查看</span>
              </div>
              <div className="element-entry-switcher-items">
                {categoryEntries.map((item) => {
                  const current = !creating && !candidateId && selected === item.document.id;
                  return (
                    <button
                      type="button"
                      key={item.document.id}
                      aria-pressed={current}
                      disabled={busy}
                      title={`${item.document.title} · ${statusLabels[item.status]}`}
                      onClick={(event) => {
                        if (current) return;
                        if (dirty) {
                          setError('请先保存当前改稿，再切换查看其他条目');
                          return;
                        }
                        setError('');
                        setChecked([]);
                        choose(item.document.id, item.document.kind as ElementKind);
                        event.currentTarget.closest('.element-detail')?.scrollTo({ top: 0 });
                      }}
                    >
                      <span>{item.document.title}</span>
                      <small>{statusLabels[item.status]}</small>
                    </button>
                  );
                })}
              </div>
            </nav>
          )}
          {kind !== 'overview' && (candidate || entry || creating) ? (
            <>
              <h2>
                {candidate
                  ? `候选：${candidate.title}`
                  : entry && !creating
                    ? entry.document.title
                    : `新建${elementLabels[effectiveKind]}`}
              </h2>
              {creating && (
                <label>
                  要素分类
                  <select
                    value={effectiveKind}
                    onChange={(e) => startCreating(e.target.value as ElementKind)}
                  >
                    {panelKinds.map((k) => (
                      <option key={k} value={k}>
                        {elementLabels[k]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {candidate && (
                <>
                  <p>{candidate.reason}</p>
                  {candidate.status === 'pending' && (
                    <div className="row element-current-candidate-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={decisionBlocked}
                        onClick={() => act(() => decide('accept', [candidate]))}
                      >
                        采用此候选
                      </button>
                      <button
                        type="button"
                        disabled={decisionBlocked}
                        onClick={() => act(() => decide('reject', [candidate]))}
                      >
                        拒绝此候选
                      </button>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          dirty ||
                          Boolean(job && ['queued', 'running'].includes(job.status))
                        }
                        onClick={() =>
                          act(async () => {
                            await beforeOperation();
                            await elementApi.regenerate(candidate, crypto.randomUUID());
                            await reload();
                          })
                        }
                      >
                        重新生成此候选
                      </button>
                    </div>
                  )}
                  {candidate.openQuestions.length > 0 && (
                    <ul>
                      {candidate.openQuestions.map((q) => (
                        <li key={q}>{q}</li>
                      ))}
                    </ul>
                  )}
                  {candidate.targetDocumentId && (
                    <details>
                      <summary>与正式资料对比</summary>
                      <DiffView
                        before={(() => {
                          const target = entries.find(
                            (e) => e.document.id === candidate.targetDocumentId,
                          );
                          return target
                            ? textValue({
                                title: target.document.title,
                                content: target.version.content,
                                data: target.data,
                              })
                            : '目标已不可用';
                        })()}
                        after={textValue(currentValue)}
                      />
                    </details>
                  )}
                  <p className="muted fine">
                    来源：{candidate.data.source === 'extracted' ? '正文/资料提取' : 'AI 创作'} ·
                    修订 {candidate.revision} · {statusLabels[candidate.status]}
                  </p>
                </>
              )}
              {entry && !creating && (
                <>
                  <p className="muted">
                    {statusLabels[entry.status]} · 当前版本 {entry.version.versionNo}
                    {entry.confirmedVersionId && entry.confirmedVersionId !== entry.version.id
                      ? ' · 写作默认沿用此前已确认版本'
                      : ''}
                  </p>
                  <div className="row element-entry-actions">
                    {entry.confirmedVersionId !== entry.version.id && (
                      <button
                        type="button"
                        disabled={
                          busy ||
                          dirty ||
                          entry.status === 'archived' ||
                          entry.confirmedVersionId === entry.version.id
                        }
                        onClick={() =>
                          act(async () => {
                            await elementApi.confirm(entry.document.id, entry.version.id);
                            await reload();
                            await onChanged();
                          })
                        }
                      >
                        {entry.confirmedVersionId === entry.version.id
                          ? '当前版本已确认'
                          : '确认用于写作'}
                      </button>
                    )}
                    <button type="button" disabled={busy} onClick={() => setAssistantOpen(true)}>
                      <Sparkles size={13} aria-hidden="true" /> AI 完善
                    </button>
                    <details className="element-more-actions">
                      <summary>更多操作</summary>
                      <div>
                        <button
                          type="button"
                          disabled={busy || dirty}
                          onClick={() =>
                            act(async () => {
                              await beforeOperation();
                              await elementApi.save(
                                entry.document.id,
                                entry.version.id,
                                entry.document.title,
                                entry.version.content,
                                { ...entry.data, archived: !entry.data.archived },
                              );
                              await reload();
                              await onChanged();
                              setFormRevision((v) => v + 1);
                            })
                          }
                        >
                          {entry.data.archived ? '恢复归档' : '归档'}
                        </button>
                        <button
                          type="button"
                          disabled={busy || dirty}
                          onClick={() => setHistory(true)}
                        >
                          版本历史
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            act(async () => {
                              const copied = await elementApi.create(
                                projectId,
                                entry.document.kind as ElementKind,
                                `${entry.document.title}（副本）`.slice(0, 200),
                                entry.version.content,
                                { ...entry.data, archived: false, source: 'manual' },
                              );
                              await reload();
                              choose(copied.document.id);
                              await onChanged();
                            })
                          }
                        >
                          复制
                        </button>
                      </div>
                    </details>
                  </div>
                </>
              )}
              {!candidate || candidate.status === 'pending' ? (
                <ElementForm
                  key={`${candidate?.id ?? entry?.document.id ?? `new:${effectiveKind}`}:${formRevision}`}
                  formKey={`${projectId}:${candidate?.id ?? entry?.document.id ?? `new:${effectiveKind}`}`}
                  kind={effectiveKind}
                  initial={currentValue}
                  busy={busy}
                  targets={targets}
                  onSave={save}
                  onDirty={setDirty}
                  baseVersionId={
                    candidate ? String(candidate.revision) : (entry?.version.id ?? null)
                  }
                  onReset={() => setFormRevision((v) => v + 1)}
                />
              ) : (
                <pre className="element-readonly">{textValue(currentValue)}</pre>
              )}
              <details>
                <summary>来源与引用</summary>
                {currentValue.data.sources.length ? (
                  currentValue.data.sources.map((s) => (
                    <p key={`${s.versionId}:${s.from}`}>
                      <button type="button" onClick={() => onOpenDocument(s.documentId)}>
                        {structure.documents.find((d) => d.id === s.documentId)?.title ??
                          s.documentId}
                      </button>
                      <small>
                        {' '}
                        · 版本 {s.versionId} · {s.from}—{s.to}
                      </small>
                    </p>
                  ))
                ) : (
                  <p className="muted">暂无正文依据。AI 创作不能作为既有事实的证据。</p>
                )}
              </details>
              {entry && (
                <details>
                  <summary>关联与反向引用</summary>
                  {entries
                    .filter(
                      (e) =>
                        entry.data.links.some((l) => l.targetId === e.document.id) ||
                        e.data.links.some((l) => l.targetId === entry.document.id),
                    )
                    .map((e) => (
                      <button
                        type="button"
                        key={e.document.id}
                        onClick={() => choose(e.document.id, e.document.kind as ElementKind)}
                      >
                        {e.document.title} · {statusLabels[e.status]}
                      </button>
                    ))}
                </details>
              )}
            </>
          ) : (
            <div className="empty">
              <p className="eyebrow">世界、人物、冲突</p>
              <h2>
                {kind === 'overview'
                  ? '把故事的基础设定放在一起。'
                  : `开始整理${elementLabels[effectiveKind]}`}
              </h2>
              <p className="muted">
                {kind === 'overview'
                  ? '作品定位和文风直接编辑，人物、地点与组织按条目整理。总纲、时间线与伏笔从大纲页进入。'
                  : '选择已有条目，或添加新的设定；所有字段均可按需填写。'}
              </p>
              {kind !== 'overview' && (
                <button
                  type="button"
                  disabled={busy || dirty}
                  onClick={() => startCreating(effectiveKind)}
                >
                  <Plus size={14} aria-hidden="true" /> 添加{elementLabels[effectiveKind]}
                </button>
              )}
            </div>
          )}
        </aside>
        {assistantOpen && (
          <aside
            id="element-ai-assistant"
            className="element-generation-sidebar"
            aria-label="AI 要素生成"
          >
            <div className="element-assistant-heading">
              <h2>AI 助手</h2>
              <button
                type="button"
                aria-label="收起 AI 助手"
                onClick={() => setAssistantOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <p className="element-generation-target">
              生成目标：
              {basicWorkflow && workflowScope === 'all'
                ? '整套基础信息'
                : kind === 'overview'
                  ? '请先选择左侧分类'
                  : elementLabels[kind]}
            </p>
            {!planning && (
              <>
                <div className="element-workflow-selector chat-options">
                  <span>执行方式</span>
                  <ExecutionModeMenu
                    templates={informationWorkflows.templates.filter(
                      (template) => template.versions[0]?.config.taskType === 'basic_information',
                    )}
                    value={informationWorkflows.versionId}
                    onChange={(value) => {
                      workflowChoiceMade.current = true;
                      informationWorkflows.setVersionId(value);
                    }}
                  />
                </div>
                {basicWorkflow && (
                  <div
                    className="element-workflow-scope"
                    role="group"
                    aria-label="基础信息编排范围"
                  >
                    <button
                      type="button"
                      aria-pressed={workflowScope === 'all'}
                      onClick={() => setWorkflowScope('all')}
                    >
                      整套基础信息
                    </button>
                    <button
                      type="button"
                      aria-pressed={workflowScope === 'current'}
                      disabled={kind === 'overview'}
                      onClick={() => setWorkflowScope('current')}
                    >
                      当前分类 / 条目
                    </button>
                    <p className="muted fine">
                      {workflowScope === 'all'
                        ? '统一完善主题、世界、人物、核心冲突和文风，审校后按分类采用。'
                        : '复用同一套编排，只完善当前分类或条目。'}
                    </p>
                  </div>
                )}
                {informationWorkflows.error && <p role="alert">{informationWorkflows.error}</p>}
              </>
            )}
            <div className="element-generator">
              <label>
                希望补充什么？
                <textarea
                  rows={3}
                  value={idea}
                  onChange={(change) => setIdea(change.target.value)}
                  placeholder={
                    basicWorkflow
                      ? '例如：以高中社团日常为背景，完善主题、场景、人物关系、核心冲突与轻松的叙事风格。'
                      : '例如：丰富这所学校的日常场景，保留现有时代与人物设定。'
                  }
                />
              </label>
              <p className="muted fine">参考作品已有设定与所选资料生成，审阅后再采用。</p>
              <div className="element-generation-actions">
                <button
                  className="primary"
                  type="button"
                  disabled={
                    busy ||
                    dirty ||
                    (kind === 'overview' && !(basicWorkflow && workflowScope === 'all')) ||
                    Boolean(informationWorkflows.active) ||
                    jobs.some((item) => ['queued', 'running'].includes(item.status))
                  }
                  onClick={() => act(() => generate(entry ? 'target' : 'kind'))}
                >
                  {basicWorkflow
                    ? workflowScope === 'all'
                      ? '运行基础信息编排'
                      : `编排完善${kind === 'overview' ? '基础信息' : elementLabels[kind]}`
                    : kind === 'overview'
                      ? '先选择要完善的分类'
                      : entry
                        ? mode === 'replace'
                          ? '生成替代候选'
                          : mode === 'extract'
                            ? '整理当前条目'
                            : '完善当前条目'
                        : `生成${elementLabels[kind]}`}
                </button>
                {entry &&
                  !singletonKinds.includes(effectiveKind) &&
                  !(basicWorkflow && workflowScope === 'all') && (
                    <button
                      type="button"
                      disabled={
                        busy ||
                        dirty ||
                        jobs.some((item) => ['queued', 'running'].includes(item.status))
                      }
                      onClick={() => act(() => generate('kind', false, 'create'))}
                    >
                      新增设定
                    </button>
                  )}
              </div>
              <details className="element-ai-settings">
                <summary>生成设置与参考资料</summary>
                <label>
                  模型
                  <select
                    value={providerId}
                    onChange={(change) => setProviderId(change.target.value)}
                  >
                    <option value="">请选择模型</option>
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.config.name} · {provider.config.modelId}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={onModels}>
                  模型设置
                </button>
                <label>
                  生成方式
                  <select
                    value={mode}
                    onChange={(change) =>
                      setMode(change.target.value as ElementGenerationInput['mode'])
                    }
                  >
                    <option value="fill">只补缺项（保留已有设定）</option>
                    <option value="create">创作新增条目</option>
                    <option value="replace">生成替代候选（保留锁定字段）</option>
                    <option value="extract">整理已有资料（必须有依据）</option>
                  </select>
                </label>
                {entry && !(basicWorkflow && workflowScope === 'all') && (
                  <button
                    type="button"
                    disabled={busy || dirty || jobRunning}
                    onClick={() => act(() => generate('target', true))}
                  >
                    为当前条目生成替代候选
                  </button>
                )}
                <label>
                  偏好与禁区
                  <textarea
                    rows={2}
                    value={preferences}
                    onChange={(change) => setPreferences(change.target.value)}
                  />
                </label>
                {(kind === 'character' || (basicWorkflow && workflowScope === 'all')) && (
                  <label>
                    人物目标数
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={count}
                      onChange={(change) => setCount(Number(change.target.value))}
                    />
                  </label>
                )}
                {!informationWorkflows.versionId && (
                  <label>
                    最多模型调用
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={maxCalls}
                      onChange={(change) => setMaxCalls(Number(change.target.value))}
                    />
                  </label>
                )}
                <p className="muted fine">
                  已有设定与规划资料自动作为参考；可额外选择正文和事件大纲。
                </p>
                {structure.documents
                  .filter((document) => !isElementKind(document.kind))
                  .map((document) => (
                    <label className="checkbox" key={document.id}>
                      <input
                        type="checkbox"
                        checked={sourceIds.includes(document.currentVersionId)}
                        onChange={(change) => {
                          const selected = change.target.checked;
                          setSourceIds((old) =>
                            selected
                              ? [...old, document.currentVersionId]
                              : old.filter((id) => id !== document.currentVersionId),
                          );
                        }}
                      />
                      {document.title}
                    </label>
                  ))}
              </details>
            </div>
            {!planning && informationWorkflows.runs.length > 0 && (
              <details
                className="element-workflow-history"
                open={Boolean(informationWorkflows.active)}
              >
                <summary>基础信息编排与待审候选（{informationWorkflows.runs.length}）</summary>
                {informationWorkflows.runs.map((workflow) => (
                  <AssistantWorkflowCard
                    key={workflow.id}
                    run={workflow}
                    onChange={informationWorkflows.update}
                    beforeAccept={async () => {
                      if (dirty) throw new Error('请先保存当前改稿再采用');
                      await beforeOperation();
                    }}
                    onSaved={async (ids: string[]) => {
                      await reload();
                      await onChanged();
                      if (ids[0]) {
                        const saved = await elementApi.entry(ids[0]);
                        choose(saved.document.id, saved.document.kind as ElementKind);
                      }
                    }}
                  />
                ))}
              </details>
            )}
            <details className="element-jobs" open={jobRunning || pendingCandidates.length > 0}>
              <summary>生成任务与待审候选</summary>
              <label>
                历史任务
                <select
                  value={job?.id ?? ''}
                  onChange={(e) => {
                    setJobId(e.target.value);
                    setCandidateId('');
                    setChecked([]);
                  }}
                >
                  <option value="">选择任务</option>
                  {categoryJobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {new Date(j.createdAt).toLocaleString()} · {jobLabels[j.status]}
                    </option>
                  ))}
                </select>
              </label>
              {job && (
                <>
                  <p role="status" className="element-job-status">
                    <span>{jobLabels[job.status]}</span>
                    <span className="muted">
                      {job.stage}/{job.totalStages} 类 · {job.callCount} 次调用
                    </span>
                    <span className="muted">{reviewLabels[job.reviewStatus]}</span>
                  </p>
                  <p className="muted fine">
                    任务分类：{job.input.kinds.map((k) => elementLabels[k]).join('、')}
                  </p>
                  <p className="muted fine">
                    输入 {job.usage.known.inputTokens ?? '未知'} / 输出{' '}
                    {job.usage.known.outputTokens ?? '未知'} Token · 费用{' '}
                    {job.usage.known.cost
                      ? `${job.usage.known.cost.amount} ${job.usage.known.cost.currency}`
                      : '未知'}
                    {!job.usage.complete ? '（统计不完整）' : ''}
                  </p>
                  {job.error && (
                    <p role="alert" className="error">
                      {job.error}
                    </p>
                  )}
                  <div className="element-job-actions">
                    {['queued', 'running'].includes(job.status) ? (
                      <button
                        type="button"
                        className="element-job-control"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await elementApi.cancel(job.id);
                            await reload();
                          })
                        }
                      >
                        停止生成
                      </button>
                    ) : (
                      job.input.kinds.length === 1 &&
                      ['failed', 'partial', 'interrupted', 'cancelled'].includes(job.status) && (
                        <button
                          type="button"
                          className="element-job-control"
                          disabled={busy}
                          onClick={() =>
                            act(async () => {
                              await elementApi.retry(job.id, crypto.randomUUID());
                              await reload();
                            })
                          }
                        >
                          重试未完成分类（可能产生新用量）
                        </button>
                      )
                    )}
                    {pendingCandidates.length > 1 && (
                      <>
                        <label className="element-select-pending checkbox">
                          <input
                            type="checkbox"
                            disabled={decisionBlocked}
                            checked={allPendingChecked}
                            ref={(input) => {
                              if (input)
                                input.indeterminate =
                                  selectedPending.length > 0 && !allPendingChecked;
                            }}
                            onChange={(event) =>
                              setChecked(
                                event.target.checked ? pendingCandidates.map((c) => c.id) : [],
                              )
                            }
                          />
                          全选待采用{' '}
                          <span className="muted">
                            {selectedPending.length}/{pendingCandidates.length}
                          </span>
                        </label>
                        <button
                          type="button"
                          disabled={decisionBlocked || !selectedPending.length}
                          onClick={() => act(() => decide('accept', selectedPending))}
                        >
                          采用所选（{selectedPending.length}）
                        </button>
                        <button
                          type="button"
                          disabled={decisionBlocked || !selectedPending.length}
                          onClick={() => act(() => decide('reject', selectedPending))}
                        >
                          拒绝所选
                        </button>
                      </>
                    )}
                  </div>
                  {dirty && pendingCandidates.length > 0 && (
                    <p className="element-review-note">请先保存当前改稿，再采用或拒绝。</p>
                  )}
                  {jobRunning && pendingCandidates.length > 0 && (
                    <p className="element-review-note">生成完成后即可处理候选。</p>
                  )}
                  {!jobRunning &&
                    visibleCandidates.length > 0 &&
                    pendingCandidates.length === 0 && (
                      <p className="element-review-note">
                        {visibleCandidates.some((c) => c.status === 'accepted')
                          ? '本任务候选已全部处理，点击已采用条目可查看正式要素。'
                          : '本任务候选已全部拒绝，可重新生成。'}
                      </p>
                    )}
                  {visibleCandidates.map((c) => (
                    <div className="element-candidate" key={c.id}>
                      <div className="element-candidate-heading">
                        {c.status === 'pending' && pendingCandidates.length > 1 ? (
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              disabled={decisionBlocked}
                              checked={selectedPending.some((item) => item.id === c.id)}
                              onChange={(e) =>
                                setChecked((old) =>
                                  e.target.checked
                                    ? [...old, c.id]
                                    : old.filter((id) => id !== c.id),
                                )
                              }
                            />
                            {statusLabels[c.status]}
                          </label>
                        ) : (
                          <span className={`element-candidate-status is-${c.status}`}>
                            {statusLabels[c.status]}
                          </span>
                        )}
                      </div>
                      <button type="button" disabled={busy} onClick={() => reviewCandidate(c)}>
                        <strong>{c.title}</strong>
                        <small>
                          {elementLabels[c.kind]} ·{' '}
                          {c.status === 'accepted'
                            ? '查看已入库要素'
                            : c.targetDocumentId
                              ? '修改'
                              : '新增'}
                        </small>
                      </button>
                      {c.status === 'pending' && (
                        <div className="element-candidate-actions">
                          <button
                            type="button"
                            className="primary"
                            disabled={decisionBlocked}
                            onClick={() => act(() => decide('accept', [c]))}
                          >
                            采用
                          </button>
                          <button
                            type="button"
                            disabled={decisionBlocked}
                            onClick={() => act(() => decide('reject', [c]))}
                          >
                            拒绝
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </details>
            {!categoryJobs.length && <p className="muted">当前分类暂无生成任务。</p>}
          </aside>
        )}
      </div>
      {history && entry && (
        <History
          documentId={entry.document.id}
          canRestore={!dirty}
          onClose={() => setHistory(false)}
          onRestore={async (version) => {
            await api.restore(entry.document.id, entry.version.id, version);
            await reload();
            setFormRevision((v) => v + 1);
            await onChanged();
          }}
        />
      )}
    </section>
  );
}
