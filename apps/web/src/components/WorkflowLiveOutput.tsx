import type { RunDetail, WorkflowNode } from '@lingma/shared';
import { Check, Circle, LoaderCircle } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { writingApi } from '../writing-api.js';
import { MarkdownContent } from './MarkdownContent.js';
import { workflowLiveText, workflowToolActivity } from './workflow-presentation.js';

export function WorkflowLiveSteps({ nodes }: { nodes: WorkflowNode[] }) {
  return (
    <ol className="workflow-live-steps" aria-label="执行步骤进度">
      {nodes.map((node) => {
        const complete = ['released', 'skipped'].includes(node.status);
        const active = ['queued', 'running'].includes(node.status);
        const Icon = complete ? Check : active ? LoaderCircle : Circle;
        return (
          <li
            key={node.key}
            className={`is-${node.status}`}
            aria-current={active ? 'step' : undefined}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{node.name}</span>
            <small>
              {complete
                ? node.status === 'skipped'
                  ? '已跳过'
                  : '已完成'
                : active
                  ? '进行中'
                  : node.status === 'pending'
                    ? '待开始'
                    : (node.error ?? '等待处理')}
            </small>
          </li>
        );
      })}
    </ol>
  );
}

export function WorkflowLiveOutput({ runId, name }: { runId: string; name: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const viewport = useRef<HTMLElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const next = await writingApi.run(runId, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(next);
        setReconnecting(false);
        if (!['queued', 'running', 'cancelling'].includes(next.status)) return;
      } catch {
        if (controller.signal.aborted) return;
        setReconnecting(true);
      }
      timer = setTimeout(() => void read(), 800);
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId]);
  const text = detail ? workflowLiveText(detail) : '';
  const activity = detail ? workflowToolActivity(detail) : '正在连接模型…';
  useLayoutEffect(() => {
    const element = viewport.current;
    if (element && following.current && text) element.scrollTop = element.scrollHeight;
  }, [text]);
  return (
    <section className="workflow-live-output" aria-label={`${name}实时输出`}>
      <div className="workflow-live-output-heading">
        <strong>{name}</strong>
        <span>{text ? `已生成 ${text.length.toLocaleString()} 字符` : '实时更新'}</span>
      </div>
      {reconnecting && (
        <p className="muted" role="status">
          暂时无法更新进度，正在重新连接…
        </p>
      )}
      {text ? (
        <section
          className="workflow-live-text"
          ref={viewport}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll generated text.
          tabIndex={0}
          aria-label={`${name}生成内容`}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
        >
          <MarkdownContent text={text} />
        </section>
      ) : (
        <p className="workflow-live-waiting" role="status">
          {activity}
        </p>
      )}
      {text && detail && ['queued', 'running', 'cancelling'].includes(detail.status) && (
        <p className="workflow-live-waiting">{activity}</p>
      )}
    </section>
  );
}
