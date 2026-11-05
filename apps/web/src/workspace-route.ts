import { useCallback, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
export type WorkspaceView = 'writing' | 'outline' | 'information';
export function useWorkspaceRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const projectId = useParams().projectId ?? '';
  const segment = location.pathname.split('/').at(-1);
  const view: WorkspaceView =
    segment === 'outline' || segment === 'information' ? segment : 'writing';
  const documentId = new URLSearchParams(location.search).get('document') ?? '';
  const latest = useRef({ projectId, view, documentId, location, navigate });
  latest.current = { projectId, view, documentId, location, navigate };
  const pending = useRef<{ view: WorkspaceView; documentId: string; replace: boolean } | null>(
    null,
  );
  const update = useCallback(
    (patch: { view?: WorkspaceView; documentId?: string }, replace = false) => {
      const queued = pending.current;
      pending.current = {
        view: latest.current.view,
        documentId: latest.current.documentId,
        replace,
        ...queued,
        ...patch,
      };
      if (queued) return;
      queueMicrotask(() => {
        const target = pending.current;
        pending.current = null;
        if (!target || !latest.current.projectId) return;
        const params = new URLSearchParams(latest.current.location.search);
        if (target.documentId) params.set('document', target.documentId);
        else params.delete('document');
        const search = params.size ? `?${params}` : '';
        const url = `/projects/${latest.current.projectId}/${target.view}${search}`;
        if (url !== `${latest.current.location.pathname}${latest.current.location.search}`)
          void latest.current.navigate(url, {
            replace: target.replace,
            state: target.replace ? latest.current.location.state : null,
          });
      });
    },
    [],
  );
  const setDocumentId = useCallback(
    (id: string, replace = false) => update({ documentId: id }, replace),
    [update],
  );
  const setView = useCallback(
    (next: WorkspaceView, replace = false) => update({ view: next }, replace),
    [update],
  );
  return { projectId, documentId, view, setDocumentId, setView };
}
