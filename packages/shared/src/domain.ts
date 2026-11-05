import { z } from 'zod';

export const idSchema = z.uuid();
export const timestampSchema = z.iso.datetime();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const jsonSchema = z.json();
export type Json = z.infer<typeof jsonSchema>;
export const documentKindSchema = z.enum([
  'chapter',
  'master_outline',
  'chapter_outline',
  'character',
  'story_premise',
  'worldbuilding',
  'core_conflict',
  'timeline_event',
  'foreshadow',
  'narrative_style',
]);
export const versionSourceSchema = z.enum(['manual', 'import', 'proposal', 'restore']);
export const runPurposeSchema = z.enum(['write', 'rewrite', 'review', 'skill_test']);
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'cancelling',
  'completed',
  'limited',
  'failed',
  'cancelled',
  'interrupted',
]);
export const terminalStatusSchema = z.enum([
  'completed',
  'limited',
  'failed',
  'cancelled',
  'interrupted',
]);
export const proposalStatusSchema = z.enum([
  'staged',
  'pending',
  'accepted',
  'rejected',
  'stale',
  'abandoned',
]);
export const errorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'PROJECT_BUSY',
  'MAINTENANCE_MODE',
  'CONTEXT_TOO_LARGE',
  'PROVIDER_AUTH_ERROR',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
  'MODEL_TIMEOUT',
  'MODEL_PROTOCOL_ERROR',
  'OUTPUT_TRUNCATED',
  'MAX_TURNS',
  'MAX_TOOL_CALLS',
  'RUN_DEADLINE',
  'BUDGET_LIMIT',
  'STORAGE_ERROR',
  'EVENT_CURSOR_EXPIRED',
  'UNKNOWN_TOOL',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunPurpose = z.infer<typeof runPurposeSchema>;
export const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled', 'interrupted'],
  running: ['completed', 'limited', 'failed', 'cancelling', 'interrupted'],
  cancelling: ['cancelled', 'interrupted'],
  completed: [],
  limited: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};
export const canTransitionRun = (from: RunStatus, to: RunStatus): boolean =>
  runTransitions[from].includes(to);

export const projectFormatSchema = z.enum(['long', 'short']);
export const projectSchema = z.strictObject({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  format: projectFormatSchema.default('long'),
  setupCompleted: z.boolean().default(true),
  structureVersion: z.int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const documentVersionSchema = z.strictObject({
  id: idSchema,
  documentId: idSchema,
  versionNo: z.int().positive(),
  content: z.string(),
  metadata: z.record(z.string(), jsonSchema),
  contentHash: hashSchema,
  source: versionSourceSchema,
  createdAt: timestampSchema,
});
export const documentSchema = z
  .strictObject({
    id: idSchema,
    projectId: idSchema,
    volumeId: idSchema.nullable(),
    kind: documentKindSchema,
    chapterId: idSchema.nullable(),
    chapterIds: z.array(idSchema).optional(),
    storyTime: z.string().max(16000).optional(),
    summary: z.string().max(4000).optional(),
    archived: z.boolean().optional(),
    title: z.string().min(1).max(200),
    sortOrder: z.int().nonnegative(),
    currentVersionId: idSchema,
    deletedAt: timestampSchema.nullable(),
  })
  .refine((document) => document.kind === 'chapter_outline' || document.chapterId === null, {
    message: '只有章纲可以关联正文',
    path: ['chapterId'],
  });
export const saveDocumentSchema = z.strictObject({
  baseVersionId: idSchema,
  content: z.string(),
  metadata: z.record(z.string(), jsonSchema),
});
export const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      !/^[A-Za-z]:/.test(path) &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    { message: '必须是标准化的相对文件路径' },
  );
export const skillFileSchema = z.strictObject({
  relativePath: relativePathSchema,
  blobHash: hashSchema,
  mediaType: z.string().min(1),
  sizeBytes: z.int().nonnegative(),
});
export const skillVersionSchema = z
  .strictObject({
    id: idSchema,
    skillId: idSchema,
    versionNo: z.int().positive(),
    entryContent: z.string(),
    metadata: z.record(z.string(), jsonSchema),
    sourceSnapshot: z.strictObject({
      type: z.enum(['local', 'git']),
      ref: z.string().nullable(),
      commit: z.string().nullable(),
      subdir: z.string().nullable(),
    }),
    manifestHash: hashSchema,
    files: z.array(skillFileSchema),
    createdAt: timestampSchema,
  })
  .refine(
    (version) =>
      new Set(version.files.map((file) => file.relativePath)).size === version.files.length,
    { message: '附件路径不能重复', path: ['files'] },
  );
export const selectionSchema = z
  .strictObject({
    from: z.int().nonnegative(),
    to: z.int().positive(),
    textHash: hashSchema,
  })
  .refine((range) => range.to > range.from, { message: 'to 必须大于 from', path: ['to'] });
export const changeScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('document') }),
  z.strictObject({ kind: z.literal('selection'), selection: selectionSchema }),
]);
export const usageSchema = z.strictObject({
  inputTokens: z.int().nonnegative().nullable(),
  outputTokens: z.int().nonnegative().nullable(),
  cost: z
    .strictObject({
      amount: z.string().regex(/^\d+(\.\d+)?$/),
      currency: z.string().regex(/^[A-Z]{3}$/),
      source: z.enum(['provider', 'estimate']),
    })
    .nullable(),
});
export type Usage = z.infer<typeof usageSchema>;
export const usageTotalSchema = z.strictObject({ known: usageSchema, complete: z.boolean() });
export const healthSchema = z.strictObject({ status: z.enum(['ok', 'ready', 'not_ready']) });
