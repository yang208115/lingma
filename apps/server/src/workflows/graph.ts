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
  const steps = orderedWorkflowSteps(config.steps).filter((step) => step.stage !== 'revise');
  const nodes = steps.map((step) => node(step, 0, step.dependsOn));
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
  const revise = config.steps.find((step) => step.stage === 'revise');
  const nodes: WorkflowNode[] = [];
  if (withRevision && revise) nodes.push(node(revise, round, []));
  const upstream = nodes.map((item) => item.key);
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
    return keys;
  }
  return workflowAncestors(templateKey, dependencies);
}
