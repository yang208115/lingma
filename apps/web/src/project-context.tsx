import type { Structure } from '@lingma/shared';
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useMatch } from 'react-router';
import { api } from './api.js';
import { useRuntime } from './runtime.js';

type ProjectContextValue = {
  structure: Structure | null;
  setStructure: Dispatch<SetStateAction<Structure | null>>;
  error: string;
  refresh(id: string): Promise<Structure>;
};
const ProjectContext = createContext<ProjectContextValue | null>(null);
export function useProjectWorkspace() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('缺少作品上下文');
  return value;
}
export function ProjectWorkspaceProvider({ children }: { children: ReactNode }) {
  const projectId = useMatch('/projects/:projectId/*')?.params.projectId ?? '';
  const active = useRef(projectId);
  active.current = projectId;
  const requestVersion = useRef(0);
  const [structure, setStructure] = useState<Structure | null>(null);
  const [error, setError] = useState('');
  const { store } = useRuntime();
  const refresh = useCallback(
    async (id: string) => {
      const request = ++requestVersion.current;
      const latest = await api.structure(id);
      // Clean cached documents may have changed while editing a workflow or another page.
      for (const document of latest.documents) {
        const cached = store.get(document.id);
        if (
          cached?.status === 'saved' &&
          !store.isDirty(cached) &&
          cached.baseVersionId !== document.currentVersionId
        ) {
          const detail = await api.document(document.id);
          if (cached.status === 'saved' && !store.isDirty(cached)) store.replace(detail);
        }
      }
      if (active.current === id && request === requestVersion.current) {
        setStructure(latest);
        setError('');
      }
      return latest;
    },
    [store],
  );
  useEffect(() => {
    let live = true;
    setStructure(null);
    setError('');
    if (projectId)
      void refresh(projectId).catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [projectId, refresh]);
  return (
    <ProjectContext.Provider
      value={{
        structure: structure?.project.id === projectId ? structure : null,
        setStructure,
        error,
        refresh,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}
