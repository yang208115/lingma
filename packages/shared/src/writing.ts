import { z } from 'zod';
import { modelRequestSchema, piConnectionSchema, piParametersSchema } from './agent.js';
import { createRunSchema } from './api.js';
import {
  changeScopeSchema,
  idSchema,
  jsonSchema,
  runStatusSchema,
  timestampSchema,
  usageTotalSchema,
} from './domain.js';
import { outlineCreationProposalSchema } from './outlines.js';
import { skillCatalogEntrySchema } from './skill.js';

export const providerInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(200),
    connection: piConnectionSchema.extend({
      credentialRef: z
        .string()
        .regex(/^(env:[A-Z][A-Z0-9_]{1,100}|local:[a-f0-9-]{36})$/)
        .nullable(),
      contextWindow: z.int().positive(),
      maxOutputTokens: z.int().positive(),
    }),
    parameters: piParametersSchema.default({}),
  })
  .refine(
    (v) =>
      (v.parameters.maxTokens ?? v.connection.maxOutputTokens) <= v.connection.maxOutputTokens &&
      v.connection.maxOutputTokens < v.connection.contextWindow,
    { message: '输出上限必须小于上下文窗口' },
  );
export const providerSchema = z.strictObject({
  id: idSchema,
  revision: z.int().positive(),
  config: providerInputSchema,
  credentialConfigured: z.boolean(),
  updatedAt: timestampSchema,
});
export const writingReferenceSchema = z.strictObject({
  type: z.enum(['document', 'volume']),
  id: idSchema,
  label: z.string().trim().min(1).max(300),
});
export type WritingReference = z.infer<typeof writingReferenceSchema>;

export const writingRunInputSchema = createRunSchema
  .safeExtend({
    input: z.string().trim().min(1).max(32000),
    context: createRunSchema.shape.context.extend({
      selectedVersionIds: z.array(idSchema).max(200),
      allowedVersionIds: z.array(idSchema).max(1000).optional(),
      references: z.array(writingReferenceSchema).max(200).optional(),
    }),
    allowTargetProposal: z.boolean().default(false),
    allowOutlineCreation: z.boolean().default(false),
    allowChapterCreation: z.boolean().optional(),
    expectedContextHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.allowChapterCreation &&
      (!value.projectId ||
        !['write', 'review'].includes(value.purpose) ||
        value.allowOutlineCreation)
    )
      ctx.addIssue({
        code: 'custom',
        message: '新建章节需授权作品内的写作或聊天任务',
        path: ['allowChapterCreation'],
      });
    if (value.context.references?.length && !value.projectId)
      ctx.addIssue({
        code: 'custom',
        message: '引用必须属于当前作品',
        path: ['context', 'references'],
      });
    if (value.allowOutlineCreation && (value.purpose !== 'review' || !value.projectId))
      ctx.addIssue({
        code: 'custom',
        message: '创建大纲需授权作品内的大纲规划任务',
        path: ['allowOutlineCreation'],
      });
    if (value.target && !value.projectId)
      ctx.addIssue({ code: 'custom', message: '目标必须属于作品', path: ['projectId'] });
    if (value.allowTargetProposal && (value.purpose !== 'review' || !value.target))
      ctx.addIssue({
        code: 'custom',
        message: '仅审校可额外授权目标提议',
        path: ['allowTargetProposal'],
      });
  });
