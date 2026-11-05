import { z } from 'zod';
import {
  documentKindSchema,
  hashSchema,
  idSchema,
  timestampSchema,
  usageTotalSchema,
} from './domain.js';
import { workflowArtifactPayloadSchema, workflowTaskSchema } from './workflow-artifacts.js';
import { orderedWorkflowSteps, workflowAncestors, workflowDependencies } from './workflow-graph.js';
import { contextPreviewSchema, proposalSchema, runDetailSchema } from './writing.js';

export const agentCapabilitySchema = z.enum(['plan', 'draft', 'generate', 'review', 'analysis']);
export const profileToolSchema = z.enum([
  'read_document',
  'search_documents',
  'load_skill',
  'read_skill_file',
]);
const discardLegacyLimits = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
};
export const agentProfileConfigSchema = z.preprocess(
  (value) => discardLegacyLimits(value, ['maxTurns', 'timeoutMs', 'maxOutputTokens']),
  z.strictObject({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(''),
    prompt: z.string().trim().min(1).max(32000),
    capability: agentCapabilitySchema,
    providerConfigId: idSchema.nullable().default(null),
    skillVersionIds: z.array(idSchema).max(30).default([]),
    tools: z
      .array(profileToolSchema)
      .max(4)
      .default(['read_document', 'search_documents', 'load_skill', 'read_skill_file']),
    contextKinds: z
      .array(documentKindSchema)
      .min(1)
      .max(10)
      .default(['chapter', 'master_outline', 'chapter_outline', 'character']),
  }),
);
export const agentProfileVersionSchema = z.strictObject({
  id: idSchema,
  profileId: idSchema,
  versionNo: z.int().positive(),
  config: agentProfileConfigSchema,
  createdAt: timestampSchema,
});
export const agentProfileSchema = z.strictObject({
  id: idSchema,
  revision: z.int().positive(),
  archived: z.boolean(),
  builtin: z.boolean(),
  draft: agentProfileConfigSchema,
  versions: z.array(agentProfileVersionSchema),
  updatedAt: timestampSchema,
});
export const workflowStepSchema = z.strictObject({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,49}$/),
  name: z.string().trim().min(1).max(100),
  stage: z.enum(['plan', 'draft', 'generate', 'review', 'analysis', 'revise']),
  agentVersionId: idSchema,
  required: z.boolean().default(true),
  dependsOn: z
    .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,49}$/))
    .max(16)
    .optional(),
  position: z
    .strictObject({
      x: z.number().finite().min(-100000).max(100000),
      y: z.number().finite().min(-100000).max(100000),
    })
    .optional(),
});
export const workflowTemplateConfigSchema = z.preprocess(
  (value) => {
    const config = discardLegacyLimits(value, ['maxModelCalls', 'deadlineMs', 'maxRevisions']);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
    const legacy = value as Record<string, unknown>;
    return { autoRevise: legacy.maxRevisions !== 0, ...config };
  },
  z
    .strictObject({
      name: z.string().trim().min(1).max(100),
      taskType: workflowTaskSchema.default('chapter_write'),
      steps: z.array(workflowStepSchema).min(2).max(16),
      confirmPlan: z.boolean().default(true),
      autoRevise: z.boolean().default(true),
    })
    .superRefine((value, ctx) => {
      let steps = value.steps;
      try {
        steps = orderedWorkflowSteps(steps);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : '流程连线无效',
          path: ['steps'],
        });
        return;
      }
      if (new Set(steps.map((s) => s.key)).size !== steps.length)
        ctx.addIssue({ code: 'custom', message: '节点标识不能重复', path: ['steps'] });
      const firstReview = steps.findIndex((s) => s.stage === 'review');
      const firstDraft = steps.findIndex((s) => ['draft', 'generate'].includes(s.stage));
      if (
        firstDraft < 0 ||
        firstReview <= firstDraft ||
        !steps.some((s) => s.stage === 'review' && s.required)
      )
        ctx.addIssue({
          code: 'custom',
          message: '需要先生成内容，再至少完成一个必需审校',
          path: ['steps'],
        });
      if (
        steps.filter((s) => s.stage === 'plan').length > 1 ||
        steps.filter((s) => s.stage === 'revise').length > 1
      )
        ctx.addIssue({ code: 'custom', message: '最多一个策划及修订节点', path: ['steps'] });
      steps.forEach((s, i) => {
        if (
          (s.stage === 'plan' && i > firstDraft) ||
          (['draft', 'generate'].includes(s.stage) && i > firstReview) ||
          (s.stage === 'revise' && i !== steps.length - 1)
        )
          ctx.addIssue({
            code: 'custom',
            message: '策划须在生成前，生成须在审校前，修订须放在最后',
            path: ['steps', i],
          });
      });
      const dependencies = workflowDependencies(value.steps);
      const outputs = steps.filter((s) => ['draft', 'generate'].includes(s.stage));
      const finalOutput = outputs.at(-1);
      if (finalOutput) {
        const ancestors = workflowAncestors(finalOutput.key, dependencies);
        if (outputs.some((s) => s.key !== finalOutput.key && !ancestors.has(s.key)))
          ctx.addIssue({
            code: 'custom',
            message: '多个生成节点必须连成一条内容修订链',
            path: ['steps'],
          });
        for (const step of steps) {
          if (
            step.stage === 'review' &&
            !workflowAncestors(step.key, dependencies).has(finalOutput.key)
          )
            ctx.addIssue({
              code: 'custom',
              message: `审校「${step.name}」需要连接到最终生成节点的下游`,
              path: ['steps'],
            });
          if (step.stage === 'plan' && !ancestors.has(step.key))
            ctx.addIssue({
              code: 'custom',
              message: '策划必须连接到生成节点的上游',
              path: ['steps'],
            });
        }
      }
    }),
);
export const workflowTemplateVersionSchema = z.strictObject({
  id: idSchema,
  templateId: idSchema,
  versionNo: z.int().positive(),
  config: workflowTemplateConfigSchema,
  createdAt: timestampSchema,
});
export const workflowTemplateSchema = z.strictObject({
  id: idSchema,
  revision: z.int().positive(),
  draft: workflowTemplateConfigSchema,
  versions: z.array(workflowTemplateVersionSchema),
  updatedAt: timestampSchema,
});
export const workflowInputSchema = z.strictObject({
  projectId: idSchema,
  taskType: workflowTaskSchema.default('chapter_write'),
  sessionId: idSchema.nullable().default(null),
  targetDocumentId: idSchema.nullable().default(null),
  baseVersionId: idSchema.nullable().default(null),
  mode: z.enum(['create', 'fill', 'replace', 'extract']).default('create'),
  templateVersionId: idSchema,
  providerConfigId: idSchema,
  input: z.string().trim().min(1).max(32000),
  allowedVersionIds: z.array(idSchema).max(1000).optional(),
  selectedVersionIds: z.array(idSchema).max(200).default([]),
  allowFutureOutline: z.boolean().default(false),
  expectedPreviewHash: hashSchema.optional(),
});
export const workflowPreviewSchema = z.preprocess(
  (value) => discardLegacyLimits(value, ['maxNodeAttempts']),
  z.strictObject({
    hash: hashSchema,
    input: workflowInputSchema,
    template: workflowTemplateVersionSchema,
    profiles: z.array(agentProfileVersionSchema),
    contexts: z.record(z.string(), contextPreviewSchema),
    warnings: z.array(z.string()),
  }),
);
export const workflowArtifactSchema = z.strictObject({
  id: idSchema,
  workflowId: idSchema,
  nodeKey: z.string(),
  runId: idSchema,
  payload: workflowArtifactPayloadSchema,
  contentHash: hashSchema,
  inputArtifactIds: z.array(idSchema),
  createdAt: timestampSchema,
});
export const workflowNodeSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
  stage: workflowStepSchema.shape.stage,
  agentVersionId: idSchema,
  required: z.boolean(),
  status: z.enum([
    'pending',
    'queued',
    'running',
    'succeeded',
    'failed',
    'limited',
    'cancelled',
    'interrupted',
    'skipped',
    'invalidated',
  ]),
  runIds: z.array(idSchema),
  artifactId: idSchema.nullable(),
  inputArtifactIds: z.array(idSchema),
  error: z.string().nullable(),
});
export const workflowStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_input',
  'awaiting_acceptance',
  'paused',
  'completed',
  'failed',
  'limited',
  'cancelled',
  'interrupted',
]);
export const workflowDecisionSchema = z.strictObject({
  expectedRevision: z.int().positive(),
  action: z.enum([
    'confirm_plan',
    'continue',
    'use_candidate',
    'retry',
    'resume',
    'pause',
    'cancel',
    'reject',
    'edit_candidate',
    'use_snapshot',
    'accept_result',
  ]),
  content: z.string().max(1000000).optional(),
  payload: workflowArtifactPayloadSchema.optional(),
  itemIds: z.array(z.string().min(1).max(100)).max(30).optional(),
  feedback: z.string().max(8000).default(''),
});
export const workflowRunSchema = z.strictObject({
  id: idSchema,
  revision: z.int().positive(),
  projectId: idSchema,
  targetDocumentId: idSchema.nullable(),
  status: workflowStatusSchema,
  reason: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  snapshot: workflowPreviewSchema,
  nodes: z.array(workflowNodeSchema),
  artifacts: z.array(workflowArtifactSchema),
  latestDraftId: idSchema.nullable(),
  planConfirmed: z.boolean(),
  revisionCount: z.int().nonnegative(),
  modelCalls: z.int().nonnegative(),
  formatRepairs: z.int().nonnegative().default(0),
  elapsedMs: z.int().nonnegative(),
  pauseRequested: z.boolean(),
  proposalId: idSchema.nullable(),
  proposal: proposalSchema.nullable(),
  outcome: z.enum(['accepted', 'rejected']).nullable(),
  acceptedResults: z
    .array(
      z.strictObject({
        itemId: z.string(),
        documentId: idSchema,
        versionId: idSchema,
      }),
    )
    .default([]),
  feedback: z.string(),
  sourceHistory: z.array(workflowPreviewSchema).default([]),
  sourceSnapshotAccepted: z.boolean().default(false),
  sourceChanges: z.array(z.string()).default([]),
  usage: usageTotalSchema,
  usageByCurrency: z
    .array(
      z.strictObject({
        currency: z.string(),
        amount: z.string(),
        source: z.enum(['provider', 'estimate']),
        mixedSources: z.boolean(),
      }),
    )
    .default([]),
});
export const workflowEventSchema = z.strictObject({
  workflowId: idSchema,
  seq: z.int().positive(),
  type: z.string(),
  status: workflowStatusSchema,
  revision: z.int().positive(),
  createdAt: timestampSchema,
});
export const agentTestResultSchema = z.strictObject({
  run: runDetailSchema,
  artifact: workflowArtifactPayloadSchema.nullable(),
});
export type AgentProfileConfig = z.infer<typeof agentProfileConfigSchema>;
export type AgentProfileVersion = z.infer<typeof agentProfileVersionSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type WorkflowTemplateConfig = z.infer<typeof workflowTemplateConfigSchema>;
export type WorkflowTemplateVersion = z.infer<typeof workflowTemplateVersionSchema>;
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type WorkflowInputRequest = z.input<typeof workflowInputSchema>;
export type WorkflowPreview = z.infer<typeof workflowPreviewSchema>;
export type WorkflowArtifact = z.infer<typeof workflowArtifactSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowDecision = z.infer<typeof workflowDecisionSchema>;
