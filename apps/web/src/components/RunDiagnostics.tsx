import type { Proposal, RunDetail } from '@lingma/shared';
import {
  Check,
  ChevronRight,
  Clock,
  Copy,
  Layers,
  Maximize2,
  Minimize2,
  Search,
  Wrench,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal.js';

const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  cancelling: '正在停止',
  complete: '已完成',
  completed: '已完成',
  limited: '达到限制',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
};
const toolLabels: Record<string, string> = {
  read_document: '读取文档',
  search_documents: '搜索资料',
  propose_document_change: '提交修改建议',
  propose_chapter_creation: '新建章节候选',
  propose_master_outline: '生成故事总纲候选',
  propose_chapter_outlines: '创建故事事件候选',
  load_skill: '读取 Skill',
  read_skill_file: '读取 Skill 附件',
  submit_workflow_artifact: '提交协作成果',
};
const count = (value: number | null) => (value === null ? '未提供' : value.toLocaleString('zh-CN'));
const shortId = (value: string) =>
  value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="debug-copy"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed');
        }
      }}
    >
      {state === 'copied' ? (
        <Check size={12} aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
      <span aria-live="polite">
        {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制'}
      </span>
    </button>
  );
}

function Identifier({ label, value }: { label: string; value: string }) {
  return (
    <div className="debug-identifier">
      <span>{label}</span>
      <code title={value}>{shortId(value)}</code>
      <CopyButton text={value} label={`复制${label}`} />
    </div>
  );
}

function JsonContent({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? 'null', [value]);
  return (
    <div className="debug-json-content">
      <div className="debug-json-toolbar">
        <span>JSON</span>
        <CopyButton text={text} label="复制原始 JSON" />
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function DebugJson({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="debug-json" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <ChevronRight size={13} aria-hidden="true" />
        {label}
      </summary>
      {open &&
        (value === null || value === undefined ? (
          <p className="debug-empty">暂无数据</p>
        ) : (
          <JsonContent value={value} />
        ))}
    </details>
  );
}

export function ProposalDiagnostics({
  proposal,
  contexts,
}: {
  proposal: Proposal;
  contexts: RunDetail['contexts'];
}) {
  return (
    <details className="debug-proposal-source">
      <summary>
        <ChevronRight size={13} aria-hidden="true" />
        修改范围与引用
      </summary>
      <div>
        <p>{proposal.scope.kind === 'selection' ? '替换选中的文字' : '替换完整文档'}</p>
        <Identifier label="基准版本" value={proposal.baseVersionId} />
        {proposal.citations.length ? (
          proposal.citations.map((citation) => (
            <div className="debug-citation" key={citation}>
              <span>
                {contexts.find((entry) => entry.citationId === citation)?.title ?? '资料引用'}
              </span>
              <Identifier label="引用标识" value={citation} />
            </div>
          ))
        ) : (
          <p className="debug-empty">本次提议没有标注引用。</p>
        )}
        <DebugJson label="完整修改范围" value={proposal.scope} />
      </div>
    </details>
  );
}

type TraceKind = 'system' | 'user' | 'context' | 'assistant' | 'thinking' | 'tool';
type TraceRow = {
  id: string;
  kind: TraceKind;
  title: string;
  content: string;
  result: string;
  data: unknown;
  turn: number | null;
  call: number;
  start: number | null;
  end: number | null;
  status: string;
  input: boolean;
};
const kindLabels: Record<TraceKind, string> = {
  system: '系统',
  user: '用户',
  context: '上下文',
  assistant: '助手',
  thinking: '思考',
  tool: '工具',
};
const laneFor = (row: TraceRow) => (row.input ? 'input' : row.kind === 'tool' ? 'tool' : 'model');
const compact = (text: string) => text.slice(0, 1000).replace(/\s+/g, ' ').trim();
const json = (value: unknown) => JSON.stringify(value) ?? '';
const elapsed = (start: number | null, end: number | null) => {
  if (start === null || end === null) return '时间未记录';
  const seconds = Math.max(0, end - start) / 1000;
  return seconds < 60
    ? `${seconds.toFixed(2)}s`
    : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
};

function inputRows(run: Pick<RunDetail, 'input' | 'preview' | 'createdAt'>): TraceRow[] {
  const start = Date.parse(run.createdAt);
  const base = { result: '', turn: null, call: 0, start, end: start, status: '', input: true };
  const rows: TraceRow[] = [
    {
      ...base,
      id: 'system',
      kind: 'system',
      title: '初始系统提示词',
      content: run.preview.request.systemPrompt,
      data: null,
    },
  ];
  const first = run.preview.request.messages.find((message) => message.role === 'user');
  let payload: Record<string, unknown> = {};
  if (first?.role === 'user') {
    try {
      payload = record(JSON.parse(first.content));
    } catch {
      /* Some older snapshots contain plain text. */
    }
  }
  if (Array.isArray(payload.history)) {
    payload.history.forEach((entry, index) => {
      const item = record(entry);
      if (typeof item.content !== 'string') return;
      rows.push({
        ...base,
        id: `history:${index}`,
        kind: item.role === 'assistant' ? 'assistant' : 'user',
        title: '历史消息',
        content: item.content,
        data: entry,
      });
    });
  }
  rows.push({
    ...base,
    id: 'user',
    kind: 'user',
    title: '本次用户输入',
    content: run.input.input,
    data: null,
  });
  if (run.preview.allowed.length)
    rows.push({
      ...base,
      id: 'directory',
      kind: 'context',
      title: `可读取资料目录 · ${run.preview.allowed.length} 份`,
      content: run.preview.allowed.map((entry) => entry.title).join('、'),
      data: run.preview.allowed,
    });
  run.preview.entries.forEach((entry) =>
    rows.push({
      ...base,
      id: `context:${entry.citationId}`,
      kind: 'context',
      title: entry.title,
      content: entry.excerpt,
      data: entry,
    }),
  );
  if (run.preview.request.toolDefinitions.length)
    rows.push({
      ...base,
      id: 'permissions',
      kind: 'context',
      title: `工具权限 · ${run.preview.request.toolDefinitions.length} 项`,
      content: run.preview.request.toolDefinitions
        .map((item) => {
          const tool = record(item);
          const name = typeof tool.name === 'string' ? tool.name : record(tool.function).name;
          return typeof name === 'string' ? name : '工具定义';
        })
        .join('、'),
      data: run.preview.request.toolDefinitions,
    });
  return rows;
}

export function RunDiagnostics({ run, connection }: { run: RunDetail; connection: string }) {
  const [axis, setAxis] = useState<'time' | 'turn' | 'call'>('turn');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const titleId = useId();
  const elements = useRef(new Map<string, HTMLDetailsElement>());
  const initialRows = useMemo(
    () => inputRows({ input: run.input, preview: run.preview, createdAt: run.createdAt }),
    [run.input, run.preview, run.createdAt],
  );
  const toolContent = useMemo(
    () =>
      new Map(
        run.tools.map((tool) => [
          tool.id,
          {
            args: json(tool.args),
            result: json(tool.result),
          },
        ]),
      ),
    [run.tools],
  );
  const rows = useMemo(() => {
    const result = [...initialRows];
    const events = new Map(
      run.trace.map((event) => [
        `${event.type}:${event.executionId ?? event.turnIndex ?? ''}`,
        Date.parse(event.createdAt),
      ]),
    );
    const active = ['running', 'queued', 'cancelling'].includes(run.status);
    let call = 0;
    for (const turn of run.turns) {
      const start = events.get(`turn.started:${turn.turnIndex}`) ?? null;
      const tools = run.tools.filter((tool) => tool.turnIndex === turn.turnIndex);
      const firstToolStart = tools[0] ? events.get(`tool.started:${tools[0].id}`) : undefined;
      const end =
        firstToolStart ??
        events.get(`turn.completed:${turn.turnIndex}`) ??
        (active && turn.status !== 'complete' && start !== null ? Date.now() : null);
      const base = {
        turn: turn.turnIndex,
        call: call + 1,
        start,
        end,
        status: turn.status,
        result: '',
        input: false,
      };
      if (turn.thinking)
        result.push({
          ...base,
          start: null,
          end: null,
          id: `thinking:${turn.turnIndex}`,
          kind: 'thinking',
          title: '模型思考',
          content: turn.thinking,
          data: null,
        });
      result.push({
        ...base,
        id: `assistant:${turn.turnIndex}`,
        kind: 'assistant',
        title: '模型回复',
        content:
          turn.partialText ||
          (tools.length
            ? '（仅工具调用）'
            : active && turn.status !== 'complete'
              ? '等待模型输出…'
              : '（本轮没有返回文字）'),
        data: { request: turn.request, response: turn.response },
      });
      for (const tool of tools) {
        call++;
        const outcome = record(tool.result);
        const start = events.get(`tool.started:${tool.id}`) ?? null;
        const content = toolContent.get(tool.id);
        result.push({
          id: tool.id,
          kind: 'tool',
          title: tool.name,
          content: content?.args ?? '',
          result: content?.result ?? '',
          data: { args: tool.args, result: tool.result },
          turn: turn.turnIndex,
          call,
          input: false,
          start,
          end:
            events.get(`tool.completed:${tool.id}`) ??
            (active && tool.result === null && start !== null ? Date.now() : null),
          status:
            outcome.ok === false
              ? 'failed'
              : outcome.ok === true
                ? 'complete'
                : active
                  ? 'running'
                  : 'interrupted',
        });
      }
    }
    return result;
  }, [initialRows, run.turns, run.tools, run.trace, run.status, toolContent]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = useMemo(
    () =>
      normalizedQuery
        ? rows.filter((row) =>
            `${kindLabels[row.kind]} ${row.title} ${row.content} ${row.result}`
              .toLocaleLowerCase()
              .includes(normalizedQuery),
          )
        : rows,
    [rows, normalizedQuery],
  );
  const hasTiming = run.trace.some((event) => event.type === 'turn.started');
  const startTime = Date.parse(run.createdAt);
  const endTime = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const timeRange = Math.max(1, endTime - startTime);
  const effectiveAxis = axis === 'time' && !hasTiming ? 'turn' : axis;
  const groups = useMemo(
    () => [...new Set(rows.map((row) => (effectiveAxis === 'turn' ? (row.turn ?? -1) : row.call)))],
    [rows, effectiveAxis],
  );
  const positions = useMemo(() => {
    const sizes = new Map<number, number>();
    const indices = new Map<number, number>();
    for (const row of rows) {
      const group = effectiveAxis === 'turn' ? (row.turn ?? -1) : row.call;
      sizes.set(group, (sizes.get(group) ?? 0) + 1);
    }
    return new Map<string, { left: number | null; width: number }>(
      rows.map((row) => {
        if (effectiveAxis === 'time')
          return [
            row.id,
            {
              left:
                row.start === null
                  ? null
                  : Math.min(99.5, Math.max(0, ((row.start - startTime) / timeRange) * 100)),
              width:
                row.start === null || row.end === null
                  ? 0
                  : Math.max(0.4, ((row.end - row.start) / timeRange) * 100),
            },
          ];
        const group = effectiveAxis === 'turn' ? (row.turn ?? -1) : row.call;
        const index = indices.get(group) ?? 0;
        indices.set(group, index + 1);
        const columns = sizes.get(group) ?? 1;
        return [
          row.id,
          {
            left: ((groups.indexOf(group) + index / columns) / Math.max(1, groups.length)) * 100,
            width: 100 / Math.max(1, groups.length) / columns,
          },
        ];
      }),
    );
  }, [rows, effectiveAxis, startTime, timeRange, groups]);
  useEffect(() => {
    if (selected) elements.current.get(selected)?.scrollIntoView({ block: 'nearest' });
  }, [selected, query, full]);
  const { inputTokens, outputTokens, cost } = run.usage.known;
  const panel = (
    <section className={`execution-trace${full ? ' is-expanded' : ''}`} aria-labelledby={titleId}>
      <h3 id={titleId} className="sr-only">
        运行执行日志
      </h3>
      <header className="trace-toolbar">
        <nav aria-label="轨道排列方式">
          {[
            { value: 'time', label: '时长', Icon: Clock },
            { value: 'turn', label: '轮次', Icon: Layers },
            { value: 'call', label: '调用', Icon: Wrench },
          ].map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={effectiveAxis === value}
              disabled={value === 'time' && !hasTiming}
              title={value === 'time' && !hasTiming ? '本次没有保留时间事件' : `按${label}排列轨道`}
              onClick={() => setAxis(value as typeof axis)}
            >
              <Icon size={12} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <label className="trace-search">
          <Search size={12} aria-hidden="true" />
          <span className="sr-only">搜索执行日志</span>
          <input
            type="search"
            placeholder="搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="trace-expand"
          aria-label={full ? '收起执行日志' : '放大执行日志'}
          title={full ? '收起' : '放大查看'}
          onClick={() => setFull((value) => !value)}
        >
          {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </header>
      <div className="trace-minimap" aria-label="输入、模型与工具轨道">
        {(['input', 'model', 'tool'] as const).map((lane) => (
          <div className="trace-lane" key={lane}>
            <span>{lane === 'input' ? '输入' : lane === 'model' ? '模型' : '工具'}</span>
            <div className="trace-track">
              {rows
                .filter((row) => laneFor(row) === lane)
                .map((row) => {
                  const position = positions.get(row.id);
                  if (!position || position.left === null) return null;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className={`trace-bar kind-${row.kind}${selected === row.id ? ' is-selected' : ''}`}
                      style={{
                        left: `${position.left}%`,
                        width: `${Math.min(position.width, 100 - position.left)}%`,
                      }}
                      title={`${kindLabels[row.kind]} · ${row.title}${effectiveAxis === 'time' ? ` · ${elapsed(row.start, row.end)}` : ''}`}
                      aria-label={`定位${kindLabels[row.kind]}：${row.title}`}
                      onClick={() => {
                        setQuery('');
                        setSelected(row.id);
                        elements.current.get(row.id)?.scrollIntoView({ block: 'nearest' });
                      }}
                    />
                  );
                })}
            </div>
          </div>
        ))}
      </div>
      <div className="trace-list" aria-label="执行日志记录">
        {visible.length === 0 && <p className="trace-empty">没有匹配的记录。</p>}
        {visible.map((row, index) => {
          const first = row.turn !== null && (index === 0 || visible[index - 1]?.turn !== row.turn);
          return (
            <details
              key={row.id}
              ref={(element) => {
                if (element) elements.current.set(row.id, element);
                else elements.current.delete(row.id);
              }}
              open={selected === row.id}
              className={`trace-row kind-${row.kind}${row.status === 'failed' ? ' is-error' : ''}`}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setSelected((previous) => (open ? row.id : previous === row.id ? null : previous));
              }}
            >
              <summary>
                <span className="trace-gutter">
                  {effectiveAxis === 'time'
                    ? elapsed(row.start, row.end)
                    : first
                      ? `第 ${row.turn! + 1} 轮`
                      : effectiveAxis === 'call' && row.kind === 'tool'
                        ? `#${row.call}`
                        : ''}
                </span>
                <span className="trace-role">{kindLabels[row.kind]}</span>
                <span className="trace-row-text">
                  {row.kind === 'tool' && <code>{row.title} </code>}
                  {row.kind === 'context' && <strong>{row.title} · </strong>}
                  {row.kind === 'system' ? row.title : compact(row.content)}
                </span>
                {row.result && (
                  <span className="trace-result">
                    <span aria-hidden="true">→ </span>
                    {compact(row.result)}
                  </span>
                )}
                {['failed', 'running', 'interrupted', 'cancelled'].includes(row.status) && (
                  <small className="trace-row-status">{statusLabels[row.status]}</small>
                )}
              </summary>
              {selected === row.id && (
                <div className="trace-row-detail">
                  <div className="trace-detail-heading">
                    <strong>
                      {row.kind === 'tool' ? (toolLabels[row.title] ?? row.title) : row.title}
                    </strong>
                    <CopyButton
                      text={row.kind === 'tool' ? json(row.data) : row.content}
                      label="复制完整记录"
                    />
                  </div>
                  {row.kind === 'tool' ? (
                    <>
                      <DebugJson label="调用参数" value={record(row.data).args} />
                      <DebugJson label="返回结果" value={record(row.data).result} />
                    </>
                  ) : (
                    <>
                      <pre className="trace-content">{row.content}</pre>
                      {row.data !== null && (
                        <DebugJson label="结构化数据与完整请求" value={row.data} />
                      )}
                    </>
                  )}
                </div>
              )}
            </details>
          );
        })}
      </div>
      <footer className="trace-footer">
        <span className={`trace-run-status is-${run.status}`}>
          {statusLabels[run.status] ?? run.status}
        </span>
        <span>{run.preview.request.modelId}</span>
        <span>
          {run.turns.length} 轮 / {run.tools.length} 次工具调用
        </span>
        <span>
          输入 {count(inputTokens)} · 输出 {count(outputTokens)}
        </span>
        {cost && (
          <span>
            {cost.amount} {cost.currency} · {cost.source === 'provider' ? '供应商' : '估算'}
          </span>
        )}
        {!run.usage.complete && <span>用量未完整返回</span>}
        {connection && ['running', 'queued', 'cancelling'].includes(run.status) && (
          <span>{connection}</span>
        )}
        {query && (
          <span>
            {visible.length} / {rows.length} 条记录
          </span>
        )}
      </footer>
      <details className="trace-metadata">
        <summary>
          运行信息与原始数据
          <ChevronRight size={11} aria-hidden="true" />
        </summary>
        <div>
          <Identifier label="运行标识" value={run.id} />
          <Identifier label="上下文指纹" value={run.preview.hash} />
          {run.retryOfRunId && <Identifier label="重试来源" value={run.retryOfRunId} />}
          <p className="debug-note">
            预计输入 {count(run.preview.estimatedInputTokens)} / {count(run.preview.inputLimit)}{' '}
            Token，预留输出 {count(run.preview.reservedOutputTokens)}{' '}
            Token。输入为保守估算；未知用量不计为零。
          </p>
          {run.stopReason && <p className="debug-note">结束原因：{run.stopReason}</p>}
          {[...run.preview.warnings, ...run.preview.omitted].map((message, index) => (
            <p key={`${index}:${message}`} className="debug-note">
              {message}
            </p>
          ))}
          <DebugJson label="完整冻结输入" value={run.preview.request} />
          <DebugJson label="实际资料与引用" value={run.contexts} />
          <DebugJson label="完整用量明细" value={run.usageDetails} />
        </div>
      </details>
    </section>
  );
  return full ? (
    <>
      <button type="button" className="trace-return" onClick={() => setFull(false)}>
        执行日志已放大 · 点击收起
      </button>
      <Modal labelledBy={titleId} onClose={() => setFull(false)}>
        <div className="trace-expanded">{panel}</div>
      </Modal>
    </>
  ) : (
    panel
  );
}