export const contextEntrySchema = z.strictObject({
  citationId: z.string(),
  documentId: idSchema,
  versionId: idSchema,
  title: z.string(),
  kind: z.string(),
  contentHash: z.string(),
  excerpt: z.string(),
  metadata: z.record(z.string(), jsonSchema).default({}),
  from: z.int().nonnegative(),
  to: z.int().nonnegative(),
  reason: z.string(),
  selected: z.boolean(),
  planning: z.boolean(),
});
export const contextPreviewSchema = z.strictObject({
  hash: z.string(),
  agentPromptRevision: z.int().nonnegative().default(0),
  skills: z.array(skillCatalogEntrySchema).default([]),
  entries: z.array(contextEntrySchema),
  allowed: z.array(contextEntrySchema.omit({ excerpt: true, metadata: true })),
  omitted: z.array(z.string()),
  warnings: z.array(z.string()),
  estimatedInputTokens: z.int().nonnegative(),
  reservedOutputTokens: z.int().positive(),
  inputLimit: z.int().positive(),
  estimated: z.literal(true),
  request: modelRequestSchema,
});
export const sessionSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  chapterId: idSchema.nullable(),
  title: z.string(),
  createdAt: timestampSchema,
});
export const sessionInputSchema = z.strictObject({
  chapterId: idSchema.nullable().default(null),
  title: z.string().trim().min(1).max(200),
});
export const renameSessionSchema = sessionInputSchema.pick({ title: true });
export const sessionHistorySchema = sessionSchema.extend({
  updatedAt: timestampSchema,
  deletedAt: timestampSchema.nullable(),
  preview: z.string(),
  messageCount: z.int().nonnegative(),
  runCount: z.int().nonnegative(),
  latestRunId: idSchema.nullable(),
  latestRunStatus: runStatusSchema.nullable(),
});
export const chatMessageSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: timestampSchema,
});
export const proposalSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  turnIndex: z.int().nonnegative(),
  targetDocumentId: idSchema,
  baseVersionId: idSchema,
  scope: changeScopeSchema,
  content: z.string(),
  reason: z.string(),
  citations: z.array(z.string()),
  status: z.enum(['staged', 'pending', 'accepted', 'rejected', 'stale', 'abandoned']),
  acceptedVersionId: idSchema.nullable(),
  origin: z.enum(['tool', 'candidate']),
  createdAt: timestampSchema,
});
export const runSummarySchema = z.strictObject({
  id: idSchema,
  taskPreview: z.string().default(''),
  projectId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  purpose: z.enum(['write', 'rewrite', 'review', 'skill_test']),
  status: runStatusSchema,
  stopReason: z.string().nullable(),
  retryOfRunId: idSchema.nullable(),
  lastEventSeq: z.int().nonnegative(),
  eventFloor: z.int().positive(),
  createdAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  usage: usageTotalSchema,
  output: z
    .strictObject({ messageId: idSchema, text: z.string(), committed: z.boolean() })
    .nullable(),
});
export const runDetailSchema = runSummarySchema.extend({
  trace: z
    .array(
      z.strictObject({
        seq: z.int().positive(),
        type: z.enum([
          'run.started',
          'turn.started',
          'model.retry',
          'turn.completed',
          'tool.started',
          'tool.completed',
          'run.finished',
        ]),
        turnIndex: z.int().nonnegative().nullable(),
        executionId: idSchema.nullable(),
        retryAttempt: z.int().min(1).max(5).nullable().default(null),
        maxRetries: z.literal(5).nullable().default(null),
        createdAt: timestampSchema,
      }),
    )
    .default([]),
  outlineProposals: z.array(outlineCreationProposalSchema).default([]),
  input: writingRunInputSchema,
  preview: contextPreviewSchema,
  turns: z.array(
    z.strictObject({
      turnIndex: z.int().nonnegative(),
      status: z.string(),
      partialText: z.string(),
      thinking: z.string().default(''),
      request: jsonSchema.nullable(),
      response: jsonSchema.nullable(),
    }),
  ),
  tools: z.array(
    z.strictObject({
      id: idSchema,
      turnIndex: z.int().nonnegative(),
      callId: z.string(),
      name: z.string(),
      args: jsonSchema.nullable(),
      result: jsonSchema.nullable(),
    }),
  ),
  contexts: z.array(contextEntrySchema),
  proposals: z.array(proposalSchema),
  usageDetails: jsonSchema.nullable(),
});
export const proposalAcceptSchema = z.strictObject({
  proposalId: idSchema,
  acceptedVersionId: idSchema,
});
export const connectionCheckSchema = z.strictObject({
  id: idSchema,
  providerId: idSchema,
  modelId: z.string(),
  status: z.string(),
  stopReason: z.string(),
  usage: usageTotalSchema,
  createdAt: timestampSchema,
});
export type ProviderInput = z.infer<typeof providerInputSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type WritingRunInput = z.infer<typeof writingRunInputSchema>;
export type ContextEntry = z.infer<typeof contextEntrySchema>;
export type ContextPreview = z.infer<typeof contextPreviewSchema>;
export type WritingSession = z.infer<typeof sessionSchema>;
export type SessionHistory = z.infer<typeof sessionHistorySchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
