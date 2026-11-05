import {
  type ContextPreview,
  type Document,
  hasElementContent,
  isStoryEventKind,
  linkedChapterIds,
  orderedChapters,
  type Proposal,
  type ProviderConfig,
  type RunDetail,
  type RunSummary,
  runEventSchema,
  type SessionHistory,
  visibleWritingTask,
  type WorkflowTask,
  type WritingReference,
  type WritingRunInput,
  workflowInputSchema,
  workflowTaskLabels,
  writingReferenceSchema,
} from '@lingma/shared';
import {
  ArrowUp,
  BookOpen,
  Bot,
  Bug,
  ChevronDown,
  Eraser,
  FileText,
  History,
  LoaderCircle,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePen,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.js';
import { elementApi } from '../element-api.js';
import { useProjectWorkspace } from '../project-context.js';
import { useProjectProvider } from '../provider-selection.js';
import { workflowApi } from '../workflow-api.js';
import { textHash, writingApi } from '../writing-api.js';
import { AssistantWorkflowCard, useAssistantWorkflows } from './AssistantWorkflows.js';
import { ChatHistory } from './ChatHistory.js';
import { MarkdownContent } from './MarkdownContent.js';
import { OutlineCreationCard } from './OutlineCreationCard.js';
import { ProposalDiagnostics, RunDiagnostics } from './RunDiagnostics.js';
import { referenceToken, WritingMentions } from './WritingMentions.js';

const active = (run: RunSummary) => ['queued', 'running', 'cancelling'].includes(run.status);
const labels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  cancelling: '正在取消',
  completed: '已完成',
  limited: '达到限制',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '服务中断',
};
function remembered(key: string) {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function remember(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* Persistence is optional UI state. */
  }
}
function rememberedReferences(projectId: string): WritingReference[] {
  try {
    const result = writingReferenceSchema
      .array()
      .max(200)
      .safeParse(JSON.parse(remembered(`lingma:references:${projectId}`) || '[]'));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}
export function WritingPanel({
  projectId,
  shortForm = false,
  outlineMode = false,
  document,
  selection,
  beforeRun,
  onProposalsChange,
  onReviewProposal,
  onOutlinesCreated,
  proposalRefresh = 0,
  composerInsertion,
  onComposerInsertionHandled,
}: {
  projectId: string;
  shortForm?: boolean;
  outlineMode?: boolean;
  document: Document | undefined;
  selection: { from: number; to: number };
  beforeRun(): Promise<void>;
  onProposalsChange(projectId: string, runId: string | null, proposals: Proposal[]): void;
  onReviewProposal(proposal: Proposal): void;
  onOutlinesCreated(projectId: string, documentId: string): Promise<void>;
  proposalRefresh?: number;
  composerInsertion: { id: string; text: string } | null;
  onComposerInsertionHandled(id: string): void;
}) {
  const { structure, refresh: refreshWorkspace } = useProjectWorkspace();
  const currentStructure = structure?.project.id === projectId ? structure : null;
  const [references, setReferences] = useState<WritingReference[]>(() =>
    rememberedReferences(projectId),
  );
  useEffect(() => {
    remember(`lingma:references:${projectId}`, JSON.stringify(references));
  }, [projectId, references]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useProjectProvider(projectId);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [contextCleared, setContextCleared] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debug, setDebug] = useState(() => remembered('lingma:debug') === 'true');
  const [sessionId, setSessionId] = useState(() => remembered(`lingma:session:${projectId}`));
  const workflows = useAssistantWorkflows(projectId, sessionId);
  const [sessionTitle, setSessionTitle] = useState('');
  const [messages, setMessages] = useState<
    { id: string; runId: string; role: string; content: string }[]
  >([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [writingPurpose, setPurpose] = useState<'write' | 'rewrite' | 'review'>('write'),
    [task, setTask] = useState(() => remembered(`lingma:composer:${projectId}`));
  useEffect(() => {
    remember(`lingma:composer:${projectId}`, task);
  }, [projectId, task]);
  const [allowSearch, setAllowSearch] = useState(true),
    [includeFuture, setFuture] = useState(false),
    [reviewProposal, setAllowProposal] = useState(false);
  const purpose = outlineMode ? 'review' : writingPurpose;
  const future = outlineMode || includeFuture;
  const allowProposal = outlineMode || reviewProposal;
  const [pins, setPins] = useState<string[]>([]),
    [excluded, setExcluded] = useState<string[]>([]);
  const [options, setOptions] = useState<
      Pick<
        ContextPreview['allowed'][number],
        'documentId' | 'versionId' | 'title' | 'kind' | 'planning'
      >[]
    >([]),
    [preview, setPreview] = useState<ContextPreview | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [connection, setConnection] = useState(''),
    [streamEpoch, setStreamEpoch] = useState(0);
  const taskInput = useRef<HTMLTextAreaElement>(null);
  const inserted = useRef('');
  const [focusComposer, setFocusComposer] = useState(false);
  useEffect(() => {
    if (!composerInsertion || busy || inserted.current === composerInsertion.id) return;
    inserted.current = composerInsertion.id;
    const next = `${task}${task && !task.endsWith('\n\n') ? '\n\n' : ''}${composerInsertion.text}`;
    if (next.length > 32000) {
      setError('引用与提问合计超过 32000 字符，请缩小正文选区或精简提问后重试。');
    } else {
      setTask(next);
      setRecordsOpen(false);
      setError('');
      setFocusComposer(true);
    }
    onComposerInsertionHandled(composerInsertion.id);
  }, [composerInsertion, busy, task, onComposerInsertionHandled]);
  useEffect(() => {
    if (!focusComposer || busy || recordsOpen) return;
    const input = taskInput.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
    if (input) input.scrollTop = input.scrollHeight;
    setFocusComposer(false);
  }, [focusComposer, busy, recordsOpen]);
  const keys = useRef(new Map<string, string>()),
    seq = useRef(0),
    current = useRef(''),
    mounted = useRef(true);
  const conversation = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const resultTarget = useRef<HTMLElement>(null);
  const revealSelected = useRef(false);
  const messagesLoadedFor = useRef('');
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const refreshSession = useCallback(async () => {
    if (!sessionId) return;
    const session = await writingApi.getSession(sessionId);
    if (!mounted.current || currentSession.current !== sessionId) return;
    setSessionTitle(session.title);
  }, [sessionId]);
  const refreshMessages = useCallback(async () => {
    const page = sessionId ? await writingApi.messages(sessionId) : { data: [], nextCursor: null };
    if (!mounted.current || currentSession.current !== sessionId) return;
    messagesLoadedFor.current = sessionId;
    setMessages(page.data);
    setMessageCursor(page.nextCursor);
  }, [sessionId]);
  const load = useCallback(
    async (id: string) => {
      const detail = await writingApi.run(id);
      if (!mounted.current || current.current !== id) return;
      if (detail.projectId !== projectId || detail.sessionId !== (currentSession.current || null))
        return;
      if (detail.lastEventSeq < seq.current) return;
      seq.current = detail.lastEventSeq;
      setRun(detail);
    },
    [projectId],
  );
  const chooseRun = useCallback(
    (id: string, reveal = false) => {
      revealSelected.current = reveal;
      followConversation.current = !reveal;
      current.current = id;
      seq.current = 0;
      setRun(null);
      setContextCleared(false);
      remember(`lingma:run:${projectId}`, id);
      void load(id).catch((e: Error) => setError(e.message));
    },
    [load, projectId],
  );
  useEffect(() => {
    onProposalsChange(
      projectId,
      run?.id ?? null,
      run?.proposals.filter((proposal) => proposal.status !== 'staged') ?? [],
    );
  }, [projectId, run?.id, run?.proposals, onProposalsChange]);
  useEffect(() => {
    if (proposalRefresh && current.current)
      void load(current.current).catch((e: Error) => setError(e.message));
  }, [proposalRefresh, load]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void writingApi
      .providers()
      .then((p) => {
        if (!mounted.current) return;
        setProviders(p.data);
        setProviderId((old) =>
          p.data.some((item) => item.id === old) ? old : p.data[0]?.id || '',
        );
      })
      .catch((e: Error) => setError(e.message));
  }, [setProviderId]);
  useEffect(() => {
    remember(`lingma:session:${projectId}`, sessionId);
    let alive = true;
    const failed = (e: Error) => {
      if (!alive || currentSession.current !== sessionId) return;
      if (e instanceof ApiError && e.code === 'NOT_FOUND') {
        currentSession.current = '';
        current.current = '';
        setSessionId('');
        setSessionTitle('');
        setRun(null);
        setMessages([]);
        setMessageCursor(null);
        remember(`lingma:session:${projectId}`, '');
        remember(`lingma:run:${projectId}`, '');
      } else setError(e.message);
    };
    void refreshSession().catch(failed);
    void refreshMessages().catch(failed);
    return () => {
      alive = false;
    };
  }, [projectId, sessionId, refreshSession, refreshMessages]);
  useEffect(() => {
    const saved = remembered(`lingma:run:${projectId}`);
    if (saved) chooseRun(saved);
  }, [projectId, chooseRun]);
  const specification = JSON.stringify({
    task,
    references,
    purpose,
    outlineMode,
    providerId,
    sessionId,
    pins,
    excluded,
    allowSearch,
    future,
    allowProposal,
    documentId: document?.id,
    selection,
  });
  const previousSpecification = useRef(specification);
  useEffect(() => {
    if (previousSpecification.current !== specification) {
      previousSpecification.current = specification;
      setPreview(null);
    }
  }, [specification]);
  const lastRetry = run?.trace.findLast((event) => event.type === 'model.retry');
  const retryNotice =
    lastRetry &&
    run &&
    active(run) &&
    !run.trace.some(
      (event) =>
        event.type === 'turn.completed' &&
        event.turnIndex === lastRetry.turnIndex &&
        event.seq > lastRetry.seq,
    )
      ? `模型请求超时，正在自动重试 ${lastRetry.retryAttempt}/${lastRetry.maxRetries}`
      : '';
  const runId = run?.id,
    runActive =
      (run ? active(run) : false) ||
      Boolean(workflows.runs.some((item) => ['queued', 'running'].includes(item.status)));
  useEffect(() => {
    if (!runId || !runActive) return;
    const source = new EventSource(
      `/api/v1/runs/${runId}/events?after=${seq.current}&connection=${streamEpoch}`,
    );
    let alive = true;
    const update = (message: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const parsed = runEventSchema.safeParse(data);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.runId !== current.current || event.seq <= seq.current) return;
      seq.current = event.seq;
      if (event.type === 'turn.started' || event.type === 'model.retry')
        setRun((old) => {
          if (!old || old.id !== event.runId) return old;
          const turns =
            event.type === 'turn.started'
              ? old.turns.map((turn) =>
                  turn.turnIndex === event.turnIndex
                    ? { ...turn, status: 'running', partialText: '', thinking: '', response: null }
                    : turn,
                )
              : old.turns;
          return {
            ...old,
            lastEventSeq: event.seq,
            turns,
            trace: [
              ...old.trace,
              {
                seq: event.seq,
                type: event.type,
                turnIndex: event.turnIndex,
                executionId: null,
                retryAttempt: event.type === 'model.retry' ? event.attempt : null,
                maxRetries: event.type === 'model.retry' ? event.maxRetries : null,
                createdAt: new Date().toISOString(),
              },
            ],
          };
        });
      if (event.type === 'text.delta' || event.type === 'thinking.delta')
        setRun((old) => {
          if (!old || old.id !== event.runId) return old;
          const field = event.type === 'thinking.delta' ? 'thinking' : 'partialText';
          const turns = old.turns.map((turn) =>
            turn.turnIndex === event.turnIndex
              ? { ...turn, [field]: turn[field] + event.text }
              : turn,
          );
          if (!turns.some((turn) => turn.turnIndex === event.turnIndex))
            turns.push({
              turnIndex: event.turnIndex,
              status: 'running',
              partialText: event.type === 'text.delta' ? event.text : '',
              thinking: event.type === 'thinking.delta' ? event.text : '',
              request: null,
              response: null,
            });
          return { ...old, lastEventSeq: event.seq, turns };
        });
      if (
        [
          'turn.started',
          'model.retry',
          'turn.completed',
          'tool.completed',
          'proposal.created',
          'run.finished',
        ].includes(event.type)
      )
        void load(runId)
          .then(() => {
            if (event.type === 'run.finished') {
              void refreshSession().catch((e: Error) => setError(e.message));
              void refreshMessages().catch((e: Error) => setError(e.message));
            }
          })
          .catch((e: Error) => setError(e.message));
    };
    for (const type of [
      'run.started',
      'turn.started',
      'model.retry',
      'text.delta',
      'thinking.delta',
      'tool.arguments.delta',
      'tool.started',
      'tool.completed',
      'proposal.created',
      'turn.completed',
      'run.finished',
    ])
      source.addEventListener(type, update as EventListener);
    source.onopen = () => setConnection('事件流已连接');
    source.onerror = () => {
      if (!alive) return;
      setConnection('连接中断，正在自动重连；任务继续执行');
      void fetch(`/api/v1/runs/${runId}/events?after=${seq.current}&check=1`)
        .then(async (response) => {
          if (response.status === 410) {
            source.close();
            await load(runId);
            if (alive) setStreamEpoch((value) => value + 1);
          }
        })
        .catch(() => {});
    };
    return () => {
      alive = false;
      source.close();
    };
  }, [runId, runActive, streamEpoch, load, refreshSession, refreshMessages]);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      if (current.current) void load(current.current).catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  function key(scope: string, body: unknown) {
    const id = `${scope}:${JSON.stringify(body)}`;
    if (!keys.current.has(id)) keys.current.set(id, crypto.randomUUID());
    return keys.current.get(id) as string;
  }
  async function build(workflowTask?: WorkflowTask): Promise<WritingRunInput> {
    if (!task.trim() || !providerId) throw new Error('请填写任务，并选择模型配置');
    if (
      outlineMode &&
      document &&
      document.kind !== 'master_outline' &&
      !isStoryEventKind(document.kind)
    )
      throw new Error('请先新建或选择一份大纲');
    if (
      !workflowTask &&
      purpose === 'rewrite' &&
      (document?.kind !== 'chapter' || selection.to <= selection.from)
    )
      throw new Error('请先在正文中选中要改写的文字');
    await beforeRun();
    const targetDocument =
      document &&
      (workflowTask
        ? document.kind ===
          {
            chapter_write: 'chapter',
            worldbuilding: 'worldbuilding',
            master_outline: 'master_outline',
            story_events: 'chapter_outline',
          }[workflowTask]
        : outlineMode || purpose === 'review' || document.kind === 'chapter')
        ? document
        : undefined;
    const runPurpose = workflowTask
      ? 'review'
      : purpose === 'write' && !targetDocument
        ? 'review'
        : purpose;
    const detail = targetDocument ? await api.document(targetDocument.id) : null,
      structure = await api.structure(projectId);
    const chapters = orderedChapters(structure).map((doc) => doc.id);
    const targetIndex = targetDocument ? chapters.indexOf(targetDocument.id) : -1;
    const basicInformation =
      outlineMode || (workflowTask && workflowTask !== 'chapter_write')
        ? await elementApi.list(projectId)
        : [];
    const mentioned = references.filter((reference) => task.includes(referenceToken(reference)));
    const referencedDocuments = mentioned
      .filter((reference) => reference.type === 'document')
      .map((reference) => {
        const doc = structure.documents.find((item) => item.id === reference.id && !item.archived);
        if (!doc) throw new Error(`引用的资料“${reference.label}”已删除或归档，请重新引用`);
        return doc;
      });
    const referencedVolumes = mentioned
      .filter((reference) => reference.type === 'volume')
      .map((reference) => {
        const volume = structure.volumes.find((item) => item.id === reference.id);
        if (!volume) throw new Error(`引用的卷“${reference.label}”已删除，请重新引用`);
        return volume;
      });
    const volumeOutlines = structure.documents.filter(
      (doc) =>
        !doc.archived &&
        isStoryEventKind(doc.kind) &&
        referencedVolumes.some((volume) => volume.title === doc.title),
    );
    const referenceDocuments = [...referencedDocuments, ...volumeOutlines];
    const referenceIds = new Set(referenceDocuments.map((doc) => doc.id));
    const useFuture =
      future ||
      Boolean(workflowTask && workflowTask !== 'chapter_write') ||
      referenceDocuments.some((doc) => doc.kind !== 'chapter');
    const archivedInformation = new Set(
      basicInformation
        .filter((entry) => entry.status === 'archived')
        .map((entry) => entry.document.id),
    );
    const available = structure.documents
      .filter((doc) => {
        if (doc.id === targetDocument?.id) return true;
        if (archivedInformation.has(doc.id)) return false;
        const related = doc.kind === 'chapter' ? [doc.id] : linkedChapterIds(doc);
        const later = targetIndex >= 0 && related.some((id) => chapters.indexOf(id) > targetIndex);
        return (
          !(doc.kind === 'chapter' && later) &&
          !(
            isStoryEventKind(doc.kind) &&
            !useFuture &&
            (!related.length || later || targetIndex < 0)
          )
        );
      })
      .map((doc) => ({
        documentId: doc.id,
        versionId: doc.currentVersionId,
        title: doc.title,
        kind: doc.kind,
        planning: isStoryEventKind(doc.kind),
      }));
    setOptions(available);
    for (const doc of referenceDocuments) {
      if (excluded.includes(doc.id) || !available.some((item) => item.documentId === doc.id))
        throw new Error(`引用的资料“${doc.title}”不在本次允许范围，请调整资料设置或选择对应章节`);
    }
    const selectedVersionIds = [
      ...new Set([
        ...referenceDocuments.map((doc) => doc.currentVersionId),
        ...pins
          .map((id) => available.find((doc) => doc.documentId === id)?.versionId)
          .filter((id): id is string => Boolean(id)),
        ...basicInformation
          .filter(
            (entry) =>
              entry.status !== 'archived' &&
              entry.document.id !== targetDocument?.id &&
              !excluded.includes(entry.document.id) &&
              hasElementContent(entry),
          )
          .map((entry) => entry.version.id),
      ]),
    ];
    if (selectedVersionIds.length > 200)
      throw new Error('固定的资料与引用超过 200 份，请移除部分引用或缩小资料范围');
    let chat = sessionId;
    if (!chat) {
      const created = await writingApi.session(projectId, task.trim().slice(0, 30), null);
      chat = created.id;
      setSessionTitle(created.title);
      currentSession.current = created.id;
      setSessionId(chat);
    }
    const config = providers.find((item) => item.id === providerId);
    if (!config) throw new Error('模型配置不存在，请刷新');
    const target =
      targetDocument && detail
        ? {
            documentId: targetDocument.id,
            baseVersionId: detail.version.id,
            ...(purpose === 'rewrite'
              ? {
                  selection: {
                    ...selection,
                    textHash: await textHash(
                      detail.version.content.slice(selection.from, selection.to),
                    ),
                  },
                }
              : {}),
          }
        : undefined;
    const input = task.trim();
    if (input.length > 32000) throw new Error('任务过长，请精简提问后重试');
    return {
      projectId,
      sessionId: chat,
      purpose: runPurpose,
      input,
      ...(target ? { target } : {}),
      providerConfigId: providerId,
      modelId: config.config.modelId,
      context: {
        selectedVersionIds,
        allowSearch,
        allowFutureOutline: useFuture,
        references: mentioned,
        ...(excluded.length
          ? {
              allowedVersionIds: available
                .filter(
                  (ref) => !excluded.includes(ref.documentId) || referenceIds.has(ref.documentId),
                )
                .map(
                  (ref) =>
                    structure.documents.find((doc) => doc.id === ref.documentId)
                      ?.currentVersionId ?? ref.versionId,
                ),
            }
          : {}),
      },
      allowTargetProposal: runPurpose === 'review' && allowProposal && Boolean(target),
      allowOutlineCreation: outlineMode,
      allowChapterCreation: !outlineMode && purpose !== 'rewrite',
    };
  }
  const latest = run?.turns.at(-1),
    output = latest?.partialText || run?.output?.text || '';
  const visibleProposals = run?.proposals.filter((proposal) => proposal.status !== 'staged') ?? [];
  const visibleOutlineProposals =
    run?.outlineProposals.filter(
      (proposal) => proposal.status !== 'staged' && proposal.status !== 'abandoned',
    ) ?? [];
  useEffect(() => {
    if (recordsOpen) return;
    if (run && revealSelected.current && messagesLoadedFor.current === sessionId) {
      const frame = requestAnimationFrame(() => {
        resultTarget.current?.scrollIntoView({ block: 'start' });
        revealSelected.current = false;
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!run && messages.length === 0) return;
    if (followConversation.current)
      conversation.current?.scrollTo({ top: conversation.current.scrollHeight });
  }, [run, messages, recordsOpen, sessionId]);
  function resetConversation(clearTask: boolean) {
    if (busy || runActive) return;
    currentSession.current = '';
    current.current = '';
    seq.current = 0;
    setSessionId('');
    setSessionTitle('');
    setRun(null);
    setMessages([]);
    setMessageCursor(null);
    messagesLoadedFor.current = '';
    revealSelected.current = false;
    if (clearTask) {
      setTask('');
      setReferences([]);
    }
    setPreview(null);
    setOptions([]);
    setPins([]);
    setExcluded([]);
    setConnection('');
    setError('');
    keys.current.clear();
    remember(`lingma:session:${projectId}`, '');
    remember(`lingma:run:${projectId}`, '');
    followConversation.current = true;
  }
  function newConversation() {
    if (busy || runActive) return;
    resetConversation(true);
    setContextCleared(false);
    setRecordsOpen(false);
    setFocusComposer(true);
  }
  function clearContext() {
    if (busy || runActive) return;
    resetConversation(false);
    setContextCleared(true);
  }
  function changeDebug(enabled: boolean) {
    setDebug(enabled);
    remember('lingma:debug', String(enabled));
  }
  function sendTask() {
    if (busy || runActive || !task.trim() || !providerId) return;
    if (workflows.active) {
      setError('作品有待处理编排，请在运行卡中继续或结束。');
      return;
    }
    void act(async () => {
      followConversation.current = true;
      const prepared = await build(workflows.template?.config.taskType);
      if (workflows.versionId) {
        if (!workflows.template) throw new Error('请选择已发布的编排模板');
        await workflows.start(
          workflowInputSchema.parse({
            projectId,
            sessionId: prepared.sessionId,
            taskType: workflows.template.config.taskType,
            targetDocumentId: prepared.target?.documentId ?? null,
            baseVersionId: prepared.target?.baseVersionId ?? null,
            templateVersionId: workflows.versionId,
            providerConfigId: providerId,
            input: prepared.input,
            mode: prepared.target ? 'replace' : 'create',
            selectedVersionIds: prepared.context.selectedVersionIds,
            allowedVersionIds: prepared.context.allowedVersionIds,
            allowFutureOutline: prepared.context.allowFutureOutline,
          }),
        );
        current.current = '';
        setRun(null);
        setTask('');
        setReferences([]);
        setPreview(null);
        await refreshSession();
        return;
      }
      const context = await writingApi.preview(prepared);
      setOptions(context.allowed);
      const input = { ...prepared, expectedContextHash: context.hash };
      const created = await writingApi.create(input, key('create', input));
      chooseRun(created.id);
      setTask('');
      setReferences([]);
      setPreview(null);
      await refreshSession();
      await refreshMessages();
    });
  }
  function openConversation(
    session: SessionHistory,
    selectedRunId = session.latestRunId,
    reveal = false,
  ) {
    if (busy || runActive) return;
    currentSession.current = session.id;
    current.current = '';
    seq.current = 0;
    setSessionId(session.id);
    setSessionTitle(session.title);
    setRun(null);
    setMessages([]);
    setMessageCursor(null);
    messagesLoadedFor.current = '';
    setContextCleared(false);
    setPreview(null);
    setConnection('');
    setError('');
    setRecordsOpen(false);
    remember(`lingma:session:${projectId}`, session.id);
    remember(`lingma:run:${projectId}`, selectedRunId ?? '');
    followConversation.current = true;
    if (selectedRunId) chooseRun(selectedRunId, reveal);
    if (session.id === sessionId) void refreshMessages().catch((e: Error) => setError(e.message));
  }
  const resultView = (
    <section className="writing-result" aria-label="AI 输出" ref={resultTarget}>
      {run && (
        <>
          <article className="chat-message chat-user">
            <span className="chat-author">你</span>
            <p>{visibleWritingTask(run.input.input)}</p>
          </article>
          <div className="chat-run-status">
            <span className="chat-author assistant-identity">
              <Sparkles size={15} aria-hidden="true" />
              灵码
            </span>
            {(debug || active(run) || run.status !== 'completed') && (
              <p
                role="status"
                aria-live="polite"
                className={`run-status ${active(run) ? 'is-active' : ''}`}
              >
                {retryNotice ||
                  (debug
                    ? `运行状态：${labels[run.status]}`
                    : run.status === 'running'
                      ? '正在生成…'
                      : labels[run.status])}
                {debug && run.status !== 'completed' && run.stopReason
                  ? ` · ${run.stopReason}`
                  : ''}
              </p>
            )}
          </div>
          {!active(run) && run.status !== 'completed' && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const next = await writingApi.retry(run.id, key('retry', run.id));
                  chooseRun(next.id);
                  await refreshSession();
                })
              }
            >
              {debug ? '从完整检查点重试' : '重试'}
            </button>
          )}
          {visibleOutlineProposals.map((proposal) => (
            <OutlineCreationCard
              key={proposal.id}
              proposal={proposal}
              volumes={currentStructure?.volumes ?? []}
              busy={busy}
              generating={runActive}
              onAccept={() =>
                void act(async () => {
                  await beforeRun();
                  const accepted = await writingApi.acceptOutlineCreation(
                    proposal.id,
                    key('outline-creation', proposal.id),
                  );
                  await load(run.id);
                  const first = accepted.acceptedDocuments[0];
                  if (first) await onOutlinesCreated(proposal.projectId, first.documentId);
                })
              }
              onReject={() =>
                void act(async () => {
                  await writingApi.rejectOutlineCreation(proposal.id);
                  await load(run.id);
                })
              }
              onOpen={(id) => void act(() => onOutlinesCreated(proposal.projectId, id))}
            />
          ))}
          {visibleProposals.map((proposal) => {
            const target = run.preview.allowed.find(
              (entry) => entry.documentId === proposal.targetDocumentId,
            );
            const kind = target?.kind;
            const targetTitle =
              currentStructure?.documents.find((entry) => entry.id === proposal.targetDocumentId)
                ?.title ??
              target?.title ??
              '原目标文档';
            const outlineProposal = kind === 'master_outline' || isStoryEventKind(kind ?? '');
            return (
              <article className="proposal-card" key={proposal.id}>
                <h3>
                  <FileText size={16} aria-hidden="true" />
                  {outlineProposal ? '大纲草稿' : '正文草稿'}
                </h3>
                <p className="proposal-target">修改：{targetTitle}</p>
                <p>{proposal.reason}</p>
                <p className="muted">
                  {proposal.content.length} 字符 ·{' '}
                  {proposal.status === 'pending'
                    ? outlineProposal
                      ? '待写入大纲'
                      : '待写入正文'
                    : proposal.status === 'accepted'
                      ? outlineProposal
                        ? '已写入大纲'
                        : '已写入正文'
                      : proposal.status === 'stale'
                        ? '原文已变更，请重新生成提议'
                        : proposal.status === 'abandoned'
                          ? '已撤销'
                          : '已拒绝'}
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => onReviewProposal(proposal)}
                >
                  {outlineProposal ? '在大纲区查看差异' : '在正文区查看差异'}
                </button>
                <details className="proposal-preview">
                  <summary>查看完整草稿</summary>
                  <div className="generated-prose">
                    <MarkdownContent text={proposal.content} outline={outlineProposal} />
                  </div>
                </details>
                {debug && <ProposalDiagnostics proposal={proposal} contexts={run.contexts} />}
                {['pending', 'stale'].includes(proposal.status) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await writingApi.reject(proposal.id);
                        await load(run.id);
                      })
                    }
                  >
                    拒绝提议
                  </button>
                )}
              </article>
            );
          })}
          <h3 className="sr-only">助手回复</h3>
          {(output ||
            debug ||
            (!active(run) &&
              visibleProposals.length === 0 &&
              visibleOutlineProposals.length === 0)) && (
            <section aria-label="助手回复">
              <div className="candidate-output">
                {output ? (
                  <MarkdownContent text={output} />
                ) : (
                  <p>
                    {active(run)
                      ? '正在处理任务，模型输出会实时显示在这里…'
                      : debug
                        ? '本次没有返回文字，请展开执行过程查看详情。'
                        : run.status === 'cancelled'
                          ? '已停止生成。'
                          : '本次未返回内容，可重试。'}
                  </p>
                )}
              </div>
            </section>
          )}
          {debug && <RunDiagnostics key={run.id} run={run} connection={connection} />}
        </>
      )}
      {!run && (
        <div className="chat-empty">
          <span className="chat-empty-icon">
            <Sparkles size={26} strokeWidth={1.4} aria-hidden="true" />
          </span>
          <span className="chat-empty-kicker">你的创作搭档</span>
          <h3>{outlineMode ? '一起理清故事的走向。' : '这一章，你想怎么写？'}</h3>
          <p role="status">
            {busy
              ? '正在保存草稿并准备任务…'
              : contextCleared
                ? '上下文已清空，可以开始新的创作对话。'
                : outlineMode
                  ? '根据基本信息和总纲规划大事件，沿时间线梳理故事。'
                  : '聊聊人物和情节，续写一个片段，或一起打磨选中的文字。'}
          </p>
          <p className="fine">
            {contextCleared
              ? '历史对话可在记录中查看，正文与作品设定仍按写作设置读取。'
              : outlineMode
                ? '先审阅事件候选，确认后加入时间线，再关联章节展开写作。'
                : '生成内容会先留在对话里，由你决定写入正文。'}
          </p>
        </div>
      )}
    </section>
  );
  return (
    <section className="writing-panel" aria-label={outlineMode ? 'AI 大纲规划' : 'AI 写作'}>
      <header className="chat-header">
        <div className="chat-title">
          <Sparkles size={17} strokeWidth={1.6} aria-hidden="true" />
          <div>
            <h2>{outlineMode ? '大纲助手' : '写作助手'}</h2>
            {sessionTitle && (
              <span className="chat-current-title" title={sessionTitle}>
                {sessionTitle}
              </span>
            )}
          </div>
        </div>
        <div className="chat-header-actions">
          <button
            type="button"
            className="icon-button chat-debug-toggle"
            aria-label="Debug 调试信息"
            aria-pressed={debug}
            title={debug ? '关闭 Debug 调试信息' : '开启 Debug：查看思考、执行详情与用量'}
            onClick={() => changeDebug(!debug)}
          >
            <Bug size={16} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button chat-context-clear"
            aria-label="清空上下文"
            onClick={clearContext}
            disabled={busy || runActive}
            title={
              runActive ? '请先停止生成，再清空上下文' : '开启空白会话并重置资料选择，历史对话保留'
            }
          >
            <Eraser size={15} strokeWidth={1.7} aria-hidden="true" />
            清空上下文
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="历史对话"
            title="历史对话"
            aria-expanded={recordsOpen}
            onClick={() => setRecordsOpen((value) => !value)}
          >
            <History size={17} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="新对话"
            title="新对话"
            onClick={newConversation}
            disabled={busy || runActive}
          >
            <SquarePen size={17} strokeWidth={1.7} aria-hidden="true" />
          </button>
        </div>
      </header>
      {recordsOpen && (
        <ChatHistory
          projectId={projectId}
          activeSessionId={sessionId}
          blocked={busy || runActive}
          onClose={() => setRecordsOpen(false)}
          onNew={newConversation}
          onOpen={(session) => openConversation(session)}
          onRun={(session, selectedRunId) => openConversation(session, selectedRunId, true)}
          onChanged={(session) => {
            if (session.id !== currentSession.current) return;
            if (session.deletedAt) resetConversation(false);
            else setSessionTitle(session.title);
          }}
        />
      )}
      <div className="chat-workspace" hidden={recordsOpen}>
        <div
          className="chat-conversation"
          ref={conversation}
          role="log"
          aria-label="聊天记录"
          onScroll={(event) => {
            const element = event.currentTarget;
            followConversation.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          <div>
            {messageCursor && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const previousHeight = conversation.current?.scrollHeight ?? 0;
                    const previousTop = conversation.current?.scrollTop ?? 0;
                    const selectedSession = currentSession.current;
                    const page = await writingApi.messages(sessionId, messageCursor);
                    if (selectedSession !== currentSession.current) return;
                    followConversation.current = false;
                    setMessages((old) => [...page.data, ...old]);
                    setMessageCursor(page.nextCursor);
                    requestAnimationFrame(() => {
                      if (selectedSession === currentSession.current && conversation.current)
                        conversation.current.scrollTop =
                          previousTop + conversation.current.scrollHeight - previousHeight;
                    });
                  })
                }
              >
                加载更早消息
              </button>
            )}
            {messages.map((message, index) =>
              run && message.runId === run.id ? (
                index === messages.findIndex((item) => item.runId === run.id) ? (
                  <Fragment key={run.id}>{resultView}</Fragment>
                ) : null
              ) : (
                <article
                  key={message.id}
                  className={`chat-message ${message.role === 'user' ? 'chat-user' : 'chat-assistant'}`}
                >
                  <span className="chat-author">{message.role === 'user' ? '你' : '灵码助手'}</span>
                  {message.role === 'assistant' ? (
                    <MarkdownContent text={message.content} />
                  ) : (
                    <p>{visibleWritingTask(message.content)}</p>
                  )}
                  {message.role === 'assistant' && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || runActive}
                      onClick={() => chooseRun(message.runId, true)}
                    >
                      {debug ? '查看思考与提议' : '查看修改建议'}
                    </button>
                  )}
                </article>
              ),
            )}
            {workflows.error && <p role="alert">{workflows.error}</p>}
            {workflows.runs.map((workflow) => (
              <AssistantWorkflowCard
                key={workflow.id}
                run={workflow}
                onChange={workflows.update}
                beforeAccept={beforeRun}
                onSaved={async (ids) => {
                  await refreshWorkspace(projectId);
                  const first = ids[0];
                  if (first) {
                    const saved = await api.document(first);
                    if (
                      saved.document.kind === 'chapter' ||
                      (outlineMode &&
                        ['master_outline', 'chapter_outline'].includes(saved.document.kind))
                    )
                      await onOutlinesCreated(projectId, first);
                  }
                }}
              />
            ))}
            {(!run || !messages.some((message) => message.runId === run.id)) &&
              (workflows.runs.length && !run ? null : resultView)}
          </div>
        </div>
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            sendTask();
          }}
        >
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <WritingMentions
            inputRef={taskInput}
            value={task}
            onChange={setTask}
            references={references}
            onReferencesChange={setReferences}
            onReference={(reference) => {
              const referenced = currentStructure?.documents.find((doc) => doc.id === reference.id);
              const volume = currentStructure?.volumes.find((item) => item.id === reference.id);
              const include = new Set([
                reference.id,
                ...(volume
                  ? (currentStructure?.documents
                      .filter((doc) => isStoryEventKind(doc.kind) && doc.title === volume.title)
                      .map((doc) => doc.id) ?? [])
                  : []),
              ]);
              setExcluded((previous) => previous.filter((id) => !include.has(id)));
              if (reference.type === 'volume' || referenced?.kind !== 'chapter') setFuture(true);
            }}
            structure={currentStructure}
            documentId={document?.id}
            disabled={busy}
            onSend={sendTask}
            placeholder={
              outlineMode
                ? '输入 @ 引用资料，例如：根据总纲规划开篇事件。'
                : '输入 @ 引用卷或资料，例如：为第一卷新建第一章，拟好标题并写出正文。'
            }
          />
          <div className="composer-toolbar">
            <div className="chat-options">
              <label>
                <Bot size={14} aria-hidden="true" />
                <span className="sr-only">写作模型</span>
                <select
                  aria-label="写作模型"
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                >
                  <option value="">请选择模型配置</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.config.name} · {provider.config.modelId}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </label>
              <label>
                <BookOpen size={14} aria-hidden="true" />
                <span className="sr-only">任务用途</span>
                <select
                  aria-label="任务用途"
                  value={workflows.template ? workflows.template.config.taskType : purpose}
                  disabled={outlineMode || Boolean(workflows.template)}
                  onChange={(e) => setPurpose(e.target.value as typeof purpose)}
                >
                  {workflows.template && (
                    <option value={workflows.template.config.taskType}>
                      {workflowTaskLabels[workflows.template.config.taskType]}
                    </option>
                  )}
                  <option value="write">单章写作</option>
                  <option value="rewrite">选中改写</option>
                  <option value="review">{outlineMode ? '大纲规划' : '审校 / 聊天'}</option>
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </label>
              <label>
                <span className="sr-only">执行方式</span>
                <select
                  aria-label="执行方式"
                  value={workflows.versionId}
                  onChange={(event) => workflows.setVersionId(event.target.value)}
                >
                  <option value="">直接生成</option>
                  {Object.entries(workflowTaskLabels).map(([type, label]) => (
                    <optgroup key={type} label={label}>
                      {workflows.templates
                        .flatMap((item) => item.versions.slice(0, 1))
                        .filter((version) => version.config.taskType === type)
                        .map((version) => (
                          <option key={version.id} value={version.id}>
                            {version.config.name} · v{version.versionNo}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </label>
            </div>
            <div className="composer-actions">
              <button
                type="button"
                className="icon-button"
                aria-label="资料与写作设置"
                title="资料与写作设置"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((value) => !value)}
              >
                <SlidersHorizontal size={16} aria-hidden="true" />
              </button>
              {(run && active(run)) ||
              (workflows.active && ['queued', 'running'].includes(workflows.active.status)) ? (
                <button
                  className="send-button"
                  type="button"
                  aria-label="取消运行"
                  title="停止生成"
                  disabled={busy || run?.status === 'cancelling'}
                  onClick={() =>
                    void act(async () => {
                      if (workflows.active) {
                        const workflow = workflows.active;
                        const decision = {
                          action: 'cancel' as const,
                          expectedRevision: workflow.revision,
                          feedback: '',
                        };
                        workflows.update(
                          await workflowApi.decide(
                            workflow.id,
                            decision,
                            key('workflow:cancel', decision),
                          ),
                        );
                      } else if (run) {
                        await writingApi.cancel(run.id);
                        await load(run.id);
                      }
                    })
                  }
                >
                  <Square size={14} fill="currentColor" aria-hidden="true" />
                </button>
              ) : (
                <button
                  className="send-button"
                  type="submit"
                  aria-label={busy ? '处理中…' : '发送'}
                  title="发送 · Ctrl / ⌘ + Enter"
                  disabled={busy || !task.trim() || !providerId}
                >
                  {busy ? (
                    <LoaderCircle size={17} className="is-spinning" aria-hidden="true" />
                  ) : (
                    <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          </div>
          {purpose === 'rewrite' && (
            <p>
              {debug
                ? `选区：${selection.from}—${selection.to}（UTF-16）`
                : selection.to > selection.from
                  ? '已选中文字'
                  : '请在正文中选择要改写的文字。'}
            </p>
          )}
          <details className="chat-settings" open={settingsOpen}>
            <summary className="sr-only">资料与写作设置</summary>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const page = await writingApi.providers();
                  setProviders(page.data);
                  if (!page.data.some((item) => item.id === providerId))
                    setProviderId(page.data[0]?.id ?? '');
                })
              }
            >
              刷新模型列表
            </button>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={debug}
                onChange={(event) => changeDebug(event.target.checked)}
              />
              Debug · 显示调试信息
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={allowSearch}
                onChange={(e) => setAllowSearch(e.target.checked)}
              />
              允许检索冻结资料
            </label>
            {!shortForm && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={future}
                  disabled={outlineMode}
                  onChange={(e) => {
                    setFuture(e.target.checked);
                    setOptions([]);
                    setExcluded([]);
                    setPins([]);
                  }}
                />
                允许未来规划（章纲、事件、伏笔等）
              </label>
            )}
            {purpose === 'review' && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={allowProposal}
                  disabled={outlineMode}
                  onChange={(e) => setAllowProposal(e.target.checked)}
                />
                {outlineMode ? '大纲建议需确认后写入' : '授权对当前文档建立修改提议'}
              </label>
            )}
            <button
              type="button"
              disabled={busy || !task.trim() || !providerId}
              onClick={() =>
                void act(async () => {
                  const input = await build();
                  const result = await writingApi.preview(input);
                  setOptions(result.allowed);
                  setPreview(result);
                })
              }
            >
              保存草稿并预览上下文
            </button>
            {options.length > 0 && (
              <details open>
                <summary>资料权限与固定输入</summary>
                {options.map((ref) => (
                  <div className="context-choice" key={ref.documentId}>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={!excluded.includes(ref.documentId)}
                        disabled={ref.documentId === document?.id}
                        onChange={(e) => {
                          setExcluded((old) =>
                            e.target.checked
                              ? old.filter((id) => id !== ref.documentId)
                              : [...old, ref.documentId],
                          );
                          if (!e.target.checked)
                            setPins((old) => old.filter((id) => id !== ref.documentId));
                        }}
                      />
                      {ref.title}
                      {ref.planning ? '（规划）' : ''}
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={ref.documentId === document?.id || pins.includes(ref.documentId)}
                        disabled={
                          excluded.includes(ref.documentId) || ref.documentId === document?.id
                        }
                        onChange={(e) =>
                          setPins((old) =>
                            e.target.checked
                              ? [...old, ref.documentId]
                              : old.filter((id) => id !== ref.documentId),
                          )
                        }
                      />
                      {ref.documentId === document?.id && purpose === 'rewrite'
                        ? '固定选区及相邻上下文'
                        : '固定全文'}
                    </label>
                  </div>
                ))}
              </details>
            )}
            {preview && (
              <div className="context-preview">
                {debug && (
                  <p>
                    保守估算输入 {preview.estimatedInputTokens} / {preview.inputLimit}{' '}
                    Token；预留输出 {preview.reservedOutputTokens}。无可靠 tokenizer，已留 15%
                    余量。
                  </p>
                )}
                <ul>
                  {preview.entries.map((ref) => (
                    <li key={ref.citationId}>
                      {ref.title} · {ref.reason} · {ref.excerpt.length} 字符
                    </li>
                  ))}
                </ul>
                {[...preview.omitted, ...preview.warnings].map((text) => (
                  <p key={text}>{text}</p>
                ))}
              </div>
            )}
          </details>
          {document?.kind !== 'chapter' && purpose === 'write' && (
            <p className="muted">AI 会拟定章节标题、选择所属卷并提交新章候选，确认后创建。</p>
          )}
        </form>
      </div>
    </section>
  );
}
