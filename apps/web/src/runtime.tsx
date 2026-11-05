import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { useBlocker, useLocation } from 'react-router';
import { api } from './api.js';
import { Modal } from './components/Modal.js';
import { DraftStore } from './editor/drafts.js';

type Guard = { dirty: boolean; message: string };
const RuntimeContext = createContext<{
  store: DraftStore;
  guards: Map<symbol, () => Guard>;
} | null>(null);
export function useRuntime() {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('缺少应用上下文');
  return value;
}
export function useLeaveGuard(dirty: boolean, message = '有尚未保存的修改，离开将放弃这些编辑。') {
  const { guards } = useRuntime();
  const current = useRef({ dirty, message });
  current.current = { dirty, message };
  useEffect(() => {
    const id = Symbol();
    guards.set(id, () => current.current);
    const unload = (event: BeforeUnloadEvent) => {
      if (current.current.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      guards.delete(id);
      window.removeEventListener('beforeunload', unload);
    };
  }, [guards]);
}
export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [runtime] = useState(() => {
    let storage: Storage | undefined;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Server saving remains available. */
    }
    return { store: new DraftStore(api, storage), guards: new Map<symbol, () => Guard>() };
  });
  const { store, guards } = runtime;
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const location = useLocation();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (
      currentLocation.pathname === nextLocation.pathname &&
      currentLocation.search === nextLocation.search
    )
      return false;
    return (
      [...guards.values()].some((read) => read().dirty) ||
      (currentLocation.pathname !== nextLocation.pathname &&
        store
          .all()
          .some(
            (draft) =>
              store.isDirty(draft) || ['saving', 'error', 'conflict'].includes(draft.status),
          ))
    );
  });
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let live = true;
    setSaving(true);
    setError('');
    void (async () => {
      try {
        for (const draft of store.all()) {
          await store.flush(draft.id);
          if (store.isDirty(draft) || draft.status === 'conflict' || draft.status === 'error')
            throw new Error('页面尚未离开：请先处理正文或大纲的保存失败与版本冲突。');
        }
        if (!live) return;
        const dirty = [...guards.values()].map((read) => read()).find((guard) => guard.dirty);
        if (dirty) setPrompt(dirty.message);
        else blocker.proceed();
      } catch (cause) {
        if (live) {
          setError(cause instanceof Error ? cause.message : '保存失败');
          blocker.reset();
        }
      } finally {
        if (live) setSaving(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [blocker, guards, store]);
  useEffect(() => {
    if (location.key) setError('');
  }, [location.key]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (store.all().some((draft) => store.isDirty(draft))) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [store]);
  return (
    <RuntimeContext.Provider value={runtime}>
      {error && (
        <div role="alert" className="navigation-error">
          {error}
          <button type="button" onClick={() => setError('')}>
            关闭提示
          </button>
        </div>
      )}
      {saving && (
        <div className="navigation-status" role="status">
          正在保存草稿…
        </div>
      )}
      {children}
      {prompt && blocker.state === 'blocked' && (
        <Modal
          labelledBy="leave-page-title"
          onClose={() => {
            setPrompt('');
            blocker.reset();
          }}
        >
          <div className="dialog">
            <h2 id="leave-page-title">尚未保存的修改</h2>
            <p>{prompt}</p>
            <div className="row">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setPrompt('');
                  blocker.reset();
                }}
              >
                留在此页
              </button>
              <button
                type="button"
                onClick={() => {
                  setPrompt('');
                  blocker.proceed();
                }}
              >
                放弃修改并离开
              </button>
            </div>
          </div>
        </Modal>
      )}
    </RuntimeContext.Provider>
  );
}
