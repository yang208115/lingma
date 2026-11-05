import { z } from 'zod';
import {
  errorCodeSchema,
  idSchema,
  jsonSchema,
  runPurposeSchema,
  selectionSchema,
} from './domain.js';

export const responseSchema = <T extends z.ZodType>(data: T) => z.strictObject({ data });
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
export const paginationSchema = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string().min(1),
    details: z.record(z.string(), jsonSchema).optional(),
  }),
});
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
// Accept and discard legacy limits so saved runs and older clients remain readable.
export const runLimitsSchema = z.object({});
export const createRunSchema = z
  .strictObject({
    projectId: idSchema.nullable(),
    sessionId: idSchema.nullable(),
    purpose: runPurposeSchema,
    input: z.string().min(1),
    target: z
      .strictObject({
        documentId: idSchema,
        baseVersionId: idSchema,
        selection: selectionSchema.optional(),
      })
      .optional(),
    skillVersionId: idSchema.optional(),
    providerConfigId: idSchema,
    modelId: z.string().min(1),
    context: z.strictObject({
      selectedVersionIds: z.array(idSchema),
      allowSearch: z.boolean(),
      allowFutureOutline: z.boolean(),
    }),
    limits: runLimitsSchema.optional(),
  })
  .superRefine((run, context) => {
    if ((run.purpose === 'write' || run.purpose === 'rewrite') && (!run.projectId || !run.target)) {
      context.addIssue({
        code: 'custom',
        message: '写作与改写必须指定作品和目标',
        path: ['target'],
      });
    }
    if (run.purpose === 'skill_test' && run.target) {
      context.addIssue({ code: 'custom', message: 'Skill 实验不能指定写入目标', path: ['target'] });
    }
    if (!run.projectId && (run.sessionId || run.context.selectedVersionIds.length > 0)) {
      context.addIssue({ code: 'custom', message: '会话和资料必须属于作品', path: ['projectId'] });
    }
  });
export type CreateRun = z.infer<typeof createRunSchema>;
