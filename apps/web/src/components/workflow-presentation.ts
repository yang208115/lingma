import type { RunDetail, WorkflowNode, WorkflowRun } from '@lingma/shared';

export function workflowLiveText(run: Pick<RunDetail, 'turns' | 'output'>): string {
  return (
    run.turns
      .map((turn) => turn.partialText)
      .filter(Boolean)
      .join('\n\n') ||
    run.output?.text ||
    ''
  );
}

export function workflowToolActivity(run: Pick<RunDetail, 'turns' | 'tools' | 'status'>): string {
  const tool = run.tools.findLast((item) => item.result === null);
  if (tool) {
    const labels: Record<string, string> = {
      read_document: '正在读取文档…',
      search_documents: '正在搜索资料…',
      load_skill: '正在读取写作 Skill…',
      read_skill_file: '正在读取 Skill 附件…',
    };
    return labels[tool.name] ?? '正在执行工具…';
  }
  if (run.status === 'completed') return '本步骤已完成';
  if (!['queued', 'running', 'cancelling'].includes(run.status))
    return '本步骤已停止，已保留生成内容';
  if (run.turns.at(-1)?.thinking && !run.turns.at(-1)?.partialText) return '正在思考与组织内容…';
  return run.status === 'queued' ? '等待模型开始…' : '正在生成，内容会自动显示…';
}

export function workflowDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours} 小时 ${minutes} 分 ${remainder} 秒`;
  if (minutes) return `${minutes} 分 ${remainder} 秒`;
  return `${remainder} 秒`;
}

type ProgressInput = Pick<WorkflowRun, 'status' | 'pauseRequested' | 'outcome'> & {
  nodes: Pick<WorkflowNode, 'status' | 'name' | 'stage' | 'templateKey' | 'round'>[];
  acceptedResults: unknown[];
  proposal: { status: string } | null;
  snapshot: { input: Pick<WorkflowRun['snapshot']['input'], 'taskType'> };
};

export function workflowProgress(run: ProgressInput): { title: string; detail: string } {
  const chapter = run.snapshot.input.taskType === 'chapter_write';
  const discussion = run.snapshot.input.taskType === 'discussion';
  const output = chapter
    ? '正文'
    : run.snapshot.input.taskType === 'chapter_planning'
      ? '章纲'
      : '结果';
  if (run.status === 'completed') {
    const saved = run.acceptedResults.length > 0 || run.proposal?.status === 'accepted';
    return {
      title: saved
        ? `${output}已保存`
        : run.outcome === 'rejected'
          ? '结果未采用'
          : discussion && run.outcome === 'accepted'
            ? '讨论结论已确认'
            : '任务已完成',
      detail: saved ? '可以打开已保存的文档继续编辑。' : '执行记录与生成内容已保留。',
    };
  }
  if (run.status === 'awaiting_acceptance')
    return {
      title: `${discussion ? '讨论结论' : output}已生成，等待你确认`,
      detail: discussion
        ? '查看汇总结论后，可以确认本次讨论。'
        : '先预览完整内容，确认采用后才会保存到作品。',
    };
  if (run.status === 'cancelled')
    return { title: '任务已停止', detail: '已有生成内容与执行记录已保留。' };
  if (run.status === 'paused')
    return { title: '任务已暂停', detail: '已有内容已保留，可以预览或恢复执行。' };
  if (run.status === 'interrupted')
    return { title: '任务已中断', detail: '检查提示后，点击“恢复 / 重试”继续。' };
  if (run.status === 'failed' || run.status === 'limited')
    return { title: '任务需要处理', detail: '已有内容已保留，请检查下方提示。' };
  const gate = run.nodes.find((node) => node.status === 'awaiting_gate');
  if (run.status === 'awaiting_input')
    return {
      title: gate ? `请确认「${gate.name}」的内容` : '等待你处理审校结果',
      detail: gate ? '查看本步内容后，确认继续下一步。' : '查看审校意见，决定继续修改或调整采纳。',
    };
  if (run.pauseRequested)
    return { title: '正在完成当前步骤，随后暂停', detail: '暂停会保留当前生成的完整内容。' };
  const node = run.nodes.find((item) => ['running', 'queued'].includes(item.status));
  if (!node || node.status === 'queued')
    return {
      title: node ? `等待开始：${node.name}` : '正在准备任务',
      detail: '任务已提交，等待本地执行器开始；本地一次处理一个任务。',
    };
  const title =
    node.stage === 'plan'
      ? '正在整理本章提纲'
      : node.stage === 'draft'
        ? '正在撰写正文'
        : node.stage === 'revise'
          ? `正在按审校意见修改${output}`
          : node.templateKey === 'continuity'
            ? '正在检查人物设定与时间线'
            : node.templateKey === 'narrative'
              ? '正在检查情节与叙事'
              : `正在执行：${node.name}`;
  return {
    title,
    detail:
      node.round > 0
        ? `第 ${node.round} 次修订${node.stage === 'revise' ? '正在生成' : '后复审'}，尚未保存为正式文档。`
        : '完成后会继续后续步骤，采用前不会保存为正式文档。',
  };
}
