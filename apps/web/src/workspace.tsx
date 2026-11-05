import {
  type CreateDocument,
  elementDataSchema,
  elementLabels,
  isBasicInformationKind,
  isStoryEventKind,
  orderedChapters,
  type Project,
  type Proposal,
  readElementData,
} from '@lingma/shared';
import {
  ArrowLeft,
  Check,
  Download,
  Ellipsis,
  FileText,
  History as HistoryIcon,
  ListTree,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api } from './api.js';
import { AssistantResizeHandle } from './components/AssistantResizeHandle.js';
import { DiffView } from './components/DiffView.js';
import { ElementPanel } from './components/ElementPanel.js';
import { History } from './components/History.js';
import { ImportDialog } from './components/ImportDialog.js';
import { MarkdownOutlineEditor } from './components/MarkdownOutlineEditor.js';
import { Modal } from './components/Modal.js';
import { OutlineResizeHandle } from './components/OutlineResizeHandle.js';
import { OutlineSidebar } from './components/OutlineSidebar.js';
import { PlanningFields } from './components/PlanningFields.js';
import { ProjectLibrary } from './components/ProjectLibrary.js';
import { ProposalDiff } from './components/ProposalDiff.js';
import { StoryEventDetails } from './components/StoryEventDetails.js';
import { StructureDialog } from './components/StructureDialog.js';
import { WorkflowContent } from './components/WorkflowContent.js';
import { WritingPanel } from './components/WritingPanel.js';
import { WritingEditor } from './editor/WritingEditor.js';
import { elementApi } from './element-api.js';
import { useProjectWorkspace } from './project-context.js';
import { useRuntime } from './runtime.js';
import { useWorkspaceRoute } from './workspace-route.js';
import { writingApi } from './writing-api.js';

