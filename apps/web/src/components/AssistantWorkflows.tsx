import {
  type WorkflowInput,
  type WorkflowRun,
  type WorkflowTemplate,
  workflowInputSchema,
} from '@lingma/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { workflowApi } from '../workflow-api.js';

export const held = (run: WorkflowRun) => !['completed', 'cancelled'].includes(run.status);
export const statuses: Record<string, string> = {
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
  awaiting_gate: '等待放行',
  released: '已放行',
  stale: '已被替代',
};

export function useAssistantWorkflows(
  projectId: string,
  sessionId: string,
  requestedRunId = '',
  onOpenSession?: (id: string) => void,
) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [versionId, setVersionId] = useState('');
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [linkedRun, setLinkedRun] = useState<WorkflowRun | null>(null);
  const [linkError, setLinkError] = useState('');
  const [error, setError] = useState('');
  const scope = useRef({ projectId, sessionId });
  scope.current = { projectId, sessionId };
  useEffect(() => {
    let live = true;
    setLinkedRun(null);
    setLinkError('');
    if (requestedRunId)
      void workflowApi
        .run(requestedRunId)
        .then((run) => {
          if (!live) return;
          if (run.projectId !== projectId) throw new Error('运行记录不属于当前作品');
          onOpenSession?.(run.snapshot.input.sessionId ?? '');
          setLinkedRun(run);
        })
        .catch((cause: Error) => {
          if (live) setLinkError(cause.message);
        });
    return () => {
      live = false;
    };
  }, [projectId, requestedRunId, onOpenSession]);
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
      (run.snapshot.input.sessionId ?? '') !== scope.current.sessionId
    )
      return;
    setRuns((old) =>
      old.some((item) => item.id === run.id)
        ? old.map((item) => (item.id === run.id && item.revision <= run.revision ? run : item))
        : [...old, run],
    );
  }, []);
  const visibleRuns = [
    ...new Map([
      ...(linkedRun && (linkedRun.snapshot.input.sessionId ?? '') === sessionId
        ? [[linkedRun.id, linkedRun] as const]
        : []),
      ...runs.map((run) => [run.id, run] as const),
    ]).values(),
  ];
  const activeId = visibleRuns.find((run) => ['queued', 'running'].includes(run.status))?.id;
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
    runs: visibleRuns,
    error: linkError || error,
    update,
    refresh,
    start,
    active: visibleRuns.find(held) ?? null,
  };
}
