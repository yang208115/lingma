import { z } from 'zod';
import { piConnectionSchema } from './agent.js';
import {
  documentKindSchema,
  hashSchema,
  idSchema,
  timestampSchema,
  usageTotalSchema,
} from './domain.js';
import { basicInformationKinds } from './elements.js';
import { reviewIssueSchema, workflowArtifactSchema } from './workflow-artifacts.js';
import { orderedWorkflowSteps, workflowAncestors, workflowDependencies } from './workflow-graph.js';
import { workflowResultSchema, workflowTaskSchema } from './workflow-results.js';
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
      .max(documentKindSchema.options.length)
      .default(['chapter', 'master_outline', 'chapter_outline', 'chapter_plan', 'character']),
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
  stage: z.enum(['plan', 'draft', 'generate', 'review', 'analysis', 'revise', 'agent', 'debate']),
  debate: z
    .strictObject({
      rounds: z.int().min(1).max(20),
      participants: z
        .array(
          z.strictObject({
            name: z.string().trim().min(1).max(100),
            agentVersionId: idSchema,
            instructions: z.string().max(8000),
          }),
        )
        .min(2)
        .max(8),
    })
    .optional(),
  instructions: z.string().max(8000).optional(),
  feedbackFrom: z
    .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,49}$/))
    .max(16)
    .optional(),
  runWhen: z.enum(['each_round', 'after_rounds']).optional(),
  agentVersionId: idSchema,
  required: z.boolean().default(true),
  gate: z.enum(['auto', 'manual']).default('auto'),
  dependsOn: z
    .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,49}$/))
    .max(16)
    .default([]),
  position: z
    .strictObject({
      x: z.number().finite().min(-100000).max(100000),
      y: z.number().finite().min(-100000).max(100000),
    })
    .optional(),
});
export const workflowTemplateConfigSchema = z.preprocess(
  (value) =>
    discardLegacyLimits(value, ['maxModelCalls', 'deadlineMs', 'maxRevisions', 'confirmPlan']),
  z
    .strictObject({
      name: z.string().trim().min(1).max(100),
      taskType: workflowTaskSchema.default('chapter_write'),
      steps: z.array(workflowStepSchema).min(1).max(16),
      executionMode: z.enum(['review', 'graph']).optional(),
      maxRounds: z.int().min(1).max(20).optional(),
      outputNodeKey: z.string().max(50).optional(),
      autoRevise: z.boolean().default(true),
      adoptionGate: z.enum(['auto', 'manual']).default('auto'),
    })
    .superRefine((value, ctx) => {
      const fail = (message: string, path: (string | number)[] = ['steps']) =>
        ctx.addIssue({ code: 'custom', message, path });
      const steps = value.steps;
      for (const step of steps) {
        if (step.stage === 'debate' && !step.debate) fail('请配置辩论参与者与轮数');
        if (step.stage !== 'debate' && step.debate) fail('辩论配置只能用于多 Agent 辩论节点');
      }
      if (new Set(steps.map((s) => s.key)).size !== steps.length) {
        fail('节点标识不能重复');
        return;
      }
      try {
        orderedWorkflowSteps(steps);
      } catch (error) {
        fail(error instanceof Error ? error.message : '流程连线无效');
        return;
      }
      if (value.executionMode === 'graph') {
        if (steps.some((step) => step.stage !== 'agent')) fail('自由图中的每个节点都必须是 Agent');
        if (!steps.some((step) => step.key === value.outputNodeKey))
          fail('请选择最终输出 Agent', ['outputNodeKey']);
        if (!steps.some((step) => step.runWhen !== 'after_rounds'))
          fail('至少需要一个每轮发言的 Agent');
        for (const step of steps) {
          const feedback = step.feedbackFrom ?? [];
          if (new Set(feedback).size !== feedback.length) fail('反馈连线不能重复');
          if (feedback.some((key) => !steps.some((source) => source.key === key)))
            fail(`「${step.name}」的反馈连线引用了不存在的 Agent`);
          if (
            feedback.some(
              (key) => steps.find((source) => source.key === key)?.runWhen === 'after_rounds',
            )
          )
            fail('汇总 Agent 只在辩论结束后运行，不能反馈到辩论中');
          if (step.runWhen === 'after_rounds' && feedback.length)
            fail('汇总 Agent 请用普通连线接收最后一轮发言');
          if (
            step.runWhen !== 'after_rounds' &&
            step.dependsOn.some(
              (key) => steps.find((source) => source.key === key)?.runWhen === 'after_rounds',
            )
          )
            fail('每轮发言的 Agent 不能等待辩论结束后的汇总');
        }
        return;
      }
      if (steps.length < 2) fail('审校流程至少需要两个节点');
      if (steps.some((step) => step.stage === 'agent' || step.feedbackFrom?.length))
        fail('Agent 节点与反馈连线请使用自由 Agent 图');
      const outputs = steps.filter((s) => ['draft', 'generate'].includes(s.stage));
      if (!outputs.length) fail('至少需要一个生成节点');
      if (!steps.some((s) => s.stage === 'review' && s.required)) fail('至少需要一个必需审校');
      if (
        steps.filter((s) => s.stage === 'plan').length > 1 ||
        steps.filter((s) => s.stage === 'revise').length > 1
      )
        fail('最多一个策划及修订节点');
      const dependencies = workflowDependencies(steps);
      for (const step of steps)
        if (
          step.stage === 'review' &&
          (dependencies.get(step.key) ?? []).some(
            (key) => steps.find((s) => s.key === key)?.stage === 'review',
          )
        )
          fail(`审校「${step.name}」不能依赖其他审校，同一稿件的审校相互独立`);
      const finalOutput = outputs.at(-1);
      if (!finalOutput) return;
      const ancestors = workflowAncestors(finalOutput.key, dependencies);
      if (outputs.some((s) => s.key !== finalOutput.key && !ancestors.has(s.key)))
        fail('多个生成节点必须连成一条内容修订链');
      for (const step of steps) {
        if (
          step.stage === 'review' &&
          !workflowAncestors(step.key, dependencies).has(finalOutput.key)
        )
          fail(`审校「${step.name}」需要连接到最终生成节点的下游`);
        if (step.stage === 'plan' && !ancestors.has(step.key)) fail('策划必须连接到生成节点的上游');
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
  sourceOutlineId: idSchema.optional(),
  volumeId: idSchema.nullable().optional(),
  newVolumeTitle: z.string().trim().min(1).max(200).optional(),
  chapterCount: z.int().min(1).max(30).optional(),
  baseVersionId: idSchema.nullable().default(null),
  mode: z.enum(['create', 'fill', 'replace', 'extract']).default('create'),
  elementKinds: z
    .array(z.enum(basicInformationKinds))
    .min(1)
    .max(5)
    .refine((kinds) => new Set(kinds).size === kinds.length, '基础信息分类不能重复')
    .optional(),
  elementTargets: z
    .array(z.strictObject({ documentId: idSchema, baseVersionId: idSchema }))
    .max(30)
    .refine(
      (targets) => new Set(targets.map((target) => target.documentId)).size === targets.length,
      '基础信息目标不能重复',
    )
    .optional(),
  templateVersionId: idSchema,
  providerConfigId: idSchema,
  input: z.string().trim().min(1).max(32000),
  allowedVersionIds: z.array(idSchema).max(1000).optional(),
  selectedVersionIds: z.array(idSchema).max(200).default([]),
  allowFutureOutline: z.boolean().default(false),
  manualGates: z.boolean().default(false),
  expectedPreviewHash: hashSchema.optional(),
});
export const workflowContextPreviewSchema = contextPreviewSchema.extend({
  request: contextPreviewSchema.shape.request.extend({
    connectionSnapshot: z.preprocess(
      // Old workflows may contain transport settings; never freeze or reuse them.
      (value) => discardLegacyLimits(value, ['baseUrl', 'credentialRef']),
      piConnectionSchema.omit({ baseUrl: true, credentialRef: true }),
    ),
  }),
});
export const workflowPreviewSchema = z.preprocess(
  (value) => discardLegacyLimits(value, ['maxNodeAttempts']),
  z.strictObject({
    hash: hashSchema,
    input: workflowInputSchema,
    template: workflowTemplateVersionSchema,
    profiles: z.array(agentProfileVersionSchema),
    contexts: z.record(z.string(), workflowContextPreviewSchema),
    warnings: z.array(z.string()),
  }),
);
export const workflowNodeStageSchema = z.enum([
  'plan',
  'draft',
  'generate',
  'review',
  'analysis',
  'revise',
  'merge',
  'agent',
  'debate',
]);
export const workflowNodeStatusSchema = z.enum([
  'pending',
  'queued',
  'running',
  'awaiting_gate',
  'released',
  'failed',
  'limited',
  'cancelled',
  'interrupted',
  'skipped',
  'stale',
]);
export const workflowNodeSchema = z.strictObject({
  key: z.string(),
  templateKey: z.string(),
  round: z.int().nonnegative(),
  debateRound: z.int().nonnegative().optional(),
  debateParticipant: z.int().nonnegative().optional(),
  name: z.string(),
  stage: workflowNodeStageSchema,
  agentVersionId: idSchema.nullable(),
  required: z.boolean(),
  gate: z.enum(['auto', 'manual']),
  dependsOn: z.array(z.string()).default([]),
  status: workflowNodeStatusSchema,
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
export const workflowReasonCodeSchema = z.enum(['GATE', 'ADOPT', 'NO_CHANGE', 'RESULT']);
export const workflowDecisionSchema = z.strictObject({
  expectedRevision: z.int().positive(),
  action: z.enum([
    'release',
    'rerun',
    'edit_artifact',
    'set_adoption',
    'rerun_missing',
    'continue',
    'use_candidate',
    'retry',
    'resume',
    'pause',
    'cancel',
    'reject',
    'use_snapshot',
    'accept_result',
  ]),
  nodeKey: z.string().min(1).max(100).optional(),
  content: z.string().max(1000000).optional(),
  issueId: z.string().min(1).max(200).optional(),
  adoption: z.enum(['adopt', 'ignore']).optional(),
  reason: z.string().max(2000).optional(),
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
  reasonCode: workflowReasonCodeSchema.nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  snapshot: workflowPreviewSchema,
  round: z.int().nonnegative().default(0),
  nodes: z.array(workflowNodeSchema),
  artifacts: z.array(workflowArtifactSchema),
  latestDraftId: idSchema.nullable(),
  adoption: z
    .record(
      z.string(),
      z.strictObject({ decision: z.enum(['adopt', 'ignore']), reason: z.string().max(2000) }),
    )
    .default({}),
  notes: z.record(z.string(), z.string().max(8000)).default({}),
  result: workflowResultSchema.nullable().default(null),
  resultError: z.string().nullable().default(null),
  resultWarnings: z.array(z.string()).default([]),
  missingKinds: z.array(z.string()).default([]),
  revisionCount: z.int().nonnegative(),
  modelCalls: z.int().nonnegative(),
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
  artifact: z.string().nullable(),
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
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowDecision = z.infer<typeof workflowDecisionSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export { reviewIssueSchema };
