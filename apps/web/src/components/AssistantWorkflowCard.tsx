import {
  effectiveAdoption,
  elementLabels,
  type ReviewIssue,
  type WorkflowArtifact,
  type WorkflowDecision,
  type WorkflowNode,
  type WorkflowRun,
  workflowTaskLabels,
} from '@lingma/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { workflowApi } from '../workflow-api.js';
import { writingApi } from '../writing-api.js';
import { held, statuses } from './AssistantWorkflows.js';
import { MarkdownContent } from './MarkdownContent.js';
import { RunDiagnostics } from './RunDiagnostics.js';
import { WorkflowContent } from './WorkflowContent.js';
import { WorkflowGraphEditor } from './WorkflowGraphEditor.js';

export type ArtifactPreview = { runId: string; title: string; content: string; label: string };
const kindLabels: Record<WorkflowArtifact['kind'], string> = {
  plan: '章纲 / 提纲',
  draft: '正文',
  records: '条目集',
  analysis: '分析',
  review: '审校意见',
  merge: '汇总意见',
};
const severityLabel = { P0: '必须改', P1: '建议改', P2: '仅供参考' } as const;

function NodeRuns({ runIds }: { runIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof writingApi.run>>[]>([]);
  const [error, setError] = useState('');
  const ids = runIds.join(',');
  useEffect(() => {
    if (!open || !ids) return;
    let live = true;
    void Promise.all(ids.split(',').map((id) => writingApi.run(id)))
      .then((next) => live && setRuns(next))
      .catch((cause: Error) => live && setError(cause.message));
    return () => {
      live = false;
    };
  }, [open, ids]);
  if (!runIds.length) return null;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>运行详情（思考与工具调用）</summary>
      {error && <p role="alert">{error}</p>}
      {runs.map((item) => (
        <RunDiagnostics key={item.id} run={item} connection="" />
      ))}
    </details>
  );
}

function ArtifactView({
  artifact,
  onPreview,
  title,
}: {
  artifact: WorkflowArtifact;
  title: string;
  onPreview?: ((preview: ArtifactPreview) => void) | undefined;
}) {
  const structured = artifact.kind === 'records' || artifact.kind === 'plan';
  return (
    <>
      <div className="workflow-plan-box">
        {structured ? (
          <WorkflowContent text={artifact.markdown} />
        ) : (
          <MarkdownContent text={artifact.markdown} />
        )}
      </div>
      {onPreview && (
        <button
          type="button"
          onClick={() =>
            onPreview({
              runId: artifact.workflowId,
              title,
              content: artifact.markdown,
              label: `${kindLabels[artifact.kind]}预览`,
            })
          }
        >
          在标签页中预览
        </button>
      )}
    </>
  );
}

