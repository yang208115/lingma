import { z } from 'zod';
import { elementCandidatePayloadSchema } from './elements.js';
import { chapterOutlineCreationSchema, masterOutlineCreationSchema } from './outlines.js';

export const workflowTaskSchema = z.enum([
  'chapter_write',
  'basic_information',
  'worldbuilding',
  'master_outline',
  'story_events',
  'chapter_planning',
  'discussion',
]);
export type WorkflowTask = z.infer<typeof workflowTaskSchema>;
export const workflowTaskLabels: Record<WorkflowTask, string> = {
  chapter_write: '正文写作',
  basic_information: '基础信息',
  worldbuilding: '世界观生成',
  master_outline: '故事总纲',
  story_events: '事件规划',
  chapter_planning: '章纲拆分',
  discussion: '讨论 / 辩论',
};

/** Typed shapes the saving adapters produce from a Markdown artifact; never sent by a model. */
export const workflowResultSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('discussion_summary'),
    content: z.string().min(1).max(1000000),
  }),
  z.strictObject({
    type: z.literal('chapter_draft'),
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().min(1).max(1000000),
    notes: z.string().max(8000),
  }),
  z.strictObject({
    type: z.literal('element_candidates'),
    items: z.array(elementCandidatePayloadSchema).min(1).max(30),
  }),
  z.strictObject({
    type: z.literal('master_outline_candidate'),
    ...masterOutlineCreationSchema.shape,
  }),
  z.strictObject({
    type: z.literal('outline_event_batch'),
    ...chapterOutlineCreationSchema.shape,
  }),
  z.strictObject({
    type: z.literal('chapter_plan_batch'),
    ...chapterOutlineCreationSchema.shape,
  }),
]);
export type WorkflowResult = z.infer<typeof workflowResultSchema>;
export const workflowOutputTypes = {
  chapter_write: 'chapter_draft',
  basic_information: 'element_candidates',
  worldbuilding: 'element_candidates',
  master_outline: 'master_outline_candidate',
  story_events: 'outline_event_batch',
  chapter_planning: 'chapter_plan_batch',
  discussion: 'discussion_summary',
} as const;
export const workflowRecordTasks: readonly WorkflowTask[] = [
  'basic_information',
  'worldbuilding',
  'story_events',
  'chapter_planning',
];
