import type { Project, Structure } from '@lingma/shared';
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState } from 'react';
import {
  createBrowserRouter,
  Link,
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';
import { api } from './api.js';
import { ProjectNavigationPicker } from './components/ProjectNavigationPicker.js';
import { ShioriAvatar } from './components/Shiori.js';
import { ProjectWorkspaceProvider, useProjectWorkspace } from './project-context.js';
import { RuntimeProvider, useRuntime } from './runtime.js';
import { workflowApi } from './workflow-api.js';

const Workspace = lazy(() =>
  import('./workspace.js').then((module) => ({ default: module.Workspace })),
);
const SkillManager = lazy(() =>
  import('./components/SkillManager.js').then((module) => ({ default: module.SkillManager })),
);
const ProviderManager = lazy(() =>
  import('./components/ProviderManager.js').then((module) => ({ default: module.ProviderManager })),
);
const AgentPromptEditor = lazy(() =>
  import('./components/AgentPromptEditor.js').then((module) => ({
    default: module.AgentPromptEditor,
  })),
);

const WorkflowStudio = lazy(() =>
  import('./components/WorkflowStudio.js').then((module) => ({ default: module.WorkflowStudio })),
);
const titles: Record<string, string> = {
  projects: '作品管理',
  writing: '写作',
  outline: '大纲',
  information: '基本信息',
  skills: '通用 Skill',
  agents: 'Agent 角色库',
  'workflow-templates': '工作流模板',
  models: '模型设置',
  'agent-prompt': 'Agent 提示词',
};
const ProjectsContext = createContext<{ projects: Project[]; refresh(): Promise<void> }>({
  projects: [],
  refresh: async () => {},
});
export const useProjects = () => useContext(ProjectsContext);
function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadError, setLoadError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [lastProject, setLastProject] = useState(() => {
    try {
      return sessionStorage.getItem('lingma:last-project') ?? '';
    } catch {
      return '';
    }
  });
  const projectId =
    location.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? params.get('project') ?? lastProject;
  const refresh = useCallback(async () => {
    const items: Project[] = [];
    let cursor: string | null = null;
    do {
      const page = await api.projects(cursor ?? undefined);
      items.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    setProjects(items);
    setLoadError('');
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload project labels after navigation and mutations.
  useEffect(() => {
    void refresh().catch((e: Error) => setLoadError(e.message));
  }, [refresh, location.key]);
  useEffect(() => {
    if (projectId) {
      setLastProject(projectId);
      try {
        sessionStorage.setItem('lingma:last-project', projectId);
      } catch {
        /* Selection is optional. */
      }
    }
  }, [projectId]);
  useEffect(() => {
    const changed = () => {
      void refresh().catch((e: Error) => setLoadError(e.message));
    };
    window.addEventListener('lingma:projects-changed', changed);
    return () => window.removeEventListener('lingma:projects-changed', changed);
  }, [refresh]);
  useEffect(() => {
    if (!drawer) return;
    const sidebar = document.getElementById('global-sidebar');
    const previous = document.activeElement as HTMLElement | null;
    sidebar?.querySelector<HTMLElement>('a')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawer(false);
        previous?.focus();
      }
      if (event.key === 'Tab') {
        const nodes = Array.from(
          sidebar?.querySelectorAll<HTMLElement>('a, button, select, input') ?? [],
        ).filter((node) => node.getClientRects().length);
        const first = nodes[0];
        const last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [drawer]);
  const section = location.pathname.split('/').filter(Boolean).at(-1) ?? 'projects';
  // biome-ignore lint/correctness/useExhaustiveDependencies: Close the mobile drawer on every successful navigation.
  useEffect(() => {
    document.title = `${section === 'skills' && location.pathname.startsWith('/projects/') ? '项目 Skill' : (titles[section] ?? '未找到页面')} · 灵码`;
    setDrawer(false);
  }, [section, location.key]);
  const current = projects.find((project) => project.id === projectId);
  const projectLink = (view: string) => (current ? `/projects/${current.id}/${view}` : '/projects');
  const context = current
    ? `?${new URLSearchParams({ project: current.id, ...(params.get('document') ? { document: params.get('document') as string } : {}) })}`
    : '';
  return (
    <ProjectsContext.Provider value={{ projects, refresh }}>
      <div
        className={`multi-page-shell${collapsed ? ' nav-collapsed' : ''}${drawer ? ' nav-open' : ''}`}
      >
        <button
          className="mobile-navigation-toggle"
          type="button"
          aria-expanded={drawer}
          aria-controls="global-sidebar"
          onClick={() => setDrawer(!drawer)}
        >
          ☰ 导航
        </button>
        {drawer && (
          <button
            className="navigation-backdrop"
            type="button"
            aria-label="关闭导航"
            onClick={() => setDrawer(false)}
          />
        )}
        <aside id="global-sidebar" className="global-sidebar" aria-label="全局导航">
          <Link className="brand" to="/projects">
            <span className="mark">灵</span>
            {!collapsed && (
              <span>
                灵码<small>小说写作工作台</small>
              </span>
            )}
          </Link>
          <button
            className="sidebar-collapse"
            type="button"
            aria-label={collapsed ? '展开导航' : '收起导航'}
            onClick={() => {
              setCollapsed(!collapsed);
              setDrawer(false);
            }}
          >
            {collapsed ? '»' : '« 收起导航'}
          </button>
          <nav aria-label="页面导航">
            <div className="navigation-group">
              <p>作品管理</p>
              <NavLink aria-label="作品管理" to="/projects" end>
                📚 <span>作品管理</span>
              </NavLink>
            </div>
            <div className="navigation-group">
              <p>当前作品</p>
              <ProjectNavigationPicker
                projects={projects}
                value={current?.id ?? ''}
                onChange={(id) => {
                  if (!id) {
                    navigate('/projects');
                    return;
                  }
                  if (/^\/projects\//.test(location.pathname) || location.pathname === '/projects')
                    navigate(
                      `/projects/${id}/${location.pathname.endsWith('/skills') ? 'skills' : 'writing'}`,
                    );
                  else navigate(`${location.pathname}?${new URLSearchParams({ project: id })}`);
                }}
              />
              {current ? (
                <>
                  <NavLink aria-label="写作" to={projectLink('writing')}>
                    ✎ <span>写作</span>
                  </NavLink>
                  <NavLink aria-label="大纲" to={projectLink('outline')}>
                    ☷ <span>大纲</span>
                  </NavLink>
                  {current.format === 'long' && (
                    <NavLink aria-label="基本信息" to={projectLink('information')}>
                      ◇ <span>基本信息</span>
                    </NavLink>
                  )}
                  <NavLink aria-label="项目 Skill" to={projectLink('skills')}>
                    ▤ <span>项目 Skill</span>
                  </NavLink>
                </>
              ) : (
                <Link to="/projects">选择作品后开始创作</Link>
              )}
            </div>
            <div className="navigation-group">
              <p>创作工具</p>
              <NavLink aria-label="通用 Skill" to="/skills">
                ▤ <span>通用 Skill</span>
              </NavLink>
              <NavLink aria-label="Agent 角色库" to={`/agents${context}`}>
                ♙ <span>Agent 角色库</span>
              </NavLink>
              <NavLink aria-label="工作流模板" to={`/workflow-templates${context}`}>
                ⚑ <span>工作流模板</span>
              </NavLink>
            </div>
            <div className="navigation-group">
              <p>设置</p>
              <NavLink aria-label="模型设置" to="/settings/models">
                ⚙ <span>模型设置</span>
              </NavLink>
              <NavLink aria-label="Agent 提示词" to="/settings/agent-prompt">
                ⌘ <span>Agent 提示词</span>
              </NavLink>
            </div>
          </nav>
          <div className="sidebar-companion">
            <ShioriAvatar />
            <div>
              <span>栞在这里</span>
              <small>陪你写到下一页。</small>
            </div>
          </div>
          <small className="instance-label">本机工作区</small>
        </aside>
        <div className="page-content">
          {loadError && (
            <div role="alert" className="global-error">
              作品列表加载失败：{loadError}
              <button
                type="button"
                onClick={() => void refresh().catch((e: Error) => setLoadError(e.message))}
              >
                重试
              </button>
            </div>
          )}
          <Suspense fallback={<p role="status">正在加载页面…</p>}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </ProjectsContext.Provider>
  );
}
function Root() {
  return (
    <RuntimeProvider>
      <ProjectWorkspaceProvider>
        <AppShell />
      </ProjectWorkspaceProvider>
    </RuntimeProvider>
  );
}
function LegacyEntry() {
  const [params] = useSearchParams();
  const project = params.get('project');
  const view = ['outline', 'information'].includes(params.get('view') ?? '')
    ? params.get('view')
    : 'writing';
  const doc = params.get('document');
  return (
    <Navigate
      replace
      to={
        project
          ? `/projects/${encodeURIComponent(project)}/${view}${doc ? `?${new URLSearchParams({ document: doc })}` : ''}`
          : '/projects'
      }
    />
  );
}
function ManagementPage({ kind }: { kind: 'skills' | 'models' | 'agent-prompt' }) {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const { projects } = useProjects();
  const project = useProjectWorkspace();
  const title = kind === 'skills' && projectId ? '项目 Skill' : titles[kind];
  const close = () => {
    let destination = '/projects';
    try {
      destination = sessionStorage.getItem('lingma:last-workspace') ?? destination;
    } catch {
      /* Use project list. */
    }
    navigate(destination);
  };
  return (
    <main className="management-page" aria-label={title}>
      {kind === 'skills' ? (
        projectId && !project.structure ? (
          project.error ? (
            <div>
              <p role="alert">无法打开项目：{project.error}</p>
              <Link to="/projects">返回作品管理</Link>
            </div>
          ) : (
            <p role="status">正在读取项目…</p>
          )
        ) : (
          <SkillManager
            key={projectId ?? 'general'}
            projectId={projectId}
            projects={projects}
            onClose={close}
          />
        )
      ) : kind === 'models' ? (
        <ProviderManager onClose={close} />
      ) : (
        <AgentPromptEditor onClose={close} />
      )}
    </main>
  );
}
function LegacyWorkflowRedirect() {
  const { projectId = '' } = useParams();
  const [params] = useSearchParams();
  const requestedRun = params.get('run') ?? '';
  const documentId = params.get('document') ?? '';
  const [destination, setDestination] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!requestedRun) return;
    let live = true;
    setDestination('');
    setError('');
    void workflowApi
      .run(requestedRun)
      .then((run) => {
        if (!live) return;
        if (run.projectId !== projectId) throw new Error('运行记录不属于当前作品');
        const query = new URLSearchParams({ workflow: run.id });
        if (run.targetDocumentId || documentId)
          query.set('document', run.targetDocumentId || documentId);
        setDestination(`/projects/${projectId}/writing?${query}`);
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [projectId, requestedRun, documentId]);
  if (!requestedRun)
    return (
      <Navigate
        replace
        to={`/projects/${projectId}/writing${documentId ? `?${new URLSearchParams({ document: documentId })}` : ''}`}
      />
    );
  if (error)
    return (
      <main className="empty">
        <p role="alert">无法打开运行记录：{error}</p>
        <Link to={`/projects/${projectId}/writing`}>返回写作</Link>
      </main>
    );
  return destination ? (
    <Navigate replace to={destination} />
  ) : (
    <p role="status">正在打开运行记录…</p>
  );
}
function WorkflowPage({ mode }: { mode: 'profiles' | 'templates' }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { projects } = useProjects();
  const { store } = useRuntime();
  const projectId = params.get('project') ?? '';
  const documentId = params.get('document') ?? '';
  const [structure, setStructure] = useState<Structure | null>(null);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch explicitly retries a failed request.
  useEffect(() => {
    let live = true;
    setStructure(null);
    setError('');
    if (projectId)
      void api
        .structure(projectId)
        .then((value) => {
          if (live) setStructure(value);
        })
        .catch((e: Error) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [projectId, epoch]);
  const document = structure?.documents.find((item) => item.id === documentId);
  const update = (patch: Record<string, string>) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  if (error)
    return (
      <main className="empty">
        <p role="alert">无法打开作品：{error}</p>
        <button
          type="button"
          onClick={() => {
            setEpoch((value) => value + 1);
          }}
        >
          重试
        </button>
        <Link to="/projects">返回作品管理</Link>
      </main>
    );
  if (projectId && !structure)
    return (
      <main className="empty">
        <p role="status">正在读取作品…</p>
      </main>
    );
  if (documentId && structure && !document)
    return (
      <main className="empty">
        <p role="alert">文档不存在或不属于当前作品。</p>
        <button type="button" onClick={() => update({ document: '' })}>
          重新选择章节
        </button>
      </main>
    );
  return (
    <main
      className={`management-page${mode === 'profiles' ? ' agent-management-page' : ' template-management-page'}`}
      aria-label={mode === 'profiles' ? 'Agent 角色库' : '工作流模板'}
    >
      {mode === 'profiles' && (
        <div className="workflow-context row">
          {mode === 'profiles' && (
            <label>
              试运行作品
              <select
                value={projectId}
                onChange={(event) => update({ project: event.target.value, document: '', run: '' })}
              >
                <option value="">选择作品</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            试运行章节
            <select
              value={documentId}
              onChange={(event) => update({ document: event.target.value })}
            >
              <option value="">选择章节</option>
              {structure?.documents
                .filter((item) => item.kind === 'chapter')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}
      <WorkflowStudio
        key={`${mode}:${projectId}`}
        mode={mode}
        projectId={projectId}
        document={document}
        beforeRun={async () => {
          if (!structure || !document) throw new Error('请先选择作品和章节');
          await store.recover(structure.documents.map((item) => item.id));
          for (const draft of store.all().filter((item) => item.projectId === projectId)) {
            await store.flush(draft.id);
            if (store.isDirty(draft) || ['error', 'conflict'].includes(draft.status))
              throw new Error('请先处理未保存的正文草稿');
          }
        }}
        onClose={() => {
          navigate(
            projectId
              ? `/projects/${projectId}/writing${document ? `?${new URLSearchParams({ document: document.id })}` : ''}`
              : '/projects',
          );
        }}
      />
    </main>
  );
}
function NotFound() {
  return (
    <main className="empty">
      <h1>未找到页面</h1>
      <Link to="/projects">返回作品管理</Link>
    </main>
  );
}
export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { index: true, element: <LegacyEntry /> },
      { path: 'projects', element: <Workspace /> },
      { path: 'projects/:projectId', element: <Navigate to="writing" replace /> },
      ...(['writing', 'outline', 'information'] as const).map((view) => ({
        path: `projects/:projectId/${view}`,
        element: <Workspace />,
      })),
      { path: 'projects/:projectId/workflows', element: <LegacyWorkflowRedirect /> },
      { path: 'skills', element: <ManagementPage kind="skills" /> },
      { path: 'projects/:projectId/skills', element: <ManagementPage kind="skills" /> },
      { path: 'agents', element: <WorkflowPage mode="profiles" /> },
      { path: 'workflow-templates', element: <WorkflowPage mode="templates" /> },
      { path: 'settings', element: <Navigate to="models" replace /> },
      { path: 'settings/models', element: <ManagementPage kind="models" /> },
      { path: 'settings/agent-prompt', element: <ManagementPage kind="agent-prompt" /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