const kindNames = {
  ...elementLabels,
  chapter: '正文',
  master_outline: '总纲',
  chapter_outline: '故事事件',
  character: '人物',
};
const statusNames = {
  saved: '已保存',
  dirty: '待保存',
  saving: '保存中…',
  error: '保存失败',
  conflict: '版本冲突',
};
function draftStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function Workspace() {
  const [outlineWidth, setOutlineWidth] = useState<number | null>(() => {
    try {
      const saved = Number(window.localStorage.getItem('lingma:outline-width'));
      return Number.isFinite(saved) && saved >= 180 && saved <= 10000 ? saved : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (outlineWidth === null) window.localStorage.removeItem('lingma:outline-width');
      else window.localStorage.setItem('lingma:outline-width', String(outlineWidth));
    } catch {
      /* Resizing remains available when browser storage is unavailable. */
    }
  }, [outlineWidth]);
  const [assistantWidth, setAssistantWidth] = useState<number | null>(() => {
    try {
      const saved = Number(draftStorage()?.getItem('lingma:assistant-width'));
      return Number.isFinite(saved) && saved >= 300 && saved <= 10000 ? saved : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      const storage = draftStorage();
      if (assistantWidth === null) storage?.removeItem('lingma:assistant-width');
      else storage?.setItem('lingma:assistant-width', String(assistantWidth));
    } catch {
      /* Keep resizing available when browser storage is unavailable. */
    }
  }, [assistantWidth]);
  const navigate = useNavigate();
  const location = useLocation();
  const {
    projectId,
    documentId,
    view: workspaceView,
    setView: setWorkspaceView,
    setDocumentId,
  } = useWorkspaceRoute();
  useEffect(() => {
    if (projectId) {
      try {
        sessionStorage.setItem('lingma:last-workspace', `${location.pathname}${location.search}`);
      } catch {
        /* Return defaults to project list. */
      }
    }
  }, [projectId, location.pathname, location.search]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [deletedProjects, setDeletedProjects] = useState<Project[]>([]);
  const [projectAction, setProjectAction] = useState<Project | null>(null);
  const {
    structure,
    setStructure,
    refresh: refreshStructure,
    error: projectError,
  } = useProjectWorkspace();
  const { store } = useRuntime();
  useSyncExternalStore(store.subscribe, store.snapshot);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outlineSection, setOutlineSection] = useState<'events' | 'foreshadow'>('events');
  const [dialog, setDialog] = useState<
    | 'create-project'
    | 'rename-project'
    | 'delete-project'
    | 'create-document'
    | 'structure'
    | 'import'
    | 'history'
    | 'delete'
    | null
  >(null);
  const [projectTitle, setProjectTitle] = useState('');
  const [projectFormat, setProjectFormat] = useState<Project['format']>('long');
  const [newKind, setNewKind] = useState<CreateDocument['kind']>('chapter');
  const [newTitle, setNewTitle] = useState('');
  const [newVolume, setNewVolume] = useState('');
  const [newVolumeTitle, setNewVolumeTitle] = useState('');
  const [newChapter, setNewChapter] = useState('');
  const [newStoryTime, setNewStoryTime] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const selected = structure?.documents.find((item) => item.id === documentId);
  const draft = store.get(documentId);
  const currentStructure = structure?.project.id === projectId ? structure : null;
  const outlineVolumeOptions = [
    ...new Map(
      (currentStructure?.documents ?? [])
        .filter(
          (document) =>
            isStoryEventKind(document.kind) &&
            !document.archived &&
            /^第[零〇一二两三四五六七八九十百千万\d]+卷(?:[\s：:、.．—-]|$)/u.test(
              document.title.trim(),
            ) &&
            !currentStructure?.volumes.some((volume) => volume.title === document.title.trim()),
        )
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
        .map(
          (document) =>
            [
              document.title.trim(),
              { value: `outline:${document.id}`, title: document.title.trim() },
            ] as const,
        ),
    ).values(),
  ];
  const creatingVolume =
    newVolume === 'new' || outlineVolumeOptions.some((volume) => volume.value === newVolume);
  const longForm = currentStructure?.project.format === 'long';
  const needsSetup = Boolean(longForm && !currentStructure?.project.setupCompleted);
  const showingElements = Boolean(longForm && (needsSetup || workspaceView === 'information'));
  const showingOutline = Boolean(
    currentStructure && !showingElements && workspaceView === 'outline',
  );
  const showingForeshadows = showingOutline && outlineSection === 'foreshadow';
  const ContentEditor = showingOutline ? MarkdownOutlineEditor : WritingEditor;
  useEffect(() => {
    if (!currentStructure) return;
    if (!longForm && workspaceView === 'information') {
      void navigate(`/projects/${projectId}/writing`, {
        replace: true,
        state: { notice: '短篇作品不提供基本信息页面，已进入写作。' },
      });
    } else if (needsSetup && workspaceView !== 'information') {
      setWorkspaceView('information', true);
    } else if (!documentId && workspaceView !== 'information') {
      const target =
        workspaceView === 'outline'
          ? currentStructure.documents.find(
              (item) =>
                !item.archived && (item.kind === 'master_outline' || isStoryEventKind(item.kind)),
            )
          : orderedChapters(currentStructure)[0];
      if (target) setDocumentId(target.id, true);
    }
  }, [
    currentStructure,
    longForm,
    needsSetup,
    workspaceView,
    projectId,
    documentId,
    navigate,
    setWorkspaceView,
    setDocumentId,
  ]);
  const [selection, setSelection] = useState({ from: 0, to: 0 });
  const [composerInsertion, setComposerInsertion] = useState<{
    id: string;
    projectId: string;
    text: string;
  } | null>(null);
  const clearComposerInsertion = useCallback((id: string) => {
    setComposerInsertion((previous) => (previous?.id === id ? null : previous));
  }, []);
  const [writingReview, setWritingReview] = useState<Proposal | null>(null);
  const [reviewReveal, setReviewReveal] = useState(0);
  const [showReview, setShowReview] = useState(true);
  const [planPreview, setPlanPreview] = useState<{
    runId: string;
    title: string;
    content: string;
    label: string;
  } | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [blankTab, setBlankTab] = useState<'closed' | 'open' | 'active'>('closed');
  const [openTabs, setOpenTabs] = useState<{ projectId: string; ids: string[] }>({
    projectId,
    ids: [],
  });
  const [proposalRefresh, setProposalRefresh] = useState(0);
  const [planningConfirmation, setPlanningConfirmation] = useState<{
    documentId: string;
    versionId: string | null;
  } | null>(null);
  useEffect(() => {
    let live = true;
    if (
      (selected?.kind !== 'master_outline' && selected?.kind !== 'timeline_event') ||
      !draft?.baseVersionId
    )
      return;
    void elementApi.entry(documentId).then(
      (entry) => {
        if (live)
          setPlanningConfirmation({
            documentId,
            versionId: entry.confirmedVersionId,
          });
      },
      (cause: Error) => {
        if (live) setError(cause.message);
      },
    );
    return () => {
      live = false;
    };
  }, [documentId, selected?.kind, draft?.baseVersionId]);
  const announcedProposals = useRef({ runId: null as string | null, seen: new Set<string>() });
  const activeReview =
    showReview && writingReview?.targetDocumentId === selected?.id ? writingReview : null;
  useEffect(() => {
    if (!documentId || !currentStructure) return;
    setOpenTabs((old) => {
      const ids = old.projectId === projectId ? old.ids : [];
      return ids.includes(documentId) ? old : { projectId, ids: [...ids, documentId] };
    });
  }, [documentId, projectId, currentStructure]);
  const tabDocuments = (openTabs.projectId === projectId ? openTabs.ids : [])
    .map((id) => currentStructure?.documents.find((item) => item.id === id && !item.deletedAt))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const reviewTarget = writingReview
    ? currentStructure?.documents.find((item) => item.id === writingReview.targetDocumentId)
    : undefined;
  function selectTab(id: string) {
    if (id === documentId && !activeReview && !showPlan && blankTab !== 'active') return;
    setShowReview(false);
    setShowPlan(false);
    if (blankTab === 'active') setBlankTab('open');
    chooseDocument(id, true);
  }
  function closeTab(id: string) {
    const rest = tabDocuments.filter((item) => item.id !== id);
    setOpenTabs({ projectId, ids: rest.map((item) => item.id) });
    if (id === documentId && rest.length) {
      const index = tabDocuments.findIndex((item) => item.id === id);
      const next = rest[index] ?? rest[index - 1] ?? rest[0];
      if (next) selectTab(next.id);
    }
  }
  useEffect(() => {
    if (
      workspaceView !== 'information' &&
      (selected?.kind === 'master_outline' ||
        isStoryEventKind(selected?.kind ?? '') ||
        selected?.kind === 'foreshadow')
    )
      setWorkspaceView('outline');
  }, [selected?.kind, workspaceView, setWorkspaceView]);
  useEffect(() => {
    if (selected?.kind === 'foreshadow') setOutlineSection('foreshadow');
  }, [selected?.kind]);
  useEffect(() => {
    if (activeReview && selected?.kind === 'chapter') setWorkspaceView('writing');
  }, [activeReview, selected?.kind, setWorkspaceView]);
  const reviewOutdated = Boolean(
    activeReview &&
      draft &&
      (draft.baseVersionId !== activeReview.baseVersionId || store.isDirty(draft)),
  );
  const openWritingReview = useCallback(
    (proposal: Proposal) => {
      setWritingReview(proposal);
      setShowReview(true);
      setReviewReveal((value) => value + 1);
      setDocumentId(proposal.targetDocumentId);
      setError('');
    },
    [setDocumentId],
  );
  const updateWritingProposals = useCallback(
    (id: string, runId: string | null, proposals: Proposal[]) => {
      if (activeProject.current !== id) return;
      if (announcedProposals.current.runId !== runId)
        announcedProposals.current = { runId, seen: new Set() };
      const pending = proposals.filter((proposal) => proposal.status === 'pending');
      const newest = pending.findLast(
        (proposal) => !announcedProposals.current.seen.has(proposal.id),
      );
      for (const proposal of pending) announcedProposals.current.seen.add(proposal.id);
      setWritingReview(
        (previous) => newest ?? proposals.find((proposal) => proposal.id === previous?.id) ?? null,
      );
      if (newest) setDocumentId(newest.targetDocumentId);
    },
    [setDocumentId],
  );

  const refreshProjects = useCallback(async () => {
    const load = async (deleted: boolean) => {
      const result: Project[] = [];
      let cursor: string | null = null;
      do {
        const page = await api.projects(cursor ?? undefined, deleted);
        result.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      return result;
    };
    const [current, deleted] = await Promise.all([load(false), load(true)]);
    setProjects(current);
    setDeletedProjects(deleted);
    window.dispatchEvent(new Event('lingma:projects-changed'));
    return current;
  }, []);
  useEffect(() => {
    void refreshProjects().catch((error: Error) => setError(error.message));
  }, [refreshProjects]);
  useEffect(() => {
    let active = true;
    setSelection({ from: 0, to: 0 });
    if (
      documentId &&
      currentStructure?.documents.some((item) => item.id === documentId) &&
      !store.get(documentId)
    )
      void store.load(documentId).catch((error: Error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [documentId, currentStructure, store]);
  useEffect(() => {
    if (currentStructure)
      void store
        .recover(currentStructure.documents.map((document) => document.id))
        .catch((error: Error) => setError(`恢复待保存草稿失败：${error.message}`));
  }, [currentStructure, store]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (store.all().some((item) => store.isDirty(item))) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [store]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  function chooseProject(id: string) {
    setComposerInsertion(null);
    setWritingReview(null);
    void navigate(id ? `/projects/${id}/writing` : '/projects');
    setDialog(null);
  }
  function openCreateProject() {
    setProjectTitle('');
    setProjectFormat('long');
    setDialog('create-project');
  }
  async function finishSetup() {
    if (!currentStructure) return;
    await api.completeProjectSetup(projectId, currentStructure.project.structureVersion);
    const latest = await refreshStructure(projectId);
    await refreshProjects();
    chooseDocument(
      latest.documents.find((document) => document.kind === 'master_outline')?.id ?? '',
    );
    setWorkspaceView('outline');
  }
  function manageProject(project: Project, action: 'rename-project' | 'delete-project') {
    setProjectAction(project);
    setProjectTitle(project.title);
    setError('');
    setDialog(action);
  }
  function chooseDocument(id: string, keepReview = false) {
    if (!keepReview) setWritingReview(null);
    setDocumentId(id);
    setError('');
    const target = currentStructure?.documents.find((document) => document.id === id);
    if (target?.kind === 'master_outline' || (target && isStoryEventKind(target.kind))) {
      setOutlineSection('events');
      setWorkspaceView('outline');
    } else if (target?.kind === 'foreshadow') {
      setOutlineSection('foreshadow');
      setWorkspaceView('outline');
    } else if (target?.kind === 'chapter') setWorkspaceView('writing');
    else if (target && isBasicInformationKind(target.kind)) setWorkspaceView('information');
  }
  function openWriting(id?: string) {
    if (!currentStructure) return;
    if (!id && selected && isStoryEventKind(selected.kind)) {
      void run(() => startOutlineWriting(selected.id));
      return;
    }
    const chapterId = id ?? (selected?.kind === 'chapter' ? selected.id : selected?.chapterId);
    chooseDocument(chapterId ?? orderedChapters(currentStructure)[0]?.id ?? '');
    setWorkspaceView('writing');
  }
  function createOutline(kind: 'master_outline' | 'chapter_outline', chapterId = '') {
    if (!currentStructure) return;
    setNewKind(kind);
    setNewChapter(kind === 'chapter_outline' ? chapterId : '');
    setNewVolume('');
    setNewVolumeTitle('');
    setNewStoryTime('');
    setNewSummary('');
    const title = currentStructure.documents.find((document) => document.id === chapterId)?.title;
    const outlineCount = currentStructure.documents.filter((document) =>
      isStoryEventKind(document.kind),
    ).length;
    setNewTitle(kind === 'master_outline' ? '故事总纲' : (title ?? `故事事件 ${outlineCount + 1}`));
    setDialog('create-document');
  }
  async function startOutlineWriting(outlineId: string, newChapterTitle?: string) {
    const targetProject = projectId;
    const entry = await store.load(outlineId);
    await store.flush(outlineId);
    if (store.isDirty(entry) || ['error', 'conflict'].includes(entry.status))
      throw new Error('请先保存或处理事件大纲的修改');
    const latest = await api.structure(targetProject);
    const chapter = await api.startOutlineWriting(outlineId, {
      baseVersionId: entry.baseVersionId,
      baseStructureVersion: latest.project.structureVersion,
      volumeId: orderedChapters(latest).at(-1)?.volumeId ?? null,
      ...(newChapterTitle ? { newChapterTitle } : {}),
    });
    store.open(chapter);
    await refreshStructure(targetProject);
    if (activeProject.current !== targetProject) return;
    chooseDocument(chapter.document.id);
    setWorkspaceView('writing');
  }
  async function reorderEvents(sourceId: string, targetId: string) {
    if (!currentStructure) return;
    const documents = [...currentStructure.documents].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
    );
    const events = documents.filter(
      (document) => isStoryEventKind(document.kind) && !document.archived,
    );
    const source = events.findIndex((event) => event.id === sourceId);
    const target = events.findIndex((event) => event.id === targetId);
    if (source < 0 || target < 0 || source === target) return;
    const [moved] = events.splice(source, 1);
    if (!moved) return;
    events.splice(target, 0, moved);
    let next = 0;
    const reordered = documents.map((document, sortOrder) => ({
      ...(isStoryEventKind(document.kind) && !document.archived
        ? (events[next++] ?? document)
        : document),
      sortOrder,
    }));
    await api.putStructure(projectId, {
      baseStructureVersion: currentStructure.project.structureVersion,
      volumes: currentStructure.volumes.map(({ id, title, sortOrder }) => ({
        id,
        title,
        sortOrder,
      })),
      documents: reordered.map(({ id, title, volumeId, sortOrder }) => ({
        id,
        title,
        volumeId,
        sortOrder,
      })),
    });
    await refreshStructure(projectId);
  }
  function createChapter() {
    setNewKind('chapter');
    setNewTitle('');
    const outlineVolume = outlineVolumeOptions.find(
      (volume) => volume.value === `outline:${selected?.id}`,
    );
    const existingVolume = currentStructure?.volumes.find(
      (volume) => volume.title === selected?.title.trim(),
    );
    setNewVolume(
      selected?.kind === 'chapter'
        ? (selected.volumeId ?? '')
        : (existingVolume?.id ?? outlineVolume?.value ?? ''),
    );
    setNewVolumeTitle(outlineVolume?.title ?? '');
    setNewChapter('');
    setDialog('create-document');
  }
  async function saveBeforeOperation() {
    if (!draft) throw new Error('请先打开文档');
    await store.flush(draft.id);
    if (store.isDirty(draft) || draft.status === 'conflict' || draft.status === 'error')
      throw new Error('请先保存或处理当前草稿');
  }
  async function updatePlanningStatus(archived?: boolean) {
    if (!draft) return;
    await saveBeforeOperation();
    const current = await api.document(draft.id);
    if (archived === undefined) {
      const confirmed = await elementApi.confirm(draft.id, current.version.id);
      setPlanningConfirmation({ documentId: draft.id, versionId: confirmed.confirmedVersionId });
    } else {
      const data = readElementData(current.version.metadata);
      const updated = await api.save(draft.id, {
        baseVersionId: current.version.id,
        content: current.version.content,
        metadata: { ...current.version.metadata, element: { ...data, archived } },
      });
      store.replace(updated);
    }
    await refreshStructure(projectId);
  }
  async function applyWritingProposal(proposal: Proposal) {
    const targetProject = projectId;
    try {
      const entry = await store.load(proposal.targetDocumentId);
      await store.flush(entry.id);
      if (store.isDirty(entry) || ['error', 'conflict'].includes(entry.status))
        throw new Error('请先处理目标文档的草稿');
      await writingApi.accept(proposal.id, crypto.randomUUID());
      store.replace(await api.document(entry.id));
      await refreshStructure(targetProject);
      setWritingReview((previous) => (previous?.id === proposal.id ? null : previous));
    } finally {
      setProposalRefresh((value) => value + 1);
    }
  }
  async function rejectWritingProposal(proposal: Proposal) {
    await writingApi.reject(proposal.id);
    setWritingReview((previous) => (previous?.id === proposal.id ? null : previous));
    setProposalRefresh((value) => value + 1);
  }
  async function exportText(chapterId?: string) {
    if (!currentStructure) return;
    // Recover pending drafts even when they are not the currently open document.
    await store.recover(currentStructure.documents.map((document) => document.id));
    const pending = store
      .all()
      .filter((entry) => entry.projectId === projectId && (!chapterId || entry.id === chapterId));
    for (const entry of pending) {
      await store.flush(entry.id);
      if (store.isDirty(entry) || entry.status === 'conflict' || entry.status === 'error')
        throw new Error('导出前请先处理保存失败或版本冲突的草稿');
    }
    const anchor = window.document.createElement('a');
    anchor.href = api.exportUrl(projectId, chapterId);
    anchor.download = `${chapterId ? (selected?.title ?? '章节') : currentStructure.project.title}.txt`;
    window.document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }
  return (
    <div className="app-shell">
      {(error || projectError) && (
        <div className="global-error" role="alert">
          {error || projectError}
          <button
            type="button"
            onClick={() => {
              void run(async () => {
                await refreshProjects();
                if (projectId) await refreshStructure(projectId);
              });
            }}
          >
            刷新目录重试
          </button>
          <button type="button" aria-label="关闭提示" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      {location.state?.notice && (
        <p role="status" className="page-notice">
          {location.state.notice}
        </p>
      )}
      {documentId && currentStructure && !selected ? (
        <main className="empty">
          <p role="alert">文档不存在或不属于当前作品。</p>
          <button type="button" onClick={() => setDocumentId('')}>
            返回当前作品
          </button>
        </main>
      ) : !projectId ? (
        <ProjectLibrary
          projects={projects}
          deletedProjects={deletedProjects}
          busy={busy}
          onCreate={openCreateProject}
          onOpen={chooseProject}
          onRename={(project) => manageProject(project, 'rename-project')}
          onDelete={(project) => manageProject(project, 'delete-project')}
          onRestore={(id) =>
            run(async () => {
              await api.restoreProject(id);
              await refreshProjects();
            })
          }
        />
      ) : !currentStructure ? (
        <main className="empty">
          {error || projectError ? (
            <>
              <p>无法打开作品，作品可能不存在或已删除。</p>
              <Link to="/projects">返回作品管理</Link>
            </>
          ) : (
            <p role="status">正在读取作品…</p>
          )}
        </main>
      ) : (
        <>
          {(showingElements || showingForeshadows) && (
            <ElementPanel
              key={`${projectId}:${showingForeshadows ? 'foreshadow' : 'information'}`}
              projectId={projectId}
              structure={currentStructure}
              initialDocumentId={documentId}
              active={showingElements || showingForeshadows}
              scope={showingForeshadows ? 'foreshadow' : 'information'}
              onOpenOutline={async () => {
                if (needsSetup) await finishSetup();
                else {
                  const target = currentStructure.documents.find(
                    (document) =>
                      !document.archived &&
                      (document.kind === 'master_outline' || isStoryEventKind(document.kind)),
                  );
                  setDocumentId(target?.id ?? '');
                  setOutlineSection('events');
                  setWorkspaceView('outline');
                }
              }}
              onboarding={needsSetup}
              onFinishSetup={finishSetup}
              onModels={() => void navigate('/settings/models')}
              beforeOperation={async () => {
                await store.recover(currentStructure.documents.map((d) => d.id));
                for (const item of store.all().filter((d) => d.projectId === projectId)) {
                  await store.flush(item.id);
                  if (store.isDirty(item) || ['error', 'conflict'].includes(item.status))
                    throw new Error('请先处理写作草稿的保存错误或冲突');
                }
              }}
              onChanged={async () => {
                for (const item of store
                  .all()
                  .filter(
                    (d) => d.projectId === projectId && d.status === 'saved' && !store.isDirty(d),
                  ))
                  store.replace(await api.document(item.id));
                await refreshStructure(projectId);
              }}
              onOpenDocument={(id) => {
                chooseDocument(id);
                const document = currentStructure.documents.find((item) => item.id === id);
                if (document?.kind === 'chapter') setWorkspaceView('writing');
              }}
            />
          )}
          {!showingElements && !showingForeshadows && (
            <div
              className={`workbench ${showingOutline ? 'outline-workbench' : 'writing-workbench'}`}
              style={
                {
                  ...(showingElements ? { display: 'none' } : {}),
                  ...(outlineWidth === null
                    ? {}
                    : { '--outline-sidebar-width': `${outlineWidth}px` }),
                  ...(assistantWidth === null
                    ? {}
                    : { '--assistant-width': `${assistantWidth}px` }),
                } as CSSProperties
              }
            >
              {showingOutline && (
                <OutlineSidebar
                  structure={currentStructure}
                  documentId={documentId}
                  busy={busy}
                  onOpen={chooseDocument}
                  onCreate={createOutline}
                  onOpenWriting={openWriting}
                  onReorder={(source, target) => void run(() => reorderEvents(source, target))}
                  onAiCreate={(kind) =>
                    setComposerInsertion({
                      id: crypto.randomUUID(),
                      projectId,
                      text:
                        kind === 'master_outline'
                          ? '请根据作品基本信息与已有故事规划，生成一份完整的故事总纲，涵盖故事起点、主线推进、人物弧线、主要转折、高潮与结局，提交为待确认的故事总纲候选。'
                          : '请根据基本信息和故事总纲规划故事时间线，按事件实际发生的顺序拆分大事件，为每个事件提供名称、故事时间（可选）、概述和完整大纲，安排目标、冲突、转折与悬念。一个事件可以跨多个章节，不要按一章一个事件来拆分。',
                    })
                  }
                  onOpenForeshadows={() => setOutlineSection('foreshadow')}
                  onManage={() => setDialog('structure')}
                />
              )}
              {showingOutline && <OutlineResizeHandle onResize={setOutlineWidth} />}
              <main
                className="writing-area"
                aria-label={showingOutline ? '大纲编辑区' : '正文编辑区'}
              >
                <div
                  className={
                    blankTab === 'active' || (showPlan && planPreview) ? 'is-plan-view' : undefined
                  }
                >
                  {selected && draft ? (
                    <>
                      <div className="editor-tabs" role="tablist" aria-label="已打开文档">
                        {tabDocuments.map((item) => (
                          <span
                            key={item.id}
                            className={`editor-tab${item.id === documentId && !activeReview && !showPlan && blankTab !== 'active' ? ' is-active' : ''}`}
                          >
                            <button
                              type="button"
                              role="tab"
                              aria-selected={
                                item.id === documentId &&
                                !activeReview &&
                                !showPlan &&
                                blankTab !== 'active'
                              }
                              title={item.title}
                              onClick={() => selectTab(item.id)}
                            >
                              {item.title}
                            </button>
                            {tabDocuments.length > 1 && (
                              <button
                                type="button"
                                className="editor-tab-close"
                                aria-label={`关闭 ${item.title}`}
                                onClick={() => closeTab(item.id)}
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                        {planPreview && (
                          <span
                            className={`editor-tab is-ai${showPlan && blankTab !== 'active' ? ' is-active' : ''}`}
                          >
                            <button
                              type="button"
                              role="tab"
                              aria-selected={showPlan}
                              title={`${planPreview.label}：${planPreview.title}`}
                              onClick={() => {
                                setBlankTab((value) => (value === 'active' ? 'open' : value));
                                setShowPlan(true);
                              }}
                            >
                              {planPreview.label}
                            </button>
                            <button
                              type="button"
                              className="editor-tab-close"
                              aria-label={`关闭${planPreview.label}`}
                              onClick={() => {
                                setPlanPreview(null);
                                setShowPlan(false);
                              }}
                            >
                              ×
                            </button>
                          </span>
                        )}
                        {writingReview && (
                          <span
                            className={`editor-tab is-ai${activeReview && !showPlan && blankTab !== 'active' ? ' is-active' : ''}`}
                          >
                            <button
                              type="button"
                              role="tab"
                              aria-selected={Boolean(activeReview)}
                              title={`AI 输出预览：${reviewTarget?.title ?? ''}`}
                              onClick={() => {
                                setShowPlan(false);
                                setShowReview(true);
                                setReviewReveal((value) => value + 1);
                                chooseDocument(writingReview.targetDocumentId, true);
                              }}
                            >
                              AI 输出预览
                            </button>
                            <button
                              type="button"
                              className="editor-tab-close"
                              aria-label="关闭 AI 输出预览"
                              onClick={() => setWritingReview(null)}
                            >
                              ×
                            </button>
                          </span>
                        )}
                        {blankTab !== 'closed' && (
                          <span
                            className={`editor-tab${blankTab === 'active' ? ' is-active' : ''}`}
                          >
                            <button
                              type="button"
                              role="tab"
                              aria-selected={blankTab === 'active'}
                              onClick={() => setBlankTab('active')}
                            >
                              新标签页
                            </button>
                            <button
                              type="button"
                              className="editor-tab-close"
                              aria-label="关闭新标签页"
                              onClick={() => setBlankTab('closed')}
                            >
                              ×
                            </button>
                          </span>
                        )}
                        <button
                          type="button"
                          className="editor-tab-add"
                          aria-label="打开新标签页"
                          title="打开新标签页"
                          onClick={() => setBlankTab('active')}
                        >
                          +
                        </button>
                      </div>
                      {blankTab === 'active' && currentStructure && (
                        <section className="editor-start-page" aria-label="新标签页">
                          <h2>{currentStructure.project.title}</h2>
                          <h3>快速开始</h3>
                          <div className="start-actions">
                            <button type="button" onClick={() => createChapter()}>
                              新建章节
                            </button>
                            <button type="button" onClick={() => createOutline('chapter_outline')}>
                              新建故事事件
                            </button>
                            {planPreview && (
                              <button
                                type="button"
                                onClick={() => {
                                  setBlankTab('open');
                                  setShowPlan(true);
                                }}
                              >
                                查看{planPreview.label}
                              </button>
                            )}
                          </div>
                          {tabDocuments.length > 0 && (
                            <>
                              <h3>已打开</h3>
                              <ul>
                                {tabDocuments.map((item) => (
                                  <li key={item.id}>
                                    <button type="button" onClick={() => selectTab(item.id)}>
                                      {item.title}
                                      <small>{kindNames[item.kind]}</small>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                          {[
                            { label: '章节', items: orderedChapters(currentStructure) },
                            {
                              label: '大纲与事件',
                              items: currentStructure.documents.filter(
                                (item) =>
                                  !item.archived &&
                                  !item.deletedAt &&
                                  (item.kind === 'master_outline' || isStoryEventKind(item.kind)),
                              ),
                            },
                          ].map((group) => (
                            <div key={group.label}>
                              <h3>
                                {group.label} · {group.items.length}
                              </h3>
                              {group.items.length === 0 && <p className="muted">暂无</p>}
                              <ul>
                                {group.items.map((item) => (
                                  <li key={item.id}>
                                    <button type="button" onClick={() => selectTab(item.id)}>
                                      {item.title}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </section>
                      )}
                      {showPlan && planPreview && blankTab !== 'active' && (
                        <section className="editor-plan-preview" aria-label={planPreview.label}>
                          <WorkflowContent text={planPreview.content} />
                        </section>
                      )}
                      <div className={`editor-toolbar${activeReview ? ' is-review' : ''}`}>
                        <span className="editor-context">
                          <FileText size={14} aria-hidden="true" />
                          {kindNames[selected.kind]}
                          <span className="editor-context-divider" aria-hidden="true">
                            /
                          </span>
                          <span className="editor-context-mode">
                            {activeReview ? '修改对比' : showingOutline ? '大纲编辑' : '写作'}
                          </span>
                        </span>
                        {!showingOutline && selected.kind === 'chapter' && (
                          <select
                            className="editor-chapter-picker"
                            aria-label="切换章节"
                            value={selected.id}
                            onChange={(event) => chooseDocument(event.target.value)}
                          >
                            {orderedChapters(currentStructure).map((chapter) => (
                              <option key={chapter.id} value={chapter.id}>
                                {chapter.title}
                              </option>
                            ))}
                          </select>
                        )}
                        {activeReview ? (
                          <>
                            <span className="review-mode-label" role="status">
                              {activeReview.status === 'pending'
                                ? '待确认'
                                : activeReview.status === 'stale'
                                  ? '需重新生成'
                                  : '历史提议'}
                            </span>
                            <div className="editor-review-actions">
                              <button type="button" onClick={() => setWritingReview(null)}>
                                <ArrowLeft size={14} aria-hidden="true" />
                                返回编辑
                              </button>
                              {['pending', 'stale'].includes(activeReview.status) && (
                                <button
                                  type="button"
                                  className="review-reject"
                                  disabled={busy}
                                  onClick={() =>
                                    void run(() => rejectWritingProposal(activeReview))
                                  }
                                >
                                  <X size={14} aria-hidden="true" />
                                  拒绝
                                </button>
                              )}
                              {activeReview.status === 'pending' && (
                                <button
                                  type="button"
                                  className="review-accept"
                                  disabled={busy || reviewOutdated}
                                  title="写入正文并保存版本"
                                  onClick={() => void run(() => applyWritingProposal(activeReview))}
                                >
                                  <Check size={14} aria-hidden="true" />
                                  采纳修改
                                </button>
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <span
                              className={`save-status is-${draft.status} ${draft.status === 'error' || draft.status === 'conflict' ? 'error' : ''}`}
                              role="status"
                              aria-live="polite"
                            >
                              <span className="save-status-dot" aria-hidden="true" />
                              {statusNames[draft.status]}
                            </span>
                            <button
                              type="button"
                              className="editor-tool-button"
                              aria-label="立即保存"
                              onClick={() => {
                                void store.flush(documentId);
                              }}
                            >
                              <Save size={14} aria-hidden="true" />
                              保存
                            </button>
                            <button
                              type="button"
                              className="editor-tool-button"
                              aria-label="版本历史"
                              onClick={() => setDialog('history')}
                            >
                              <HistoryIcon size={14} aria-hidden="true" />
                              历史
                            </button>
                            <details
                              className="editor-document-menu"
                              key={documentId}
                              onToggle={(event) => {
                                const menu = event.currentTarget;
                                if (!menu.open) return;
                                const popover =
                                  menu.querySelector<HTMLElement>('.editor-menu-popover');
                                const bounds = menu
                                  .closest('.writing-area')
                                  ?.getBoundingClientRect();
                                if (!popover || !bounds) return;
                                const left = Math.max(
                                  bounds.left + 8,
                                  Math.min(
                                    menu.getBoundingClientRect().left,
                                    bounds.right - popover.offsetWidth - 8,
                                  ),
                                );
                                popover.style.left = `${left - menu.getBoundingClientRect().left}px`;
                              }}
                            >
                              <summary aria-label="文档操作" title="文档操作">
                                <Ellipsis size={18} aria-hidden="true" />
                                <span className="sr-only">文档操作</span>
                              </summary>
                              <div className="editor-menu-popover">
                                {!showingOutline && (
                                  <>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={(event) => {
                                        event.currentTarget
                                          .closest('details')
                                          ?.removeAttribute('open');
                                        createChapter();
                                      }}
                                    >
                                      <FileText size={14} aria-hidden="true" />
                                      新建章节
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={(event) => {
                                        event.currentTarget
                                          .closest('details')
                                          ?.removeAttribute('open');
                                        setDialog('import');
                                      }}
                                    >
                                      <Upload size={14} aria-hidden="true" />
                                      导入存稿
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={(event) => {
                                        event.currentTarget
                                          .closest('details')
                                          ?.removeAttribute('open');
                                        setDialog('structure');
                                      }}
                                    >
                                      <ListTree size={14} aria-hidden="true" />
                                      卷章管理
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={(event) => {
                                        event.currentTarget
                                          .closest('details')
                                          ?.removeAttribute('open');
                                        void run(() => exportText());
                                      }}
                                    >
                                      <Download size={14} aria-hidden="true" />
                                      导出整部作品 TXT
                                    </button>
                                  </>
                                )}
                                {selected.kind === 'chapter' && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={(event) => {
                                      event.currentTarget
                                        .closest('details')
                                        ?.removeAttribute('open');
                                      void run(() => exportText(selected.id));
                                    }}
                                  >
                                    <Download size={14} aria-hidden="true" />
                                    导出当前章节
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="danger-text"
                                  onClick={(event) => {
                                    event.currentTarget.closest('details')?.removeAttribute('open');
                                    setDialog('delete');
                                  }}
                                >
                                  <Trash2 size={14} aria-hidden="true" />
                                  删除文档
                                </button>
                              </div>
                            </details>
                          </>
                        )}
                      </div>
                      <div className={`document-canvas${activeReview ? ' is-reviewing' : ''}`}>
                        <div
                          className={`document-heading${activeReview ? ' review-document-heading' : ''}`}
                        >
                          <div className="document-kicker">
                            <span className="document-type-label">
                              {activeReview
                                ? '修改审阅'
                                : selected.kind === 'chapter'
                                  ? '章节草稿'
                                  : showingOutline
                                    ? '故事规划'
                                    : '创作资料'}
                            </span>
                            <span className="document-kicker-rule" aria-hidden="true" />
                          </div>
                          <h1>{selected.title}</h1>
                          <p>
                            {activeReview ? (
                              <>
                                <span className="review-heading-label">AI 修改建议</span>
                                <span>原文 {Array.from(draft.content).length} 字符</span>
                                <span>
                                  {activeReview.status === 'pending'
                                    ? '采纳后保存为新版本'
                                    : activeReview.status === 'accepted'
                                      ? showingOutline
                                        ? '已写入大纲'
                                        : '已写入正文'
                                      : '历史修改记录'}
                                </span>
                              </>
                            ) : (
                              <>
                                {Array.from(draft.content).length.toLocaleString()} 字符
                                {selection.to > selection.from
                                  ? ` · 已选中 ${Array.from(draft.content.slice(selection.from, selection.to)).length} 字符`
                                  : ''}
                              </>
                            )}
                          </p>
                        </div>
                        {showingOutline && isStoryEventKind(selected.kind) && !activeReview && (
                          <StoryEventDetails
                            key={selected.id}
                            event={selected}
                            structure={currentStructure}
                            busy={busy}
                            onOpenChapter={openWriting}
                            onAddChapter={(title) => startOutlineWriting(selected.id, title)}
                            onSave={async (input) => {
                              await saveBeforeOperation();
                              const updated = await api.updateStoryEvent(selected.id, input);
                              store.replace(updated);
                              await refreshStructure(projectId);
                            }}
                          />
                        )}
                        {draft.error && (
                          <div className="save-message error" role="alert">
                            {draft.error}
                            {draft.status === 'error' && (
                              <button
                                type="button"
                                onClick={() => {
                                  void store.flush(documentId);
                                }}
                              >
                                重试保存
                              </button>
                            )}
                          </div>
                        )}
                        {draft.recoveryWarning && (
                          <p className="warning" role="alert">
                            {draft.recoveryWarning}
                          </p>
                        )}
                        {activeReview ? (
                          <section
                            className="editor-proposal-review"
                            aria-label={showingOutline ? 'AI 大纲修改预览' : 'AI 正文修改预览'}
                          >
                            {reviewOutdated && activeReview.status === 'pending' && (
                              <p className="warning" role="status">
                                当前内容已变化，以下为生成时的原文对比。请返回编辑并重新生成提议。
                              </p>
                            )}
                            <ProposalDiff
                              key={activeReview.id}
                              proposal={activeReview}
                              contentLabel={showingOutline ? '大纲' : '正文'}
                              revealRequest={reviewReveal}
                            />
                          </section>
                        ) : (
                          <>
                            {(selected.kind === 'master_outline' ||
                              selected.kind === 'timeline_event') && (
                              <PlanningFields
                                kind={selected.kind}
                                versionId={draft.baseVersionId}
                                confirmedVersionId={
                                  planningConfirmation?.documentId === documentId
                                    ? planningConfirmation.versionId
                                    : undefined
                                }
                                dirty={store.isDirty(draft)}
                                metadataText={draft.metadataText}
                                onChange={(metadataText) =>
                                  store.edit(documentId, { metadataText })
                                }
                                structure={currentStructure}
                                onOpenDocument={chooseDocument}
                                busy={busy}
                                onArchiveChange={(archived) =>
                                  void run(() => updatePlanningStatus(archived))
                                }
                                onConfirm={() => void run(() => updatePlanningStatus())}
                              />
                            )}
                            <ContentEditor
                              key={documentId}
                              placeholder={
                                showingOutline
                                  ? '写下故事走向、关键事件、转折与人物的选择……'
                                  : undefined
                              }
                              value={draft.content}
                              onChange={(content) => store.edit(documentId, { content })}
                              onSelectionChange={setSelection}
                              onSendToAi={(text) =>
                                setComposerInsertion({
                                  id: crypto.randomUUID(),
                                  projectId,
                                  text: `引用《${selected.title}》：\n${text
                                    .split('\n')
                                    .map((line) => `> ${line}`)
                                    .join('\n')}\n\n`,
                                })
                              }
                            />
                            <details className="metadata">
                              <summary>
                                文档信息{selected.kind === 'character' ? ' · 人物别名与设定' : ''}
                              </summary>
                              <p className="muted">
                                使用 JSON 对象记录字段，例如{' '}
                                {`{"aliases":["阿舟"],"dominantHand":"左手"}`}
                                。与正文一起保存和恢复。
                              </p>
                              <label>
                                元数据 JSON
                                <textarea
                                  value={draft.metadataText}
                                  onChange={(event) =>
                                    store.edit(documentId, { metadataText: event.target.value })
                                  }
                                  rows={6}
                                  spellCheck={false}
                                />
                              </label>
                            </details>
                          </>
                        )}
                        {draft.status === 'conflict' && (
                          <section className="conflict-panel" aria-labelledby="conflict-title">
                            <h2 id="conflict-title">比较并处理版本冲突</h2>
                            <p>
                              下方展示“服务器最新内容 →
                              本地草稿”。正文和元数据仍可在上方编辑；确认后才以最新版本为基础保存。
                            </p>
                            {draft.remote ? (
                              <>
                                <DiffView
                                  before={draft.remote.version.content}
                                  after={draft.content}
                                />
                                <h3>元数据</h3>
                                <DiffView
                                  before={JSON.stringify(draft.remote.version.metadata, null, 2)}
                                  after={draft.metadataText}
                                />
                                <div className="row">
                                  <button
                                    type="button"
                                    className="primary"
                                    onClick={() => {
                                      void store.resolve(documentId, 'local');
                                    }}
                                  >
                                    以当前合并草稿保存
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void store.resolve(documentId, 'remote');
                                    }}
                                  >
                                    放弃本地草稿，采用服务器版本
                                  </button>
                                </div>
                              </>
                            ) : (
                              <p>读取服务器版本后才能比较。</p>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                void store.refreshConflict(documentId);
                              }}
                            >
                              重新读取服务器版本
                            </button>
                          </section>
                        )}
                        <footer className="editor-footer">
                          <span>Markdown</span>
                          <span>自动保存</span>
                        </footer>
                      </div>
                    </>
                  ) : (
                    <div className="empty">
                      <p className="eyebrow">{documentId ? '正在读取文档' : '给故事一个落点'}</p>
                      <h1>
                        {documentId
                          ? '稍等片刻…'
                          : showingOutline
                            ? '让故事有一条清晰的路。'
                            : '新建一章，开始写作。'}
                      </h1>
                      <p className="muted">
                        {showingOutline
                          ? '先写故事总纲，再为每一章安排目标、冲突、转折与悬念。'
                          : longForm
                            ? '新建章节或导入已有存稿，即可开始写作。'
                            : '新建正文或导入存稿，即可开始短篇写作。'}
                      </p>
                      {showingOutline && (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => createOutline('master_outline')}
                        >
                          新建故事总纲
                        </button>
                      )}
                      {!showingOutline && !documentId && (
                        <div className="writing-empty-actions">
                          <button
                            type="button"
                            className="primary"
                            disabled={busy}
                            onClick={createChapter}
                          >
                            新建章节
                          </button>
                          <button type="button" disabled={busy} onClick={() => setDialog('import')}>
                            导入存稿
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </main>
              <aside id="workspace-ai-assistant" className="context-aside" aria-label="AI 聊天侧栏">
                <AssistantResizeHandle onResize={setAssistantWidth} />
                <WritingPanel
                  key={projectId}
                  projectId={projectId}
                  shortForm={!longForm}
                  outlineMode={showingOutline}
                  document={selected}
                  selection={selection}
                  composerInsertion={
                    composerInsertion?.projectId === projectId ? composerInsertion : null
                  }
                  onComposerInsertionHandled={clearComposerInsertion}
                  beforeRun={async () => {
                    await store.recover(currentStructure.documents.map((doc) => doc.id));
                    for (const entry of store
                      .all()
                      .filter((entry) => entry.projectId === projectId)) {
                      await store.flush(entry.id);
                      if (store.isDirty(entry) || ['error', 'conflict'].includes(entry.status))
                        throw new Error('运行前请先处理保存失败或版本冲突的草稿');
                    }
                  }}
                  onProposalsChange={updateWritingProposals}
                  onReviewProposal={openWritingReview}
                  onPreviewPlan={(preview) => {
                    setPlanPreview(preview);
                    setShowPlan(true);
                  }}
                  onOutlinesCreated={async (id, outlineId) => {
                    const created = await api.document(outlineId);
                    await refreshStructure(id);
                    if (activeProject.current !== id) return;
                    store.open(created);
                    chooseDocument(outlineId);
                    setWorkspaceView(created.document.kind === 'chapter' ? 'writing' : 'outline');
                  }}
                  proposalRefresh={proposalRefresh}
                />
                <details className="workspace-notes">
                  <summary>{showingOutline ? '资料与待处理草稿' : '待处理草稿'}</summary>
                  {showingOutline && (
                    <p>
                      在“大纲”和“基本信息”页面管理故事规划与人物资料，它们与正文一样拥有独立的历史版本。
                    </p>
                  )}
                  {showingOutline && selected?.chapterId && (
                    <button type="button" onClick={() => chooseDocument(selected.chapterId ?? '')}>
                      打开关联章节
                    </button>
                  )}
                  {store
                    .all()
                    .filter(
                      (entry) =>
                        entry.projectId === projectId &&
                        entry.id !== documentId &&
                        entry.status !== 'saved' &&
                        (showingOutline ||
                          currentStructure.documents.find((document) => document.id === entry.id)
                            ?.kind === 'chapter'),
                    )
                    .map((entry) => (
                      <button
                        className="pending-draft"
                        type="button"
                        key={entry.id}
                        onClick={() => chooseDocument(entry.id)}
                      >
                        待处理：
                        {currentStructure.documents.find((item) => item.id === entry.id)?.title ??
                          '文档'}{' '}
                        · {statusNames[entry.status]}
                      </button>
                    ))}
                </details>
              </aside>
            </div>
          )}
        </>
      )}
      {(dialog === 'create-project' || dialog === 'rename-project') && (
        <Modal
          labelledBy="project-form-title"
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <form
            className="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                if (dialog === 'rename-project' && projectAction) {
                  await api.renameProject(
                    projectAction.id,
                    projectTitle,
                    projectAction.structureVersion,
                  );
                  if (projectAction.id === projectId) await refreshStructure(projectId);
                } else {
                  const created = await api.createProject(projectTitle, projectFormat);
                  chooseProject(created.id);
                }
                await refreshProjects();
                setDialog(null);
              });
            }}
          >
            <h2 id="project-form-title">
              {dialog === 'rename-project' ? '修改作品名' : '新建作品'}
            </h2>
            <label>
              作品名称
              <input
                required
                maxLength={200}
                value={projectTitle}
                onChange={(event) => setProjectTitle(event.target.value)}
              />
            </label>
            {dialog === 'create-project' && (
              <fieldset className="project-format-choice">
                <legend>作品篇幅</legend>
                <label>
                  <input
                    type="radio"
                    name="project-format"
                    value="long"
                    checked={projectFormat === 'long'}
                    onChange={() => setProjectFormat('long')}
                  />
                  <span>
                    <strong>长篇</strong>
                    <small>先填写基本信息、规划大纲，再展开正文写作。</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="project-format"
                    value="short"
                    checked={projectFormat === 'short'}
                    onChange={() => setProjectFormat('short')}
                  />
                  <span>
                    <strong>短篇</strong>
                    <small>直接进入正文写作，无需选择基本信息。</small>
                  </span>
                </label>
              </fieldset>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="row">
              <button className="primary" disabled={busy} type="submit">
                {dialog === 'rename-project' ? '保存作品名' : '创建作品'}
              </button>
              <button type="button" onClick={() => setDialog(null)}>
                取消
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === 'delete-project' && projectAction && (
        <Modal
          labelledBy="delete-project-title"
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <form
            className="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const target = projectAction;
                const latest = await api.structure(target.id);
                await store.recover(latest.documents.map((document) => document.id));
                for (const entry of store.all().filter((entry) => entry.projectId === target.id)) {
                  await store.flush(entry.id);
                  if (store.isDirty(entry) || ['error', 'conflict'].includes(entry.status))
                    throw new Error('删除前请先处理该作品未保存的草稿');
                }
                await api.deleteProject(target.id, target.structureVersion);
                setDialog(null);
                if (target.id === projectId) chooseProject('');
                setProjects((current) => current.filter((project) => project.id !== target.id));
                await refreshProjects();
              });
            }}
          >
            <h2 id="delete-project-title">删除作品「{projectAction.title}」？</h2>
            <p>
              作品将移入回收站，并从作品列表和选择菜单中移除。章节、基本信息、对话及历史会保留，可在回收站恢复。
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="row">
              <button className="danger" type="submit" disabled={busy}>
                {busy ? '正在处理…' : '移入回收站'}
              </button>
              <button type="button" disabled={busy} onClick={() => setDialog(null)}>
                取消
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === 'create-document' && currentStructure && (
        <Modal
          labelledBy="new-document-title"
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <form
            className="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const created = await api.createDocument(projectId, {
                  baseStructureVersion: currentStructure.project.structureVersion,
                  kind: newKind,
                  title: newTitle,
                  volumeId: newKind === 'chapter' && !creatingVolume ? newVolume || null : null,
                  ...(newKind === 'chapter' && creatingVolume ? { newVolumeTitle } : {}),
                  chapterId: newKind === 'chapter_outline' ? newChapter || null : null,
                  content: '',
                  ...(newKind === 'chapter_outline'
                    ? { storyTime: newStoryTime, summary: newSummary }
                    : {}),
                  metadata:
                    newKind === 'master_outline'
                      ? { element: elementDataSchema.parse({ nature: 'planned' }) }
                      : {},
                });
                store.open(created);
                await refreshStructure(projectId);
                chooseDocument(created.document.id);
                setWorkspaceView(
                  newKind === 'master_outline' || newKind === 'chapter_outline'
                    ? 'outline'
                    : 'writing',
                );
                setDialog(null);
              });
            }}
          >
            <h2 id="new-document-title">
              {newKind === 'chapter_outline'
                ? '添加故事事件'
                : showingOutline
                  ? '新建大纲'
                  : '新建文档'}
            </h2>
            <label>
              文档类型
              <select
                value={newKind}
                onChange={(event) => setNewKind(event.target.value as CreateDocument['kind'])}
              >
                {Object.entries(kindNames)
                  .filter(([kind]) =>
                    showingOutline
                      ? kind === 'master_outline' || kind === 'chapter_outline'
                      : longForm || kind === 'chapter',
                  )
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              文档名称
              <input
                required
                maxLength={200}
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
              />
            </label>
            {newKind === 'chapter' && (
              <>
                <label>
                  所属卷
                  <select
                    value={newVolume}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value;
                      setNewVolume(value);
                      setNewVolumeTitle(
                        outlineVolumeOptions.find((volume) => volume.value === value)?.title ?? '',
                      );
                    }}
                  >
                    <option value="">未分卷</option>
                    {currentStructure.volumes.map((volume) => (
                      <option key={volume.id} value={volume.id}>
                        {volume.title}
                      </option>
                    ))}
                    {outlineVolumeOptions.length > 0 && (
                      <optgroup label="按大纲创建卷">
                        {outlineVolumeOptions.map((volume) => (
                          <option key={volume.value} value={volume.value}>
                            {volume.title}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value="new">＋ 新建卷…</option>
                  </select>
                </label>
                {creatingVolume && (
                  <label>
                    新卷名称
                    <input
                      required
                      pattern=".*\S.*"
                      maxLength={200}
                      disabled={busy}
                      placeholder="例如：第一卷：初秋"
                      value={newVolumeTitle}
                      onChange={(event) => setNewVolumeTitle(event.target.value)}
                    />
                  </label>
                )}
              </>
            )}
            {newKind === 'chapter_outline' && (
              <>
                <label>
                  故事时间（可选）
                  <input
                    maxLength={200}
                    placeholder="例如：入学前、9月初—9月中旬、三年后"
                    value={newStoryTime}
                    onChange={(event) => setNewStoryTime(event.target.value)}
                  />
                </label>
                <label>
                  事件概述（可选）
                  <textarea
                    rows={3}
                    maxLength={1000}
                    placeholder="用一两句话概括这个大事件"
                    value={newSummary}
                    onChange={(event) => setNewSummary(event.target.value)}
                  />
                </label>
                <label>
                  先关联一个章节（可选，创建后可关联多个）
                  <select
                    value={newChapter}
                    onChange={(event) => setNewChapter(event.target.value)}
                  >
                    <option value="">暂不关联，先规划事件</option>
                    {orderedChapters(currentStructure).map((chapter) => (
                      <option key={chapter.id} value={chapter.id}>
                        {chapter.title}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="row">
              <button className="primary" disabled={busy} type="submit">
                {newKind === 'chapter_outline'
                  ? '添加事件'
                  : showingOutline
                    ? '创建大纲'
                    : '创建文档'}
              </button>
              <button type="button" onClick={() => setDialog(null)}>
                取消
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === 'structure' && currentStructure && (
        <StructureDialog
          structure={currentStructure}
          scope={showingOutline ? 'outlines' : 'chapters'}
          initialOutlineKind={
            selected && isStoryEventKind(selected.kind) ? 'chapter_outline' : 'master_outline'
          }
          onSaved={setStructure}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'import' && currentStructure && (
        <ImportDialog
          structure={currentStructure}
          onClose={() => setDialog(null)}
          onImported={async (ids) => {
            await refreshStructure(projectId);
            if (ids[0]) chooseDocument(ids[0]);
          }}
        />
      )}
      {dialog === 'history' && draft && (
        <History
          key={documentId}
          documentId={documentId}
          canRestore={!store.isDirty(draft) && draft.status === 'saved'}
          onClose={() => setDialog(null)}
          onRestore={async (id) => {
            await saveBeforeOperation();
            const result = await api.restore(documentId, draft.baseVersionId, id);
            store.replace(result);
          }}
        />
      )}
      {dialog === 'delete' && selected && draft && currentStructure && (
        <Modal
          labelledBy="delete-title"
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <div className="dialog">
            <h2 id="delete-title">删除“{selected.title}”？</h2>
            <p>
              {selected.kind === 'chapter'
                ? '正文会从目录移除，事件与历史保留。事件中的其他关联章节不受影响。'
                : '文档会从目录移除，历史仍保留。'}
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row">
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    await saveBeforeOperation();
                    await api.deleteDocument(
                      documentId,
                      draft.baseVersionId,
                      currentStructure.project.structureVersion,
                    );
                    store.forget(documentId);
                    setDocumentId('');
                    await refreshStructure(projectId);
                    setDialog(null);
                  });
                }}
              >
                确认删除文档
              </button>
              <button type="button" onClick={() => setDialog(null)}>
                取消
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
