import {
  type ElementKind,
  elementDataSchema,
  elementFields,
  elementLabels,
  type WorkflowInput,
  type WorkflowResult,
  type WorkflowTask,
  workflowRecordTasks,
} from '@lingma/shared';
import { AppError } from '../errors.js';

export type RecordSection = { tag: string; title: string; body: string };

/** Level-2 headings split a multi-record artifact; anything before the first one is preamble. */
export function splitRecordSections(markdown: string): RecordSection[] {
  const sections: RecordSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading && !line.startsWith('###')) {
      if (current) sections.push(finish(current));
      current = { heading: heading[1] ?? '', lines: [] };
    } else current?.lines.push(line);
  }
  if (current) sections.push(finish(current));
  return sections;
}
function finish(section: { heading: string; lines: string[] }): RecordSection {
  const tag = /^\[\s*([^\]]+?)\s*\]\s*(.*)$/.exec(section.heading.trim());
  return {
    tag: tag?.[1] ?? '',
    title: (tag?.[2] ?? section.heading).trim(),
    body: section.lines.join('\n').trim(),
  };
}

const kindAliases: Record<string, ElementKind> = {
  story_premise: 'story_premise',
  故事定位: 'story_premise',
  故事定位与主题: 'story_premise',
  定位: 'story_premise',
  主题: 'story_premise',
  worldbuilding: 'worldbuilding',
  世界: 'worldbuilding',
  世界观: 'worldbuilding',
  世界与场景: 'worldbuilding',
  场景: 'worldbuilding',
  character: 'character',
  人物: 'character',
  人物与关系: 'character',
  角色: 'character',
  core_conflict: 'core_conflict',
  冲突: 'core_conflict',
  核心冲突: 'core_conflict',
  narrative_style: 'narrative_style',
  文风: 'narrative_style',
  叙事: 'narrative_style',
  叙事与文风: 'narrative_style',
};
export const resolveKind = (tag: string): ElementKind | undefined =>
  kindAliases[tag.trim().toLowerCase()] ?? kindAliases[tag.trim()];

const idPattern =
  /\s*[（(]?@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[）)]?\s*$/i;

/** Lines such as `**目标**：…` or `- 动机：…` become structured fields; everything else is prose. */
export function parseRecordBody(kind: ElementKind, body: string) {
  const byLabel = new Map<string, string>();
  for (const [key, label] of Object.entries(elementFields[kind])) {
    byLabel.set(key.toLowerCase(), key);
    byLabel.set(label, key);
    byLabel.set(label.replace(/[（(].*$/, '').trim(), key);
  }
  const fields: Record<string, string> = {};
  const prose: string[] = [];
  const summary: string[] = [];
  let currentField: string | undefined;
  let leading = true;
  for (const line of body.split('\n')) {
    if (leading && /^\s*>/.test(line)) {
      summary.push(line.replace(/^\s*>\s?/, ''));
      continue;
    }
    if (line.trim()) leading = false;
    const match = /^\s*(?:[-*]\s*)?(?:\*\*)?([^：:*\n]{1,40}?)(?:\*\*)?\s*[：:]\s*(.*)$/.exec(line);
    const key = match ? byLabel.get((match[1] ?? '').trim()) : undefined;
    if (match && key) {
      currentField = key;
      fields[key] = match[2] ?? '';
    } else if (currentField && /^\s+\S/.test(line)) {
      // Only an indented line continues the previous field; plain text is entry prose.
      fields[currentField] = `${fields[currentField]}\n${line.trim()}`.trim();
    } else {
      currentField = undefined;
      prose.push(line);
    }
  }
  return { fields, summary: summary.join('\n').trim(), content: prose.join('\n').trim() };
}

function parseEventBody(body: string) {
  let storyTime = '';
  let summary = '';
  const rest: string[] = [];
  for (const line of body.split('\n')) {
    const time = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:故事)?时间(?:\*\*)?\s*[：:]\s*(.*)$/.exec(line);
    const gist = /^\s*(?:[-*]\s*)?(?:\*\*)?概述(?:\*\*)?\s*[：:]\s*(.*)$/.exec(line);
    if (time && !storyTime && !rest.some((item) => item.trim())) storyTime = (time[1] ?? '').trim();
    else if (gist && !summary && !rest.some((item) => item.trim()))
      summary = (gist[1] ?? '').trim();
    else rest.push(line);
  }
  return { storyTime, summary, content: rest.join('\n').trim() };
}

function h1Title(markdown: string) {
  const match = /^\s*#[ \t]+([^\n]+)\n?/.exec(markdown);
  return match
    ? { title: (match[1] ?? '').trim(), rest: markdown.slice(match[0].length).trim() }
    : null;
}

export type ResultBuild = { result: WorkflowResult; warnings: string[]; missing: ElementKind[] };

