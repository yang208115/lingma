import { z } from 'zod';
import { hashSchema, idSchema, timestampSchema } from './domain.js';

export const reviewIssueSchema = z.strictObject({
  id: z.string().min(1).max(200),
  severity: z.enum(['P0', 'P1', 'P2']),
  summary: z.string().max(2000),
  quote: z.string().max(20000),
  body: z.string().max(20000),
  located: z.boolean(),
  structured: z.boolean(),
  sources: z.array(z.string().max(200)).max(50).default([]),
});
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;
export const workflowArtifactKindSchema = z.enum([
  'plan',
  'draft',
  'records',
  'analysis',
  'review',
  'merge',
]);
export type WorkflowArtifactKind = z.infer<typeof workflowArtifactKindSchema>;
/** Kinds a generate or revise node can produce, i.e. the author-visible deliverable. */
export const workflowOutputKinds: readonly WorkflowArtifactKind[] = ['draft', 'records'];
export const isWorkflowOutputKind = (kind: WorkflowArtifactKind) =>
  kind === 'draft' || kind === 'records';
export const workflowArtifactSchema = z.strictObject({
  id: idSchema,
  workflowId: idSchema,
  nodeKey: z.string(),
  round: z.int().nonnegative(),
  runId: idSchema.nullable(),
  kind: workflowArtifactKindSchema,
  markdown: z.string().max(1000000),
  contentHash: hashSchema,
  inputArtifactIds: z.array(idSchema),
  createdBy: z.enum(['model', 'author', 'system']),
  supersedes: idSchema.nullable(),
  issues: z.array(reviewIssueSchema).default([]),
  createdAt: timestampSchema,
});
export type WorkflowArtifact = z.infer<typeof workflowArtifactSchema>;
