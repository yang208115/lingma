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
  agent: 'analysis',
  debate: 'analysis',
  review: 'review',
  merge: 'merge',
} as const;
export function artifactKind(
  node: Pick<WorkflowNode, 'stage'>,
  task: WorkflowInput['taskType'],
): WorkflowArtifactKind {
  if (node.stage in kindOf) return kindOf[node.stage as keyof typeof kindOf];
  return task === 'chapter_write' || task === 'master_outline' || task === 'discussion'
    ? 'draft'
    : 'records';
}
export const formatGuide: Record<WorkflowInput['taskType'], string> = {
  chapter_planning:
    '直接输出 Markdown 章纲批次，每章以“## 章节序号与标题”开头，其后可选“时间：…”“概述：…”两行。正文写清本章目标、视角、开场、场景推进、冲突与转折、结尾钩子、伏笔和明确不在本章展开的后续事件。只拆分为单章可承载的情节，不写小说正文。按章节顺序输出，每章内部使用三级标题。chapterCount 有值时严格遵守指定章数；为空时由你根据来源规划、目标篇幅、情节密度与叙事节奏自动决定合理章数（1—30 章），优先沿用来源中已明确的章节安排，不要求作者先手动分章或提供章数，不默认固定 8 章。参考已有章纲，只补足未覆盖的情节，避免重复生成。不能将整个卷纲塞进一章。不要输出 JSON。',
  discussion:
    '直接输出 Markdown 讨论结论，包括各方主要论点、相互反驳、共识、未解决分歧和建议。不要虚构共识，保留有依据的少数意见。',
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
  node.stage === 'debate'
    ? formatGuide.discussion
    : node.stage === 'agent'
      ? '直接用 Markdown 发言。先明确立场，再针对收到的其他 Agent 发言逐条回应：指出分歧、证据、反例与可接受的修改。不要为了达成一致而附和，也不要人身攻击。首轮提出独立观点，后续轮次说明保留或改变了哪些判断。'
      : node.stage === 'plan'
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
