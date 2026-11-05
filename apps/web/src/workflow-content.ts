import type { Json } from '@lingma/shared';

/** Accept an entire JSON document, including legacy output with redundant closing brackets. */
export function parseWorkflowContent(text: string): Json | undefined {
  const source = text
    .trim()
    .replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
    .trim();
  if (!['{', '['].includes(source[0] ?? '')) return undefined;
  let quoted = false;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      if (stack.pop() !== (character === '}' ? '{' : '[')) return undefined;
      if (!stack.length) {
        if (!/^[\s}\]]*$/.test(source.slice(i + 1))) return undefined;
        try {
          return JSON.parse(source.slice(0, i + 1)) as Json;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export const workflowContentLabels: Record<string, string> = {
  chapterTitle: '章节标题',
  title: '标题',
  content: '内容',
  summary: '概述',
  storyTime: '故事时间',
  pov: '叙事视角',
  mode: '方式',
  primary: '主要视角人物',
  secondary: '次要人物',
  rules: '写作规则',
  chapterGoal: '本章目标',
  plot: '剧情推进',
  emotion: '情感推进',
  theme: '主题',
  mustShow: '必须呈现',
  mustNotHappen: '本章禁止事项',
  continuityFromPrior: '前文衔接',
  establishedFacts: '已确定事实',
  motifsToReuse: '延续的意象',
  sceneProgression: '场景安排',
  scenes: '场景安排',
  order: '顺序',
  name: '名称',
  focus: '焦点人物',
  setting: '场景',
  beats: '情节节拍',
  conflictSeed: '冲突伏笔',
  exit: '场景收束',
  conflicts: '冲突设计',
  external: '外部冲突',
  interpersonal: '人物关系冲突',
  resolutionThisChapter: '本章解决的冲突',
  foreshadow: '伏笔安排',
  what: '伏笔内容',
  status: '状态',
  later: '后续发展',
  doNot: '注意事项',
  characterBeats: '人物推进',
  styleNotes: '文风要求',
  genre: '题材',
  voice: '叙事语气',
  lengthAdvice: '篇幅建议',
  pendingUnconfirmed: '待确认事项',
  openQuestions: '待确认事项',
  notes: '补充说明',
  reason: '说明',
  items: '条目',
  coverage: '已检查',
  uncovered: '未覆盖',
  issues: '审校问题',
  description: '问题说明',
  quote: '原文',
  suggestion: '建议',
  domain: '审校范围',
};

export function workflowContentLabel(key: string) {
  if (key.startsWith('internal_')) return `${key.slice('internal_'.length)}的内心冲突`;
  return workflowContentLabels[key] ?? key;
}

export const workflowContentMetadata = new Set([
  'type',
  'schemaVersion',
  'targetDocumentId',
  'baseVersionId',
  'documentId',
  'reviewedArtifactId',
  'artifactId',
  'citationIds',
  'sourceCitationIds',
  'citations',
]);
