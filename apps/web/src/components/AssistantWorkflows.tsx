import {
  elementFields,
  type WorkflowArtifactPayload,
  type WorkflowDecision,
  type WorkflowInput,
  type WorkflowRun,
  type WorkflowTemplate,
  workflowArtifactPayloadSchema,
  workflowArtifactText,
  workflowInputSchema,
  workflowTaskLabels,
} from '@lingma/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { workflowApi } from '../workflow-api.js';
import { writingApi } from '../writing-api.js';
import { MarkdownContent } from './MarkdownContent.js';

const held = (run: WorkflowRun) => !['completed', 'cancelled'].includes(run.status);
const statuses: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  awaiting_input: '等待处理',
  awaiting_acceptance: '等待采用',
  paused: '已暂停',
  completed: '已结束',
  failed: '执行失败',
  limited: '上下文需要调整',
  cancelled: '已停止',
  interrupted: '已中断',
  pending: '待开始',
  succeeded: '已完成',
  skipped: '已跳过',
  invalidated: '已失效',
};

export function useAssistantWorkflows(projectId: string, sessionId: string) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [versionId, setVersionId] = useState('');
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState('');
  const scope = useRef({ projectId, sessionId });
  scope.current = { projectId, sessionId };
  useEffect(() => {
    let live = true;
    void workflowApi
      .templates()
      .then((items) => {
        if (live) setTemplates(items);
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!sessionId) {
      setRuns([]);
      return;
    }
    const items = await workflowApi.runs(projectId, sessionId);
    if (scope.current.projectId === projectId && scope.current.sessionId === sessionId)
      setRuns((old) => {
        const combined = new Map(
          old
            .filter((run) => run.snapshot.input.sessionId === sessionId)
            .map((run) => [run.id, run]),
        );
        for (const run of items.filter((run) => run.snapshot.input.sessionId === sessionId))
          if ((combined.get(run.id)?.revision ?? 0) <= run.revision) combined.set(run.id, run);
        return [...combined.values()].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
      });
  }, [projectId, sessionId]);
  useEffect(() => {
    setRuns([]);
    setError('');
    void refresh().catch((cause: Error) => setError(cause.message));
  }, [refresh]);
  const update = useCallback((run: WorkflowRun) => {
    if (
      run.projectId !== scope.current.projectId ||
      run.snapshot.input.sessionId !== scope.current.sessionId
    )
      return;
    setRuns((old) =>
      old.some((item) => item.id === run.id)
        ? old.map((item) => (item.id === run.id && item.revision <= run.revision ? run : item))
        : [...old, run],
    );
  }, []);
  const activeId = runs.find((run) => ['queued', 'running'].includes(run.status))?.id;
  useEffect(() => {
    if (!activeId) return;
    let live = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const run = await workflowApi.run(activeId);
        if (live) {
          update(run);
          setError('');
        }
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : '编排连接中断');
      } finally {
        reading = false;
      }
    };
    const source = new EventSource(`/api/v1/workflows/${activeId}/events`);
    source.addEventListener('change', () => void read());
    source.onerror = () => void read();
    const timer = window.setInterval(() => void read(), 2000);
    void read();
    return () => {
      live = false;
      source.close();
      window.clearInterval(timer);
    };
  }, [activeId, update]);
  const template = templates
    .flatMap((item) => item.versions)
    .find((version) => version.id === versionId);
  const keys = useRef(new Map<string, string>());
  const start = async (input: Omit<WorkflowInput, 'expectedPreviewHash'>) => {
    const preview = await workflowApi.preview(workflowInputSchema.parse(input));
    const body = { ...input, expectedPreviewHash: preview.hash };
    const identity = JSON.stringify(body);
    if (!keys.current.has(identity)) keys.current.set(identity, crypto.randomUUID());
    const run = await workflowApi.create(body, keys.current.get(identity) as string);
    // Session creation can be in flight while the composer hands off its first task.
    scope.current = { projectId, sessionId: input.sessionId ?? '' };
    update(run);
    return run;
  };
  return {
    templates,
    versionId,
    setVersionId,
    template,
    runs,
    error,
    update,
    refresh,
    start,
    active: runs.find(held) ?? null,
  };
}

