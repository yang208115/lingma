/** Layout is presentation metadata; dependsOn is the only executable graph. */
export type WorkflowGraphStep = {
  key: string;
  stage: string;
  dependsOn?: string[] | undefined;
};

export function workflowDependencies<T extends WorkflowGraphStep>(
  steps: T[],
): Map<string, string[]> {
  // Revision is a system feedback loop and never an ordinary dependency.
  return new Map(
    steps.map((step) => [step.key, step.stage === 'revise' ? [] : (step.dependsOn ?? [])]),
  );
}

export function workflowAncestors(key: string, dependencies: Map<string, string[]>): Set<string> {
  const ancestors = new Set<string>();
  const visit = (current: string) => {
    for (const parent of dependencies.get(current) ?? []) {
      if (ancestors.has(parent)) continue;
      ancestors.add(parent);
      visit(parent);
    }
  };
  visit(key);
  return ancestors;
}

export function orderedWorkflowSteps<T extends WorkflowGraphStep>(steps: T[]): T[] {
  const dependencies = workflowDependencies(steps);
  if (dependencies.size !== steps.length) throw new Error('节点标识不能重复');
  for (const step of steps) {
    const parents = dependencies.get(step.key) ?? [];
    if (new Set(parents).size !== parents.length) throw new Error('节点连线不能重复');
    if (parents.some((key) => key === step.key)) throw new Error('节点不能连接自身');
    if (parents.some((key) => !steps.some((s) => s.key === key && s.stage !== 'revise')))
      throw new Error('连线引用了不存在的节点或修订节点');
    if (step.stage === 'revise' && step.dependsOn?.length)
      throw new Error('修订由审校反馈自动触发，无需手动连线');
  }
  const result: T[] = [];
  const remaining = steps.filter((s) => s.stage !== 'revise');
  const done = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex((s) =>
      (dependencies.get(s.key) ?? []).every((key) => done.has(key)),
    );
    if (index < 0) throw new Error('流程存在循环连线，请移除循环；修订回路由系统处理');
    const step = remaining.splice(index, 1)[0];
    if (!step) break;
    result.push(step);
    done.add(step.key);
  }
  return [...result, ...steps.filter((s) => s.stage === 'revise')];
}