function IssueRow({
  issue,
  run,
  disabled,
  onSet,
}: {
  issue: ReviewIssue;
  run: WorkflowRun;
  disabled: boolean;
  onSet(adoption: 'adopt' | 'ignore', reason: string): void;
}) {
  const decision = effectiveAdoption(issue, run.adoption);
  const [reason, setReason] = useState(run.adoption[issue.id]?.reason ?? '');
  return (
    <div className={`workflow-issue is-${issue.severity.toLowerCase()}`}>
      <strong>
        [{issue.severity} · {severityLabel[issue.severity]}] {issue.summary}
      </strong>
      {issue.quote && (
        <blockquote>
          {issue.quote}
          {!issue.located && <small>（未在稿件中找到该原句）</small>}
        </blockquote>
      )}
      {issue.body && <p className="workflow-request">{issue.body}</p>}
      {issue.sources.length > 0 && <small>来源：{issue.sources.join('、')}</small>}
      <div className="workflow-actions">
        <button
          type="button"
          disabled={disabled || decision === 'adopt'}
          onClick={() => onSet('adopt', '')}
        >
          采纳
        </button>
        <button
          type="button"
          disabled={disabled || decision === 'ignore'}
          onClick={() => onSet('ignore', reason)}
        >
          忽略
        </button>
        {issue.severity === 'P0' && (
          <input
            aria-label="忽略 P0 的理由"
            placeholder="忽略 P0 需要填写理由"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
        <span role="status">{decision === 'adopt' ? '已采纳' : '已忽略'}</span>
      </div>
    </div>
  );
}

export function AssistantWorkflowCard({
  run,
  onChange,
  beforeAccept,
  onSaved,
  onPreviewPlan,
}: {
  run: WorkflowRun;
  onChange(run: WorkflowRun): void;
  beforeAccept(): Promise<void>;
  onSaved(documentIds: string[]): Promise<void>;
  onPreviewPlan?: ((preview: ArtifactPreview) => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [edit, setEdit] = useState('');
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
    if (action !== 'set_adoption') setFeedback('');
  }
  async function accept(itemIds?: string[]) {
    await beforeAccept();
    if (run.proposal) {
      await writingApi.accept(run.proposal.id, key({ proposalId: run.proposal.id }));
      onChange(await workflowApi.run(run.id));
      if (run.targetDocumentId) await onSaved([run.targetDocumentId]);
      return;
    }
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
  const artifactOf = (node: WorkflowNode) => run.artifacts.find((a) => a.id === node.artifactId);
  const visibleNodes = useMemo(() => run.nodes.filter((n) => n.status !== 'stale'), [run.nodes]);
  const staleNodes = run.nodes.filter((n) => n.status === 'stale');
  const gateNode = run.nodes.find((n) => n.status === 'awaiting_gate');
  // Latest non-stale instance of each template node drives the graph colouring.
  const runStatus = useMemo(() => {
    const latest: Record<string, string> = {};
    for (const node of run.nodes)
      if (node.status !== 'stale') latest[node.templateKey] = node.status;
    return latest;
  }, [run.nodes]);
  const editable = ['awaiting_input', 'awaiting_acceptance', 'paused'].includes(run.status);
  const mergeNode = [...visibleNodes].reverse().find((n) => n.stage === 'merge' && n.artifactId);
  const merge = mergeNode ? artifactOf(mergeNode) : undefined;
  const adoptionOpen =
    Boolean(merge) && !['completed', 'cancelled'].includes(run.status) && !run.proposalId;
  const result = run.result;
  const task = run.snapshot.input.taskType;

  function renderNode(node: WorkflowNode) {
    const artifact = artifactOf(node);
    const editing = editingKey === node.key;
    return (
      <li key={node.key} className={`workflow-node is-${node.status}`}>
        <strong>{node.name}</strong>
        {node.round > 0 && <small> · 第 {node.round + 1} 轮</small>} ·{' '}
        {statuses[node.status] ?? node.status}
        {node.gate === 'manual' && <small> · 手动放行</small>}
        {node.error && <small>{node.error}</small>}
        {artifact && (
          <details open={node.status === 'awaiting_gate'}>
            <summary>
              查看返回内容（{kindLabels[artifact.kind]}
              {artifact.createdBy === 'author' ? ' · 作者编辑' : ''}）
            </summary>
            {editing ? (
              <>
                <textarea
                  aria-label={`编辑${node.name}`}
                  value={edit}
                  rows={14}
                  onChange={(event) => setEdit(event.target.value)}
                />
                <div className="workflow-actions">
                  <button
                    type="button"
                    disabled={busy || !edit.trim()}
                    onClick={() =>
                      void act(async () => {
                        await decide('edit_artifact', { nodeKey: node.key, content: edit });
                        setEditingKey(null);
                      })
                    }
                  >
                    保存修改
                  </button>
                  <button type="button" onClick={() => setEditingKey(null)}>
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <ArtifactView artifact={artifact} title={node.name} onPreview={onPreviewPlan} />
                {editable && node.stage !== 'merge' && run.acceptedResults.length === 0 && (
                  <div className="workflow-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEdit(artifact.markdown);
                        setEditingKey(node.key);
                      }}
                    >
                      编辑
                    </button>
                    {node.stage !== 'review' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => decide('rerun', { nodeKey: node.key }))}
                      >
                        重跑本节点
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </details>
        )}
        <NodeRuns runIds={node.runIds} />
      </li>
    );
  }

  return (
    <article className="assistant-workflow-card" aria-label="编排运行">
      <header>
        <strong>{run.snapshot.template.config.name}</strong>
        <span role="status">{statuses[run.status]}</span>
      </header>
      <p className="muted">{workflowTaskLabels[task]}</p>
      <p className="workflow-request">{run.snapshot.input.input}</p>
      {run.reason && <p>{run.reason}</p>}
      {error && <p role="alert">{error}</p>}
      <details className="workflow-run-graph">
        <summary>流程图（节点状态）</summary>
        <WorkflowGraphEditor
          config={run.snapshot.template.config}
          profiles={[]}
          onChange={() => {}}
          runStatus={runStatus}
          readOnly
        />
      </details>
      <ol className="assistant-workflow-stages">{visibleNodes.map(renderNode)}</ol>
      {staleNodes.length > 0 && (
        <details>
          <summary>已被替代的历史节点 · {staleNodes.length}</summary>
          <ul>
            {staleNodes.map((node) => (
              <li key={node.key}>
                {node.name}（第 {node.round + 1} 轮）
              </li>
            ))}
          </ul>
        </details>
      )}
      {adoptionOpen && merge && (
        <section aria-label="审校意见处理">
          <strong>审校意见 · {merge.issues.length} 条</strong>
          {merge.issues.length === 0 && <p>审校未提出需要处理的问题。</p>}
          {merge.issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              run={run}
              disabled={busy || !editable}
              onSet={(adoption, reason) =>
                void act(() => decide('set_adoption', { issueId: issue.id, adoption, reason }))
              }
            />
          ))}
        </section>
      )}
      {run.resultWarnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      {run.status === 'awaiting_acceptance' &&
        run.missingKinds.length > 0 &&
        run.acceptedResults.length === 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => decide('rerun_missing'))}
          >
            重跑缺失分类
          </button>
        )}
      {result?.type === 'element_candidates' && (
        <section aria-label="编排候选">
          {[...new Set(result.items.map((item) => item.kind))].map((kind) => {
            const items = result.items.filter((item) => item.kind === kind);
            const pending = items
              .filter((item) => !run.acceptedResults.some((a) => a.itemId === item.tempId))
              .map((item) => item.tempId);
            return (
              <section className="assistant-workflow-candidate-group" key={kind}>
                <header>
                  <strong>{elementLabels[kind]}</strong>
                  {run.status === 'awaiting_acceptance' && pending.length > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(() => accept(pending))}
                    >
                      采用本分类
                    </button>
                  )}
                </header>
                {items.map((item) => (
                  <details key={item.tempId} open>
                    <summary>
                      {item.title}
                      {run.acceptedResults.some((a) => a.itemId === item.tempId) ? ' · 已采用' : ''}
                    </summary>
                    {item.data.summary && <p>{item.data.summary}</p>}
                    <MarkdownContent text={item.content} />
                    <dl>
                      {Object.entries(item.data.fields).map(([field, value]) => (
                        <div key={field}>
                          <dt>{field}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    {run.status === 'awaiting_acceptance' && pending.includes(item.tempId) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => accept([item.tempId]))}
                      >
                        采用「{item.title}」
                      </button>
                    )}
                  </details>
                ))}
              </section>
            );
          })}
        </section>
      )}
      {result && result.type !== 'element_candidates' && run.status === 'awaiting_acceptance' && (
        <p className="muted">结果已解析，可在上方“正文 / 条目”节点中查看完整内容后采用。</p>
      )}
      {editable && (
        <label>
          处理意见
          <textarea
            aria-label="处理意见"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </label>
      )}
      <div className="workflow-actions">
        {(run.status === 'running' || run.status === 'queued') && (
          <button
            type="button"
            disabled={busy || run.pauseRequested}
            onClick={() => void act(() => decide('pause'))}
          >
            {run.pauseRequested ? '已请求暂停' : '暂停'}
          </button>
        )}
        {run.status === 'awaiting_input' && run.reasonCode === 'GATE' && gateNode && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act(() => decide('release', { nodeKey: gateNode.key }))}
          >
            放行「{gateNode.name}」
          </button>
        )}
        {run.status === 'awaiting_input' && run.reasonCode && run.reasonCode !== 'GATE' && (
          <button
            type="button"
            disabled={busy || (run.reasonCode === 'NO_CHANGE' && !feedback.trim())}
            onClick={() => void act(() => decide('continue'))}
          >
            {run.reasonCode === 'RESULT' ? '重新解析产物' : '按当前采纳继续复审'}
          </button>
        )}
        {run.status === 'awaiting_input' && run.latestDraftId && !run.reasonCode && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => decide('use_candidate'))}
          >
            使用当前完整候选
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
        {run.status === 'awaiting_acceptance' && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act(() => accept())}
          >
            {result?.type === 'element_candidates'
              ? '采用全部剩余条目'
              : `采用并保存${workflowTaskLabels[task]}`}
          </button>
        )}
        {editable && run.sourceChanges.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => decide('use_snapshot'))}
          >
            沿用冻结资料
          </button>
        )}
        {editable && run.latestDraftId && run.acceptedResults.length === 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await beforeAccept();
                onChange(await workflowApi.refreshSources(run.id, run.revision));
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
      {run.sourceChanges.length > 0 && (
        <p>
          资料已变化：{run.sourceChanges.join('、')}
          {run.sourceSnapshotAccepted ? '（已选择沿用快照）' : ''}
        </p>
      )}
      {run.acceptedResults.length > 0 && <p>已保存 {run.acceptedResults.length} 份文档。</p>}
      <details>
        <summary>用量</summary>
        <p>
          模型调用 {run.modelCalls} 次 · 输入 {run.usage.known.inputTokens ?? '未知'} / 输出{' '}
          {run.usage.known.outputTokens ?? '未知'} Token
        </p>
      </details>
    </article>
  );
}
