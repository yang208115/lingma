import type { WorkflowNode, WorkflowStep, WorkflowTemplateConfig } from '@lingma/shared';
import { orderedWorkflowSteps, workflowAncestors, workflowDependencies } from '@lingma/shared';

export const mergeKey = 'merge';
const instanceKey = (key: string, round: number) => (round === 0 ? key : `${key}@r${round}`);
const blank = {
  runIds: [] as string[],
  artifactId: null,
  inputArtifactIds: [] as string[],
  error: null,
  status: 'pending' as const,
};

function node(step: WorkflowStep, round: number, dependsOn: string[]): WorkflowNode {
  return {
    ...blank,
    key: instanceKey(step.key, round),
    templateKey: step.key,
    round,
    name: step.name,
    stage: step.stage,
    agentVersionId: step.agentVersionId,
    required: step.required,
    gate: step.gate,
    dependsOn,
    runIds: [],
    inputArtifactIds: [],
  };
}
export function mergeNode(
  round: number,
  dependsOn: string[],
  gate: 'auto' | 'manual',
): WorkflowNode {
  return {
    ...blank,
    key: instanceKey(mergeKey, round),
    templateKey: mergeKey,
    round,
    name: '审校汇总',
    stage: 'merge',
    agentVersionId: null,
    required: true,
    gate,
    dependsOn,
    runIds: [],
    inputArtifactIds: [],
  };
}

/** Round 0: every non-revision template node in dependency order, plus the system merge node. */
export function initialNodes(config: WorkflowTemplateConfig): WorkflowNode[] {
  if (config.executionMode === 'graph') return agentRoundNodes(config, 0);
  const steps = orderedWorkflowSteps(config.steps).filter((step) => step.stage !== 'revise');
  const nodes = steps.flatMap((step) => expandStep(step, 0, step.dependsOn));
  const reviews = nodes.filter((item) => item.stage === 'review');
  if (reviews.length)
    nodes.push(
      mergeNode(
        0,
        reviews.map((item) => item.key),
        config.adoptionGate,
      ),
    );
  return nodes;
}

/** A later round re-runs only the reviewers and the merge; revision is optional. */
export function nextRoundNodes(
  config: WorkflowTemplateConfig,
  round: number,
  withRevision: boolean,
): WorkflowNode[] {
  if (config.executionMode === 'graph') return agentRoundNodes(config, round);
  const revise = config.steps.find((step) => step.stage === 'revise');
  const nodes: WorkflowNode[] = [];
  if (withRevision && revise) nodes.push(node(revise, round, []));
  if (withRevision && config.steps.some((step) => step.stage === 'debate') && nodes[0])
    nodes[0].dependsOn = [instanceKey(mergeKey, round - 1)];
  const upstream = nodes.map((item) => item.key);
  if (config.steps.some((step) => step.stage === 'debate')) {
    const dependencies = workflowDependencies(config.steps);
    const outputs = config.steps.filter((step) => ['draft', 'generate'].includes(step.stage));
    const replay = orderedWorkflowSteps(config.steps).filter(
      (step) =>
        step.stage === 'review' ||
        (['analysis', 'debate'].includes(step.stage) &&
          outputs.some((output) => workflowAncestors(step.key, dependencies).has(output.key))),
    );
    for (const step of replay) {
      const parents = step.dependsOn.flatMap((key) => {
        if (replay.some((candidate) => candidate.key === key)) return [instanceKey(key, round)];
        if (outputs.some((output) => output.key === key) && upstream.length) return upstream;
        return [key];
      });
      nodes.push(...expandStep(step, round, parents));
    }
    nodes.push(
      mergeNode(
        round,
        nodes.filter((item) => item.stage === 'review').map((item) => item.key),
        config.adoptionGate,
      ),
    );
    return nodes;
  }
  const reviews = config.steps
    .filter((step) => step.stage === 'review')
    .map((step) => node(step, round, upstream));
  nodes.push(...reviews);
  nodes.push(
    mergeNode(
      round,
      reviews.map((item) => item.key),
      config.adoptionGate,
    ),
  );
  return nodes;
}

const done = (status: WorkflowNode['status']) => status === 'released' || status === 'skipped';
export function readyNode(nodes: WorkflowNode[]): WorkflowNode | undefined {
  return nodes.find(
    (item) =>
      item.status === 'pending' &&
      item.dependsOn.every((key) => {
        const parent = nodes.find((candidate) => candidate.key === key);
        return !parent || done(parent.status);
      }),
  );
}
export const isDone = done;

/** Template keys whose latest artifacts a node may consume (plan, analysis and the final draft). */
export function upstreamTemplateKeys(config: WorkflowTemplateConfig, templateKey: string) {
  const dependencies = workflowDependencies(config.steps);
  const outputs = config.steps.filter((step) => ['draft', 'generate'].includes(step.stage));
  const finalOutput = outputs.at(-1);
  const step = config.steps.find((item) => item.key === templateKey);
  if (!step) return new Set<string>();
  if (step.stage === 'revise' || step.stage === 'review') {
    const keys = finalOutput
      ? new Set([...workflowAncestors(finalOutput.key, dependencies), finalOutput.key])
      : new Set<string>();
    if (step.stage === 'review')
      for (const key of workflowAncestors(step.key, dependencies)) keys.add(key);
    return keys;
  }
  return workflowAncestors(templateKey, dependencies);
}

/** A debate exposes only its summary key to the outer graph; all turns remain inspectable. */
function expandStep(step: WorkflowStep, round: number, parents: string[]): WorkflowNode[] {
  const summary = node(step, round, parents);
  if (step.stage !== 'debate' || !step.debate) return [summary];
  const nodes: WorkflowNode[] = [];
  let previous: string[] = [];
  for (let turn = 0; turn < step.debate.rounds; turn++) {
    const current = step.debate.participants.map(
      (participant, index): WorkflowNode => ({
        ...node(step, round, [...parents, ...previous]),
        key: `${summary.key}~d${turn}p${index}`,
        name: `${step.name} · ${participant.name} · 第 ${turn + 1} 轮`,
        stage: 'agent',
        agentVersionId: participant.agentVersionId,
        debateRound: turn,
        debateParticipant: index,
        gate: 'auto',
      }),
    );
    nodes.push(...current);
    previous = current.map((item) => item.key);
  }
  summary.dependsOn = [...parents, ...nodes.map((item) => item.key)];
  nodes.push(summary);
  return nodes;
}

/** Feedback edges read the previous round, so a visual cycle never deadlocks a round. */
export function agentRoundNodes(config: WorkflowTemplateConfig, round: number): WorkflowNode[] {
  const finalRound = round >= (config.maxRounds ?? 3) - 1;
  return orderedWorkflowSteps(config.steps)
    .filter((step) => finalRound || step.runWhen !== 'after_rounds')
    .map((step) => {
      const parents = step.dependsOn.map((key) => instanceKey(key, round));
      if (round > 0 && step.runWhen !== 'after_rounds') {
        // A debater remembers its own last statement, as well as the connected opponents.
        for (const key of new Set([step.key, ...(step.feedbackFrom ?? [])]))
          parents.push(instanceKey(key, round - 1));
      }
      return node(step, round, [...new Set(parents)]);
    });
}
