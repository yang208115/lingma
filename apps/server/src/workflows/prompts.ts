import {
  type AgentProfileVersion,
  reviewMarkdownFormat,
  type WorkflowArtifactKind,
  type WorkflowInput,
  type WorkflowNode,
} from '@lingma/shared';

const kindOf = {
  plan: 'plan',
  analysis: 'analysis',
  review: 'review',
  merge: 'merge',
} as const;
export function artifactKind(
  node: Pick<WorkflowNode, 'stage'>,
  task: WorkflowInput['taskType'],
): WorkflowArtifactKind {
  if (node.stage in kindOf) return kindOf[node.stage as keyof typeof kindOf];
  return task === 'chapter_write' || task === 'master_outline' ? 'draft' : 'records';
}
export const formatGuide: Record<WorkflowInput['taskType'], string> = {
  chapter_write:
    '直接输出 Markdown 正文。新建章节时第一行用“# 章节标题”；修改已有章节时只输出完整正文。不要调用提交工具，不要输出 JSON 或额外说明。',
  master_outline:
    '直接输出 Markdown 总纲。第一行用“# 总纲标题”，其后写完整总纲。不要输出 JSON 或额外说明。',
  story_events:
    '直接输出 Markdown。每个事件以“## 事件标题”开头，其后可选“时间：…”“概述：…”两行，再写完整事件大纲。按故事发生顺序排列。不要输出 JSON。',
  basic_information:
    '直接输出 Markdown。每个条目以“## [分类] 标题”开头，分类取：故事定位、世界、人物、冲突、文风。其后可用“> 一句概述”，再用“字段名：内容”逐行写该分类的字段，剩余文字为条目正文。修改已有条目时标题末尾追加 (@文档ID)。不要输出 JSON。',
  worldbuilding:
    '直接输出 Markdown。每个世界观条目以“## [世界] 标题”开头，其后可用“> 一句概述”，再用“字段名：内容”逐行写字段，剩余文字为正文。修改已有条目时标题末尾追加 (@文档ID)。不要输出 JSON。',
};
const planGuide = '直接输出 Markdown 章纲或提纲，写清本次目标、结构与待决事项。不要输出 JSON。';
const analysisGuide = '直接输出 Markdown 分析笔记，供后续节点参考。不要输出 JSON。';
export const stageGuide = (node: Pick<WorkflowNode, 'stage'>, task: WorkflowInput['taskType']) =>
  node.stage === 'plan'
    ? planGuide
    : node.stage === 'analysis'
      ? analysisGuide
      : node.stage === 'review'
        ? reviewMarkdownFormat
        : formatGuide[task];

export function capabilityStage(
  capability: AgentProfileVersion['config']['capability'],
): WorkflowNode['stage'] {
  return capability === 'generate' ? 'generate' : capability;
}