/** Turns the final Markdown deliverable into the typed shape the saving code understands. */
export function buildWorkflowResult(
  task: WorkflowTask,
  input: Pick<
    WorkflowInput,
    'targetDocumentId' | 'elementKinds' | 'elementTargets' | 'mode' | 'chapterCount'
  >,
  markdown: string,
  allKinds: readonly ElementKind[],
): ResultBuild {
  const text = markdown.trim();
  if (!text) throw new AppError('VALIDATION_ERROR', '产物内容为空，请编辑后再继续', 400);
  if (task === 'discussion')
    return { result: { type: 'discussion_summary', content: text }, warnings: [], missing: [] };
  if (task === 'chapter_write') {
    const heading = h1Title(text);
    return {
      result: {
        type: 'chapter_draft',
        ...(heading?.title
          ? { title: heading.title }
          : input.targetDocumentId
            ? {}
            : { title: '新章节' }),
        content: input.targetDocumentId || !heading ? text : heading.rest || text,
        notes: 'Markdown 产物',
      },
      warnings:
        !input.targetDocumentId && !heading ? ['未找到“# 章节标题”，已使用默认标题“新章节”'] : [],
      missing: [],
    };
  }
  if (task === 'master_outline') {
    const heading = h1Title(text);
    return {
      result: {
        type: 'master_outline_candidate',
        title: heading?.title || '故事总纲',
        content: heading?.rest || text,
        reason: '总纲规划',
        citations: [],
      },
      warnings: heading ? [] : ['未找到“# 总纲标题”，已使用默认标题“故事总纲”'],
      missing: [],
    };
  }
  const sections = splitRecordSections(text);
  if (task === 'story_events' || task === 'chapter_planning') {
    const items = (
      sections.length
        ? sections.map((section) => ({ title: section.title, body: section.body }))
        : [{ title: h1Title(text)?.title || '新事件', body: h1Title(text)?.rest || text }]
    ).map((section) => {
      const event = parseEventBody(section.body);
      return {
        title: section.title || '未命名事件',
        ...(event.storyTime ? { storyTime: event.storyTime } : {}),
        ...(event.summary ? { summary: event.summary } : {}),
        content: event.content || section.body,
      };
    });
    if (task === 'chapter_planning' && input.chapterCount && items.length !== input.chapterCount)
      throw new AppError(
        'VALIDATION_ERROR',
        `章纲数量不符：要求 ${input.chapterCount} 章，实际 ${items.length} 章，请修订后提交完整批次`,
        400,
      );
    return {
      result: {
        type: task === 'chapter_planning' ? 'chapter_plan_batch' : 'outline_event_batch',
        items,
        reason: '分章或事件规划',
        citations: [],
      },
      warnings: sections.length ? [] : ['未找到“## 事件标题”，已把全文作为一个事件'],
      missing: [],
    };
  }
  if (!workflowRecordTasks.includes(task))
    throw new AppError('VALIDATION_ERROR', '任务类型不受支持', 400);
  if (!sections.length)
    throw new AppError(
      'VALIDATION_ERROR',
      '没有找到“## [分类] 标题”形式的条目，请在产物中按该格式分条后再继续',
      400,
    );
  const unknown: string[] = [];
  const items = sections.flatMap((section, index) => {
    const kind = task === 'worldbuilding' ? 'worldbuilding' : resolveKind(section.tag);
    if (!kind) {
      unknown.push(`第 ${index + 1} 条「${section.title}」`);
      return [];
    }
    const target = idPattern.exec(section.title);
    const parsed = parseRecordBody(kind, section.body);
    return [
      {
        tempId: `r${index + 1}`,
        kind,
        title: section.title.replace(idPattern, '').trim() || '未命名',
        targetDocumentId: target?.[1]?.toLowerCase() ?? null,
        content: parsed.content,
        data: elementDataSchema.parse({ summary: parsed.summary, fields: parsed.fields }),
        reason: '',
        openQuestions: [],
      },
    ];
  });
  if (unknown.length)
    throw new AppError(
      'VALIDATION_ERROR',
      `${unknown.join('、')}缺少可识别的分类标记，请改为“## [分类] 标题”，分类如：${allKinds.map((kind) => elementLabels[kind]).join('、')}`,
      400,
    );
  const warnings: string[] = [];
  let missing: ElementKind[] = [];
  if (task === 'basic_information') {
    const covered = new Set(items.map((item) => item.kind));
    missing = (input.elementKinds ?? allKinds).filter((kind) => !covered.has(kind));
    if (missing.length)
      warnings.push(`未覆盖分类：${missing.map((kind) => elementLabels[kind]).join('、')}`);
  }
  return { result: { type: 'element_candidates', items }, warnings, missing };
}
