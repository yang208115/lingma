import type { RunSummary, SessionHistory } from '@lingma/shared';
import {
  ArrowLeft,
  Check,
  History,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { writingApi } from '../writing-api.js';

const statusLabels: Record<RunSummary['status'], string> = {
  queued: '等待中',
  running: '生成中',
  cancelling: '停止中',
  completed: '已完成',
  limited: '达到限制',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
};
const purposeLabels = {
  write: '写作',
  rewrite: '改写',
  review: '讨论与规划',
  skill_test: 'Skill 试用',
};
function plain(text: string) {
  return text
    .replace(/[#*_`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function dateGroup(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function ChatHistory({
  projectId,
  activeSessionId,
  blocked,
  onClose,
  onNew,
  onOpen,
  onRun,
  onChanged,
}: {
  projectId: string;
  activeSessionId: string;
  blocked: boolean;
  onClose(): void;
  onNew(): void;
  onOpen(session: SessionHistory): void;
  onRun(session: SessionHistory, runId: string): void;
  onChanged(session: SessionHistory): void;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [sessions, setSessions] = useState<SessionHistory[]>([]);
  const [selected, setSelected] = useState<SessionHistory | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [renaming, setRenaming] = useState('');
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const disabled = working || blocked;

  useEffect(() => {
    if (!selected) input.current?.focus();
  }, [selected]);
  useEffect(() => {
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [renaming]);
  useEffect(() => {
    mounted.current = true;
    input.current?.focus();
    return () => {
      mounted.current = false;
      requestVersion.current++;
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError('');
    setCursor(null);
    setRenaming('');
    setDeleting('');
    setSessions([]);
    setRuns([]);
    const currentRequest = () => mounted.current && version === requestVersion.current;
    const request = selected
      ? writingApi.runs(projectId, selected.id).then((page) => {
          if (!currentRequest()) return;
          setRuns(page.data);
          setCursor(page.nextCursor);
        })
      : writingApi.sessions(projectId, undefined, search, deleted).then((page) => {
          if (!currentRequest()) return;
          setSessions(page.data);
          setCursor(page.nextCursor);
        });
    void request
      .catch((cause: unknown) => {
        if (mounted.current && version === requestVersion.current)
          setError(cause instanceof Error ? cause.message : '读取历史失败');
      })
      .finally(() => {
        if (mounted.current && version === requestVersion.current) setLoading(false);
      });
  }, [projectId, search, deleted, selected, revision]);

  async function mutate(action: () => Promise<SessionHistory>) {
    if (disabled) return;
    setWorking(true);
    setError('');
    try {
      const session = await action();
      onChanged(session);
      if (!mounted.current) return;
      setRevision((value) => value + 1);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      if (mounted.current) setWorking(false);
    }
  }
  async function more() {
    if (!cursor || loading || working) return;
    const version = requestVersion.current;
    setWorking(true);
    setError('');
    try {
      if (selected) {
        const page = await writingApi.runs(projectId, selected.id, cursor);
        if (!mounted.current || version !== requestVersion.current) return;
        setRuns((old) => [
          ...old,
          ...page.data.filter((item) => !old.some((existing) => existing.id === item.id)),
        ]);
        setCursor(page.nextCursor);
      } else {
        const page = await writingApi.sessions(projectId, cursor, search, deleted);
        if (!mounted.current || version !== requestVersion.current) return;
        setSessions((old) => [
          ...old,
          ...page.data.filter((item) => !old.some((existing) => existing.id === item.id)),
        ]);
        setCursor(page.nextCursor);
      }
    } catch (cause) {
      if (mounted.current && version === requestVersion.current)
        setError(cause instanceof Error ? cause.message : '读取历史失败');
    } finally {
      if (mounted.current) setWorking(false);
    }
  }

  let previousGroup = '';
  return (
    <section className="chat-history" aria-label="历史对话">
      <div className="chat-history-heading">
        <button
          type="button"
          className="icon-button"
          aria-label={selected ? '返回对话列表' : '返回聊天'}
          onClick={() => (selected ? setSelected(null) : onClose())}
        >
          <ArrowLeft size={17} />
        </button>
        <div>
          <h3>{selected ? '生成记录' : '历史对话'}</h3>
          <p>{selected ? selected.title : '找回灵感，接着上次聊。'}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新历史"
          title="刷新历史"
          disabled={working || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </button>
        {!selected && (
          <button type="button" className="history-new" disabled={disabled} onClick={onNew}>
            <Plus size={14} />
            新对话
          </button>
        )}
      </div>
      {!selected && (
        <>
          <label className="history-search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">搜索历史对话标题或内容</span>
            <input
              ref={input}
              type="search"
              maxLength={200}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题或对话内容…"
            />
          </label>
          <div className="history-tabs" aria-label="对话范围">
            <button
              type="button"
              aria-pressed={!deleted}
              disabled={working}
              onClick={() => setDeleted(false)}
            >
              全部对话
            </button>
            <button
              type="button"
              aria-pressed={deleted}
              disabled={working}
              onClick={() => setDeleted(true)}
            >
              <Trash2 size={13} />
              回收站
            </button>
          </div>
        </>
      )}
      {blocked && <p className="history-notice">当前任务结束后即可切换或管理对话。</p>}
      {error && (
        <p className="history-error" role="alert">
          {error}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
      <div className="history-list" aria-busy={loading}>
        {loading ? (
          <p className="history-empty" role="status">
            正在读取历史…
          </p>
        ) : selected ? (
          <>
            {runs.length === 0 && !error && (
              <p className="history-empty">这个对话还没有生成记录。</p>
            )}
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className="history-run"
                disabled={disabled}
                onClick={() => onRun(selected, run.id)}
              >
                <span className="history-run-meta">
                  <span>{purposeLabels[run.purpose]}</span>
                  <span className={`history-status is-${run.status}`}>
                    {statusLabels[run.status]}
                  </span>
                  <time dateTime={run.createdAt}>
                    {new Date(run.createdAt).toLocaleString('zh-CN')}
                  </time>
                </span>
                <strong>{plain(run.taskPreview) || '生成任务'}</strong>
                <span className="history-preview">
                  {plain(run.output?.text ?? '') ||
                    (run.stopReason
                      ? '本次未完成，可打开查看详情或重试。'
                      : '打开查看回复与修改建议')}
                </span>
              </button>
            ))}
          </>
        ) : (
          <>
            {sessions.length === 0 && !error && (
              <div className="history-empty">
                <MessageSquare size={25} />
                <h4>
                  {search ? '没有找到匹配的对话' : deleted ? '回收站是空的' : '还没有历史对话'}
                </h4>
                <p>
                  {search
                    ? '换个关键词，标题和对话内容都能搜索。'
                    : deleted
                      ? '删除的对话会暂存在这里，可以恢复。'
                      : '开始一次聊天，之后随时回来继续。'}
                </p>
              </div>
            )}
            {sessions.map((session) => {
              const group = dateGroup(session.deletedAt ?? session.updatedAt);
              const heading =
                group === previousGroup ? <></> : <h4 className="history-date">{group}</h4>;
              previousGroup = group;
              return (
                <div key={session.id}>
                  {heading}
                  <article
                    className={`history-session${session.id === activeSessionId ? ' is-current' : ''}`}
                  >
                    <button
                      type="button"
                      className="history-session-open"
                      disabled={disabled || deleted}
                      onClick={() => onOpen(session)}
                    >
                      <span className="history-session-title">
                        {session.title}
                        {session.id === activeSessionId && <small>当前对话</small>}
                      </span>
                      <span className="history-preview">
                        {plain(session.preview) || '还没有消息'}
                      </span>
                      <span className="history-session-meta">
                        <time dateTime={session.deletedAt ?? session.updatedAt}>
                          {new Date(session.deletedAt ?? session.updatedAt).toLocaleTimeString(
                            'zh-CN',
                            { hour: '2-digit', minute: '2-digit' },
                          )}
                        </time>
                        <span>
                          {session.messageCount} 条消息 · {session.runCount} 次生成
                        </span>
                        {session.latestRunStatus &&
                          ['running', 'queued', 'cancelling'].includes(session.latestRunStatus) && (
                            <span className="history-status">
                              {statusLabels[session.latestRunStatus]}
                            </span>
                          )}
                      </span>
                    </button>
                    <div className="history-session-actions">
                      {deleted ? (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => void mutate(() => writingApi.restoreSession(session.id))}
                        >
                          <Undo2 size={14} />
                          恢复对话
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => setSelected(session)}
                          >
                            <History size={13} />
                            生成记录
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`重命名对话：${session.title}`}
                            title="重命名"
                            disabled={disabled}
                            onClick={() => {
                              setRenaming(session.id);
                              setTitle(session.title);
                              setDeleting('');
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            className="icon-button history-trash"
                            aria-label={`删除对话：${session.title}`}
                            title="移入回收站"
                            disabled={disabled}
                            onClick={() => {
                              setDeleting(session.id);
                              setRenaming('');
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                    {renaming === session.id && (
                      <form
                        className="history-inline-action"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (title.trim())
                            void mutate(() => writingApi.renameSession(session.id, title.trim()));
                        }}
                      >
                        <label>
                          <span className="sr-only">对话名称</span>
                          <input
                            ref={renameInput}
                            aria-label="新的对话名称"
                            maxLength={200}
                            value={title}
                            disabled={working}
                            onChange={(event) => setTitle(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') setRenaming('');
                            }}
                          />
                        </label>
                        <button
                          type="submit"
                          className="icon-button"
                          aria-label="保存名称"
                          disabled={disabled || !title.trim()}
                        >
                          <Check size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="取消重命名"
                          disabled={working}
                          onClick={() => setRenaming('')}
                        >
                          <X size={16} />
                        </button>
                      </form>
                    )}
                    {deleting === session.id && (
                      <div className="history-delete-confirm">
                        <p>移入回收站后可恢复，小说正文和已保存的修改不受影响。</p>
                        <div>
                          <button
                            type="button"
                            className="danger"
                            disabled={disabled}
                            onClick={() => void mutate(() => writingApi.deleteSession(session.id))}
                          >
                            移入回收站
                          </button>
                          <button type="button" disabled={working} onClick={() => setDeleting('')}>
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                </div>
              );
            })}
          </>
        )}
        {!loading && cursor && (
          <button
            type="button"
            className="history-more"
            disabled={working}
            onClick={() => void more()}
          >
            {working ? '正在加载…' : '加载更早记录'}
          </button>
        )}
      </div>
    </section>
  );
}
