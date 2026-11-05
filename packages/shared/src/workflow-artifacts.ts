import { z } from 'zod';
import { idSchema } from './domain.js';
import { elementCandidatePayloadSchema } from './elements.js';
import { chapterOutlineCreationSchema, masterOutlineCreationSchema } from './outlines.js';

export const workflowTaskSchema = z.enum([
  'chapter_write',
  'worldbuilding',
  'master_outline',
  'story_events',
]);
export type WorkflowTask = z.infer<typeof workflowTaskSchema>;
export const workflowTaskLabels: Record<WorkflowTask, string> = {
  chapter_write: '正文写作',
  worldbuilding: '世界观生成',
  master_outline: '故事总纲',
  story_events: '事件规划',
};

export const reviewIssueSchema = z.strictObject({
  id: z.string().min(1).max(100),
  severity: z.enum(['P0', 'P1', 'P2']),
  description: z.string().min(1).max(4000),
  quote: z.string().max(2000),
  sourceCitationIds: z.array(z.string().max(300)).max(20),
  suggestion: z.string().max(4000),
});
export const workflowArtifactPayloadSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('chapter_plan'),
    content: z.string().min(1).max(100000),
    openQuestions: z.array(z.string().max(2000)).max(30),
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
    type: z.literal('review_report'),
    reviewedArtifactId: idSchema,
    domain: z.string().min(1).max(100),
    coverage: z.array(z.string().min(1).max(1000)).min(1).max(30),
    uncovered: z.array(z.string().max(1000)).max(30),
    issues: z
      .array(reviewIssueSchema)
      .max(100)
      .refine(
        (issues) => new Set(issues.map((issue) => issue.id)).size === issues.length,
        '同一审校报告的问题标识不能重复',
      ),
  }),
  z.strictObject({
    type: z.literal('analysis_note'),
    content: z.string().min(1).max(100000),
    openQuestions: z.array(z.string().max(2000)).max(30),
  }),
]);
export type WorkflowArtifactPayload = z.infer<typeof workflowArtifactPayloadSchema>;

export const workflowOutputTypes = {
  chapter_write: 'chapter_draft',
  worldbuilding: 'element_candidates',
  master_outline: 'master_outline_candidate',
  story_events: 'outline_event_batch',
} as const;
export function isWorkflowOutput(payload: WorkflowArtifactPayload): boolean {
  return Object.values(workflowOutputTypes).some((type) => payload.type === type);
}
export function workflowArtifactText(payload: WorkflowArtifactPayload): string {
  if ('content' in payload) return payload.content;
  return JSON.stringify(payload, null, 2);
}