export function AssistantWorkflowCard({
  run,
  onChange,
  beforeAccept,
  onSaved,
}: {
  run: WorkflowRun;
  onChange(run: WorkflowRun): void;
  beforeAccept(): Promise<void>;
  onSaved(documentIds: string[]): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState('');
  const [editPayload, setEditPayload] = useState<WorkflowArtifactPayload | null>(null);
  const keys = useRef(new Map<string, string>());
  function key(body: unknown) {
    const value = JSON.stringify(body);
    if (!keys.current.has(value)) keys.current.set(value, crypto.randomUUID());
    return keys.current.get(value) as string;
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '编排操作失败');
      try {
        onChange(await workflowApi.run(run.id));
      } catch {
        /* Keep the readable last snapshot. */
      }
    } finally {
      setBusy(false);
    }
  }
  async function decide(action: WorkflowDecision['action'], extra: Partial<WorkflowDecision> = {}) {
    const body = { expectedRevision: run.revision, action, feedback, ...extra };
    onChange(await workflowApi.decide(run.id, body, key(body)));
  }
  async function accept(itemIds?: string[]) {
    await beforeAccept();
    if (run.proposal) {
      await writingApi.accept(run.proposal.id, key({ proposalId: run.proposal.id }));
      const next = await workflowApi.run(run.id);
      onChange(next);
      if (run.targetDocumentId) await onSaved([run.targetDocumentId]);
    } else {
      const body = {
        expectedRevision: run.revision,
        action: 'accept_result' as const,
        feedback: '',
        ...(itemIds ? { itemIds } : {}),
      };
      const next = await workflowApi.decide(run.id, body, key(body));
      onChange(next);
      await onSaved(
        next.acceptedResults
          .filter((item) => !run.acceptedResults.some((old) => old.itemId === item.itemId))
          .map((item) => item.documentId),
      );
    }
  }
  const draft = run.artifacts.find((item) => item.id === run.latestDraftId);
  const plan = [...run.artifacts].reverse().find((item) => item.payload.type === 'chapter_plan');
  const reports = run.artifacts.filter(
    (item) =>
      item.payload.type === 'review_report' &&
      item.payload.reviewedArtifactId === run.latestDraftId,
  );
  const waiting = ['awaiting_input', 'awaiting_acceptance', 'paused'].includes(run.status);
  const payload = draft?.payload;
  const resultId = draft?.id ?? '';
  const eventCount = payload?.type === 'outline_event_batch' ? payload.items.length : 0;
  const eventKeys = useMemo(
    () => Array.from({ length: eventCount }, () => `${resultId}:${crypto.randomUUID()}`),
    [resultId, eventCount],
  );
  const remaining =
    payload?.type === 'element_candidates'
      ? payload.items.filter(
          (item) => !run.acceptedResults.some((accepted) => accepted.itemId === item.tempId),
        )
      : [];
  return (
    <article className="assistant-workflow-card" aria-label="编排运行">
      <header>
        <strong>{run.snapshot.template.config.name}</strong>
        <span role="status">{statuses[run.status]}</span>
      </header>
      <p className="muted">
        {workflowTaskLabels[run.snapshot.input.taskType]} ·{' '}
        {run.targetDocumentId ? '修改指定文档' : '新建候选'}
      </p>
      <p className="workflow-request">{run.snapshot.input.input}</p>
      {run.reason && <p>{run.reason}</p>}
      {error && <p role="alert">{error}</p>}
      <ol className="assistant-workflow-stages">
        {run.nodes.map((node) => (
          <li key={node.key}>
            {node.name} · {statuses[node.status] ?? node.status}
            {node.error && <small>{node.error}</small>}
          </li>
        ))}
      </ol>
      {plan?.payload.type === 'chapter_plan' && !run.planConfirmed && (
        <details open>
          <summary>章纲候选</summary>
          <MarkdownContent text={plan.payload.content} />
        </details>
      )}
      {payload && (
        <section aria-label="编排候选">
          {payload.type === 'element_candidates' ? (
            payload.items.map((item) => (
              <details key={item.tempId} open>
                <summary>
                  {item.title}
                  {run.acceptedResults.some((accepted) => accepted.itemId === item.tempId)
                    ? ' · 已采用'
                    : ''}
                </summary>
                {item.data.summary && <p>{item.data.summary}</p>}
                <MarkdownContent text={item.content} />
                <dl>
                  {Object.entries(item.data.fields).map(([field, value]) => (
                    <div key={field}>
                      <dt>{elementFields.worldbuilding[field] ?? field}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                {item.openQuestions.map((question) => (
                  <p key={question}>{question}</p>
                ))}
                {run.status === 'awaiting_acceptance' &&
                  remaining.some((candidate) => candidate.tempId === item.tempId) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(() => accept([item.tempId]))}
                    >
                      采用「{item.title}」
                    </button>
                  )}
              </details>
            ))
          ) : payload.type === 'outline_event_batch' ? (
            payload.items.map((item, index) => (
              <details key={eventKeys[index]} open>
                <summary>
                  {index + 1}. {item.title}
                </summary>
                <p>
                  {item.storyTime} {item.summary}
                </p>
                <MarkdownContent text={item.content} outline />
              </details>
            ))
          ) : (
            <details open>
              <summary>完整候选</summary>
              <MarkdownContent
                text={workflowArtifactText(payload)}
                outline={run.snapshot.input.taskType !== 'chapter_write'}
              />
            </details>
          )}
        </section>
      )}
      {reports.map(
        (report) =>
          report.payload.type === 'review_report' && (
            <details key={report.id} open={report.payload.issues.length > 0}>
              <summary>
                审校：{report.payload.domain} · {report.payload.issues.length} 条问题
              </summary>
              <p>已检查：{report.payload.coverage.join('、')}</p>
              {report.payload.uncovered.length > 0 && (
                <p>未覆盖：{report.payload.uncovered.join('、')}</p>
              )}
              {report.payload.issues.map((issue) => (
                <div key={issue.id}>
                  <strong>
                    {issue.severity} · {issue.description}
                  </strong>
                  <blockquote>{issue.quote}</blockquote>
                  <p>{issue.suggestion}</p>
                </div>
              ))}
            </details>
          ),
      )}
      {waiting && (
        <label>
          处理意见
          <textarea
            aria-label="编排处理意见"
            value={feedback}
            maxLength={8000}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </label>
      )}
      {editing && (
        <div>
          {editPayload?.type === 'element_candidates' ? (
            editPayload.items.map((item, index) => (
              <fieldset key={item.tempId}>
                <legend>{item.title}</legend>
                <label>
                  标题
                  <input
                    value={item.title}
                    maxLength={200}
                    onChange={(event) =>
                      setEditPayload({
                        ...editPayload,
                        items: editPayload.items.map((candidate, i) =>
                          i === index ? { ...candidate, title: event.target.value } : candidate,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  说明
                  <textarea
                    value={item.content}
                    onChange={(event) =>
                      setEditPayload({
                        ...editPayload,
                        items: editPayload.items.map((candidate, i) =>
                          i === index ? { ...candidate, content: event.target.value } : candidate,
                        ),
                      })
                    }
                  />
                </label>
                {Object.entries(elementFields.worldbuilding).map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <textarea
                      value={item.data.fields[field] ?? ''}
                      onChange={(event) =>
                        setEditPayload({
                          ...editPayload,
                          items: editPayload.items.map((candidate, i) =>
                            i === index
                              ? {
                                  ...candidate,
                                  data: {
                                    ...candidate.data,
                                    fields: {
                                      ...candidate.data.fields,
                                      [field]: event.target.value,
                                    },
                                  },
                                }
                              : candidate,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </fieldset>
            ))
          ) : editPayload?.type === 'outline_event_batch' ? (
            editPayload.items.map((item, index) => (
              <fieldset key={eventKeys[index]}>
                <legend>事件 {index + 1}</legend>
                <label>
                  标题
                  <input
                    value={item.title}
                    maxLength={200}
                    onChange={(event) =>
                      setEditPayload({
                        ...editPayload,
                        items: editPayload.items.map((candidate, i) =>
                          i === index ? { ...candidate, title: event.target.value } : candidate,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  完整纲要
                  <textarea
                    value={item.content}
                    onChange={(event) =>
                      setEditPayload({
                        ...editPayload,
                        items: editPayload.items.map((candidate, i) =>
                          i === index ? { ...candidate, content: event.target.value } : candidate,
                        ),
                      })
                    }
                  />
                </label>
              </fieldset>
            ))
          ) : (
            <label>
              编辑完整候选
              <textarea
                aria-label="编辑编排候选"
                value={edit}
                onChange={(event) => setEdit(event.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            disabled={busy || !edit.trim()}
            onClick={() =>
              void act(async () => {
                let next: WorkflowArtifactPayload;
                if (payload?.type === 'chapter_draft') next = { ...payload, content: edit };
                else if (payload?.type === 'master_outline_candidate')
                  next = { ...payload, content: edit };
                else next = workflowArtifactPayloadSchema.parse(editPayload);
                await decide('edit_candidate', { payload: next });
                setEditing(false);
              })
            }
          >
            保存候选并重新审校
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            取消编辑
          </button>
        </div>
      )}
      {run.sourceChanges.length > 0 && (
        <p>
          资料已变化：{run.sourceChanges.join('、')}
          {run.sourceSnapshotAccepted ? '（已选择沿用快照）' : ''}
        </p>
      )}
      <div className="workflow-actions">
        {run.status === 'running' || run.status === 'queued' ? (
          <button
            type="button"
            disabled={busy || run.pauseRequested}
            onClick={() => void act(() => decide('pause'))}
          >
            {run.pauseRequested ? '已请求暂停' : '暂停'}
          </button>
        ) : null}
        {run.status === 'awaiting_input' && !run.planConfirmed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => decide('confirm_plan'))}
          >
            确认章纲并继续
          </button>
        )}
        {run.status === 'awaiting_input' && run.planConfirmed && (
          <button
            type="button"
            disabled={busy || !feedback.trim()}
            onClick={() => void act(() => decide('continue'))}
          >
            提交意见并继续
          </button>
        )}
        {['paused', 'interrupted', 'failed', 'limited'].includes(run.status) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => decide(run.status === 'paused' ? 'resume' : 'retry'))}
          >
            恢复 / 重试
          </button>
        )}
        {waiting && payload && run.acceptedResults.length === 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEdit('content' in payload ? payload.content : JSON.stringify(payload, null, 2));
              setEditPayload(structuredClone(payload));
              setEditing(true);
            }}
          >
            编辑候选
          </button>
        )}
        {run.status === 'awaiting_input' &&
          run.latestDraftId &&
          run.nodes.every((node) => ['succeeded', 'skipped'].includes(node.status)) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => decide('use_candidate'))}
            >
              使用当前完整候选
            </button>
          )}
        {run.status === 'awaiting_acceptance' && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act(() => accept())}
          >
            {payload?.type === 'element_candidates'
              ? '采用全部剩余世界观'
              : `采用并保存${workflowTaskLabels[run.snapshot.input.taskType]}`}
          </button>
        )}
        {waiting && run.sourceChanges.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => decide('use_snapshot'))}
          >
            沿用冻结资料
          </button>
        )}
        {waiting && payload && run.acceptedResults.length === 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await beforeAccept();
                onChange(
                  await workflowApi.refreshSources(
                    run.id,
                    run.revision,
                    payload.type === 'chapter_draft' && editing ? edit : undefined,
                  ),
                );
              })
            }
          >
            刷新资料并复审
          </button>
        )}
        {held(run) && (
          <button type="button" disabled={busy} onClick={() => void act(() => decide('cancel'))}>
            结束并释放作品
          </button>
        )}
      </div>
      {run.acceptedResults.length > 0 && <p>已保存 {run.acceptedResults.length} 份文档。</p>}
      <Link to={`/projects/${run.projectId}/workflows`}>查看完整运行记录</Link>
    </article>
  );
}
