import {
  type AgentProfile,
  orderedWorkflowSteps,
  type WorkflowTemplateConfig,
  workflowAncestors,
  workflowDependencies,
  workflowTemplateConfigSchema,
} from '@lingma/shared';
import {
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  GitBranch,
  Maximize2,
  Minimize2,
  Play,
  RotateCcw,
  ScanEye,
  Sparkles,
  SquareCheck,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type Step = WorkflowTemplateConfig['steps'][number];
const labels: Record<Step['stage'], string> = {
  plan: '策划',
  draft: '正文 / 润色',
  generate: '通用内容生成',
  review: '审校',
  analysis: '辅助分析',
  revise: '定向修订',
};
const icons = {
  plan: GitBranch,
  draft: WandSparkles,
  generate: Sparkles,
  review: ScanEye,
  analysis: GitBranch,
  revise: RotateCcw,
};
type CardNode = Node<
  {
    label: string;
    stage: Step['stage'] | 'start' | 'end' | 'gate' | 'author';
    agent: string;
    required: boolean;
    confirm?: boolean;
  },
  'workflow'
>;
const isStep = (stage: CardNode['data']['stage']): stage is Step['stage'] => stage in labels;
function WorkflowNodeCard({ data, selected }: NodeProps<CardNode>) {
  const system = !isStep(data.stage);
  const Icon = isStep(data.stage)
    ? icons[data.stage]
    : data.stage === 'start'
      ? Play
      : data.stage === 'end'
        ? SquareCheck
        : GitBranch;
  return (
    <div
      className={`workflow-graph-node ${selected ? 'is-selected' : ''} ${system ? 'is-system' : ''}`}
      data-stage={data.stage}
    >
      {data.stage !== 'start' && data.stage !== 'revise' && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={!system && data.stage !== 'revise'}
          aria-label={`${data.label} 输入连接点`}
        />
      )}
      {data.stage === 'gate' && (
        <Handle
          id="feedback"
          type="source"
          position={Position.Bottom}
          isConnectable={false}
          className="workflow-feedback-handle"
        />
      )}
      {data.stage === 'revise' && (
        <Handle
          id="feedback"
          type="target"
          position={Position.Top}
          isConnectable={false}
          className="workflow-feedback-handle"
        />
      )}
      <div className="workflow-node-heading">
        <span className="workflow-node-icon">
          <Icon size={17} />
        </span>
        <strong>{data.label}</strong>
      </div>
      <div className="workflow-node-caption">
        {isStep(data.stage) ? labels[data.stage] : data.agent}
        {data.stage === 'review' && ` · ${data.required ? '必需' : '可选'}`}
        {data.confirm && ' · 等待作者确认'}
      </div>
      {!system && <div className="workflow-node-agent">{data.agent}</div>}
      {!['end', 'author'].includes(data.stage) && (
        <Handle
          type="source"
          position={data.stage === 'revise' ? Position.Left : Position.Right}
          isConnectable={!system && data.stage !== 'revise'}
          aria-label={`${data.label} 输出连接点`}
        />
      )}
    </div>
  );
}
const nodeTypes = { workflow: WorkflowNodeCard };
const startId = '__start';
const endId = '__end';
const gateId = '__review_gate';
const authorId = '__author';
const readableView = { padding: 0.08, minZoom: 0.72, maxZoom: 1 };
function explicitSteps(steps: Step[]): Step[] {
  const dependencies = workflowDependencies(steps);
  return steps.map((s) => ({ ...s, dependsOn: dependencies.get(s.key) ?? [] }));
}
function layout(steps: Step[]): Map<string, { x: number; y: number }> {
  let ordered = steps;
  try {
    ordered = orderedWorkflowSteps(steps);
  } catch {
    /* Keep invalid drafts editable. */
  }
  const dependencies = workflowDependencies(steps);
  const depths = new Map<string, number>();
  const rows = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const step of ordered.filter((s) => s.stage !== 'revise')) {
    const depth = Math.max(
      0,
      ...(dependencies.get(step.key) ?? []).map((key) => (depths.get(key) ?? -1) + 1),
    );
    const row = rows.get(depth) ?? 0;
    depths.set(step.key, depth);
    rows.set(depth, row + 1);
    positions.set(step.key, { x: 270 + depth * 270, y: 80 + row * 180 });
  }
  const maxX = Math.max(270, ...Array.from(positions.values(), (position) => position.x));
  const maxY = Math.max(80, ...Array.from(positions.values(), (position) => position.y));
  for (const step of steps.filter((s) => s.stage === 'revise'))
    positions.set(step.key, { x: maxX + 270, y: maxY + 210 });
  return positions;
}

export function WorkflowGraphEditor({
  config,
  profiles,
  onChange,
}: {
  config: WorkflowTemplateConfig;
  profiles: AgentProfile[];
  onChange(config: WorkflowTemplateConfig): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance<CardNode> | null>(null);
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    if (!flow) return;
    const frame = requestAnimationFrame(() => {
      void flow.fitView({ ...readableView, padding: expanded ? 0.12 : 0.08 });
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, flow]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [selected, setSelected] = useState<string>('');
  const [selectedEdge, setSelectedEdge] = useState<string>('');
  const [parentKey, setParentKey] = useState('');
  const [notice, setNotice] = useState('');
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const versions = useMemo(
    () => profiles.filter((p) => !p.archived).flatMap((p) => p.versions),
    [profiles],
  );
  const dependencies = workflowDependencies(config.steps);
  const selectedStep = config.steps.find((s) => s.key === selected);
  const validation = workflowTemplateConfigSchema.safeParse(config);
  const validationMessage = validation.success
    ? ''
    : (validation.error.issues[0]?.message ?? '请检查节点配置');
  useEffect(() => {
    const positions = layout(config.steps);
    const deps = workflowDependencies(config.steps);
    const content = config.steps.filter((s) => s.stage !== 'revise');
    const maxX = Math.max(0, ...content.map((s) => (s.position ?? positions.get(s.key))?.x ?? 0));
    const generatedNodes: CardNode[] = config.steps.map((s) => ({
      id: s.key,
      type: 'workflow',
      position: s.position ?? positions.get(s.key) ?? { x: 300, y: 80 },
      selected: selected === s.key,
      ariaLabel: `节点 ${s.name}`,
      data: {
        label: s.name,
        stage: s.stage,
        required: s.required,
        confirm: s.stage === 'plan' && config.confirmPlan,
        agent: versions.find((v) => v.id === s.agentVersionId)?.config.name ?? '请选择 Agent',
      },
    }));
    const reviewers = content.filter((s) => s.stage === 'review');
    const revise = config.steps.find((s) => s.stage === 'revise');
    const reviewY = reviewers.map((s) => (s.position ?? positions.get(s.key))?.y ?? 80);
    const gateY = reviewY.length ? (Math.min(...reviewY) + Math.max(...reviewY)) / 2 : 80;
    const systemNode = (
      id: string,
      label: string,
      stage: 'start' | 'end' | 'gate' | 'author',
      x: number,
      y: number,
      agent: string,
    ): CardNode => ({
      id,
      type: 'workflow',
      position: { x, y },
      deletable: false,
      draggable: false,
      selectable: false,
      data: { label, stage, agent, required: true },
    });
    generatedNodes.push(
      systemNode(startId, '开始', 'start', 0, 80, '创作要求与引用资料'),
      systemNode(
        endId,
        '作者确认候选',
        'end',
        maxX + (reviewers.length ? 540 : 270),
        gateY,
        '确认后保存到作品',
      ),
    );
    if (reviewers.length) {
      generatedNodes.push(
        systemNode(
          gateId,
          '审校汇总',
          'gate',
          maxX + 270,
          gateY,
          '等待全部完成，检查重要问题与覆盖项',
        ),
      );
      if (!revise || !config.autoRevise)
        generatedNodes.push(
          systemNode(
            authorId,
            '等待作者处理',
            'author',
            maxX + 270,
            Math.max(...reviewY) + 210,
            '补充意见、编辑候选或明确采用',
          ),
        );
    }
    const generatedEdges: Edge[] = [];
    const systemEdge = (
      id: string,
      source: string,
      target: string,
      extra: Partial<Edge> = {},
    ): Edge => ({
      id,
      source,
      target,
      type: 'smoothstep',
      selectable: false,
      deletable: false,
      ...extra,
    });
    for (const step of content) {
      for (const parent of deps.get(step.key) ?? [])
        generatedEdges.push({
          id: `${parent}:${step.key}`,
          source: parent,
          target: step.key,
          type: 'smoothstep',
          selected: selectedEdge === `${parent}:${step.key}`,
        });
      if (!deps.get(step.key)?.length)
        generatedEdges.push(systemEdge(`boundary:start:${step.key}`, startId, step.key));
      if (step.stage === 'review' || !content.some((s) => deps.get(s.key)?.includes(step.key)))
        generatedEdges.push(
          systemEdge(`boundary:result:${step.key}`, step.key, reviewers.length ? gateId : endId),
        );
    }
    if (reviewers.length) {
      generatedEdges.push(
        systemEdge('boundary:pass', gateId, endId, {
          label: '通过',
          className: 'workflow-pass-edge',
        }),
      );
      const automatic = config.autoRevise ? revise : undefined;
      generatedEdges.push(
        systemEdge('feedback:issues', gateId, automatic ? automatic.key : authorId, {
          sourceHandle: 'feedback',
          ...(automatic ? { targetHandle: 'feedback' } : {}),
          label: '需处理',
          className: 'workflow-feedback-edge',
        }),
      );
      if (automatic)
        for (const [index, review] of reviewers.entries())
          generatedEdges.push(
            systemEdge(`feedback:return:${review.key}`, automatic.key, review.key, {
              ...(index === 0 ? { label: '修订后全部复审' } : {}),
              className: 'workflow-feedback-edge',
            }),
          );
    }
    setNodes(generatedNodes);
    setEdges(generatedEdges);
  }, [config, versions, selected, selectedEdge]);
  const update = (key: string, patch: Partial<Step>) =>
    onChange({
      ...config,
      steps: config.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    });
  const remove = (keys: string[]) => {
    onChange({
      ...config,
      steps: explicitSteps(config.steps)
        .filter((s) => !keys.includes(s.key))
        .map((s) => ({ ...s, dependsOn: s.dependsOn?.filter((key) => !keys.includes(key)) })),
    });
    setSelected('');
  };
  const connect = ({ source, target }: Pick<Connection, 'source' | 'target'>) => {
    const from = config.steps.find((s) => s.key === source);
    const to = config.steps.find((s) => s.key === target);
    if (!from || !to || from.stage === 'revise' || to.stage === 'revise') return;
    if (source === target || workflowAncestors(source, dependencies).has(target)) {
      setNotice('不能创建循环连线；修订回路由系统处理。');
      return;
    }
    setNotice('');
    onChange({
      ...config,
      steps: explicitSteps(config.steps).map((s) =>
        s.key === target ? { ...s, dependsOn: [...new Set([...(s.dependsOn ?? []), source])] } : s,
      ),
    });
  };
  const disconnect = (ids: string[]) =>
    onChange({
      ...config,
      steps: explicitSteps(config.steps).map((s) => ({
        ...s,
        dependsOn: s.dependsOn?.filter((key) => !ids.includes(`${key}:${s.key}`)),
      })),
    });
  const add = (stage: Step['stage']) => {
    const key = `step-${crypto.randomUUID().slice(0, 8)}`;
    const capability =
      stage === 'revise' ? (config.taskType === 'chapter_write' ? 'draft' : 'generate') : stage;
    const producer = config.steps.filter((s) => ['draft', 'generate'].includes(s.stage)).at(-1);
    const parents =
      stage === 'review' && producer
        ? [producer.key]
        : selectedStep && selectedStep.stage !== 'revise'
          ? [selectedStep.key]
          : [];
    const steps = explicitSteps(config.steps);
    steps.push({
      key,
      stage,
      name: stage === 'review' ? '新增审校' : `新增${labels[stage]}`,
      agentVersionId: versions.find((v) => v.config.capability === capability)?.id ?? '',
      required: true,
      dependsOn: stage === 'revise' ? [] : parents,
    });
    onChange({ ...config, steps });
    setSelected(key);
  };
  const form = (step: Step, index: number) => (
    <fieldset key={step.key}>
      <legend>{labels[step.stage]}节点</legend>
      <label>
        阶段名称
        <input
          aria-label="阶段名称"
          value={step.name}
          maxLength={100}
          onChange={(e) => update(step.key, { name: e.target.value })}
        />
      </label>
      <label>
        阶段类型
        <select
          aria-label="阶段类型"
          value={step.stage}
          onChange={(e) => {
            const stage = e.target.value as Step['stage'];
            const steps = explicitSteps(config.steps).map((node) =>
              node.key === step.key
                ? {
                    ...node,
                    stage,
                    agentVersionId: '',
                    ...(stage === 'revise' ? { dependsOn: [] } : {}),
                  }
                : stage === 'revise'
                  ? { ...node, dependsOn: node.dependsOn?.filter((key) => key !== step.key) }
                  : node,
            );
            onChange({ ...config, steps });
          }}
        >
          {Object.entries(labels)
            .filter(([id]) => id !== (config.taskType === 'chapter_write' ? 'generate' : 'draft'))
            .map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
        </select>
      </label>
      <label>
        执行 Agent 版本
        <select
          aria-label="执行 Agent 版本"
          value={step.agentVersionId}
          onChange={(e) => update(step.key, { agentVersionId: e.target.value })}
        >
          <option value="">请选择能力匹配的已发布 Agent</option>
          {versions
            .filter(
              (v) =>
                v.config.capability ===
                (step.stage === 'revise'
                  ? config.taskType === 'chapter_write'
                    ? 'draft'
                    : 'generate'
                  : step.stage),
            )
            .map((v) => (
              <option key={v.id} value={v.id}>
                {v.config.name} · v{v.versionNo}
              </option>
            ))}
        </select>
      </label>
      {step.stage === 'review' && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={step.required}
            onChange={(e) => update(step.key, { required: e.target.checked })}
          />
          必须完成此审校
        </label>
      )}
      {step.stage === 'revise' ? (
        <p className="muted">审校发现重要问题时触发，修订完成后重新运行全部审校。</p>
      ) : (
        <>
          <h4>上游节点</h4>
          {(dependencies.get(step.key) ?? []).map((key) => (
            <div className="workflow-upstream" key={key}>
              <span>{config.steps.find((s) => s.key === key)?.name ?? key}</span>
              <button
                type="button"
                aria-label={`移除来自${config.steps.find((s) => s.key === key)?.name ?? key}的连线`}
                onClick={() => disconnect([`${key}:${step.key}`])}
              >
                移除连线
              </button>
            </div>
          ))}
          {!dependencies.get(step.key)?.length && <p className="muted">从开始节点接收创作要求。</p>}
          <label>
            添加上游
            <select
              aria-label="添加上游节点"
              value={parentKey}
              onChange={(e) => setParentKey(e.target.value)}
            >
              <option value="">选择节点</option>
              {config.steps
                .filter(
                  (s) =>
                    s.key !== step.key &&
                    s.stage !== 'revise' &&
                    !dependencies.get(step.key)?.includes(s.key) &&
                    !workflowAncestors(s.key, dependencies).has(step.key),
                )
                .map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!parentKey}
            onClick={() => {
              connect({ source: parentKey, target: step.key });
              setParentKey('');
            }}
          >
            连接上游
          </button>
        </>
      )}
      <div className="workflow-actions">
        {view === 'list' && (
          <>
            <button
              type="button"
              disabled={index === 0}
              onClick={() => {
                const steps = [...config.steps];
                const prior = steps[index - 1];
                if (prior) {
                  steps[index - 1] = step;
                  steps[index] = prior;
                  onChange({ ...config, steps });
                }
              }}
            >
              上移
            </button>
            <button
              type="button"
              disabled={index === config.steps.length - 1}
              onClick={() => {
                const steps = [...config.steps];
                const next = steps[index + 1];
                if (next) {
                  steps[index + 1] = step;
                  steps[index] = next;
                  onChange({ ...config, steps });
                }
              }}
            >
              下移
            </button>
          </>
        )}
        <button type="button" onClick={() => remove([step.key])}>
          移除阶段
        </button>
      </div>
    </fieldset>
  );
  return (
    <div className={`workflow-graph-editor ${expanded ? 'is-expanded' : ''}`}>
      <div className="workflow-graph-toolbar">
        <div className="workflow-view-switch">
          <button type="button" aria-pressed={view === 'graph'} onClick={() => setView('graph')}>
            流程画布
          </button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            列表编辑
          </button>
        </div>
        <div className="workflow-graph-tools">
          {view === 'graph' && (
            <>
              <span className="workflow-zoom-value">{zoom}%</span>
              <button type="button" onClick={() => void flow?.zoomTo(1)}>
                100%
              </button>
              <button
                type="button"
                aria-label={expanded ? '退出大画布' : '展开大画布'}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                {expanded ? '收起画布' : '展开画布'}
              </button>
            </>
          )}
          <select
            aria-label="添加节点类型"
            value=""
            disabled={config.steps.length >= 16}
            onChange={(e) => add(e.target.value as Step['stage'])}
          >
            <option value="" disabled>
              添加节点
            </option>
            {Object.entries(labels)
              .filter(([id]) => id !== (config.taskType === 'chapter_write' ? 'generate' : 'draft'))
              .map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
          </select>
          {view === 'list' && (
            <button
              type="button"
              disabled={config.steps.length >= 16}
              onClick={() => add('review')}
            >
              ＋ 添加阶段
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const positions = layout(config.steps);
              onChange({
                ...config,
                steps: config.steps.map((s) => ({ ...s, position: positions.get(s.key) })),
              });
              requestAnimationFrame(() => {
                void flow?.fitView(readableView);
              });
            }}
          >
            自动布局
          </button>
        </div>
      </div>
      <p className="workflow-graph-hint">
        拖动节点排布 · 从右侧圆点连到下个节点的左侧圆点 · 点击节点配置 Agent ·
        审校分支共用模型队列依次执行
      </p>
      {view === 'graph' ? (
        <div className={`workflow-graph-workspace ${selectedStep ? 'has-inspector' : ''}`}>
          <section className="workflow-graph-canvas" aria-label="工作流节点画布">
            <ReactFlow<CardNode>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              colorMode="dark"
              fitView
              fitViewOptions={readableView}
              onInit={setFlow}
              onMoveEnd={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))}
              minZoom={0.2}
              maxZoom={1.6}
              paneClickDistance={6}
              nodesConnectable
              onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
              onNodeDragStop={(_, node) => update(node.id, { position: node.position })}
              onNodeClick={(event, node) => {
                event.stopPropagation();
                setSelected(node.id);
                setParentKey('');
                setSelectedEdge('');
              }}
              onPaneClick={() => {
                setSelected('');
                setSelectedEdge('');
                setParentKey('');
              }}
              onConnect={connect}
              onNodesDelete={(deleted) => remove(deleted.map((n) => n.id))}
              onEdgesDelete={(deleted) =>
                disconnect(
                  deleted
                    .filter((e) => !e.id.startsWith('feedback:') && !e.id.startsWith('boundary:'))
                    .map((e) => e.id),
                )
              }
              onEdgeClick={(_, edge) => {
                if (!edge.id.startsWith('feedback:') && !edge.id.startsWith('boundary:'))
                  setSelectedEdge(edge.id);
              }}
              onEdgesChange={(changes) =>
                setEdges((current) =>
                  current.map((edge) => {
                    const change = changes.find((c) => c.type === 'select' && c.id === edge.id);
                    return change?.type === 'select'
                      ? { ...edge, selected: change.selected }
                      : edge;
                  }),
                )
              }
              defaultEdgeOptions={{
                type: 'smoothstep',
                markerEnd: { type: MarkerType.ArrowClosed, color: '#9382b2' },
              }}
            >
              <Background gap={20} size={1} />
              <Controls showInteractive={false} fitViewOptions={readableView} />
              <MiniMap
                style={{ width: 140, height: 90 }}
                pannable
                zoomable
                nodeColor={(node) => (node.data.stage === 'review' ? '#5a9e9a' : '#8c7ab8')}
              />
            </ReactFlow>
            <div className="workflow-canvas-boundaries">
              <span>
                <Play size={12} />
                开始：创作要求与引用资料
              </span>
              <span>
                <SquareCheck size={12} />
                审校汇总通过后，作者确认候选
              </span>
            </div>
            {selectedEdge && (
              <button
                type="button"
                className="workflow-delete-edge"
                onClick={() => {
                  disconnect([selectedEdge]);
                  setSelectedEdge('');
                }}
              >
                删除选中连线
              </button>
            )}
          </section>
          {selectedStep && (
            <aside className="workflow-node-inspector" aria-label="节点配置">
              <header>
                <strong>节点配置</strong>
                <button type="button" aria-label="关闭节点配置" onClick={() => setSelected('')}>
                  ×
                </button>
              </header>
              {form(selectedStep, config.steps.indexOf(selectedStep))}
            </aside>
          )}
        </div>
      ) : (
        <div className="workflow-graph-list">{config.steps.map(form)}</div>
      )}
      <div className="workflow-graph-summary">
        <span>
          {config.steps.length} 个节点 ·{' '}
          {
            edges.filter((e) => !e.id.startsWith('feedback:') && !e.id.startsWith('boundary:'))
              .length
          }{' '}
          条连线
        </span>
        <span
          className={validationMessage || notice ? 'workflow-graph-invalid' : 'muted'}
          role="status"
        >
          {notice || validationMessage || '流程配置有效，可保存并发布'}
        </span>
      </div>
    </div>
  );
}
