import { z } from 'zod';
import {
  errorCodeSchema,
  idSchema,
  terminalStatusSchema,
  timestampSchema,
  usageSchema,
  usageTotalSchema,
} from './domain.js';

const envelope = { schemaVersion: z.literal(1), runId: idSchema, seq: z.int().positive() };
const turn = { turnIndex: z.int().nonnegative() };
export const runEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...envelope,
    type: z.literal('run.started'),
    modelId: z.string().min(1),
    startedAt: timestampSchema,
  }),
  z.strictObject({ ...envelope, ...turn, type: z.literal('turn.started') }),
  z.strictObject({
    ...envelope,
    ...turn,
    type: z.literal('model.retry'),
    attempt: z.int().min(1).max(5),
    maxRetries: z.literal(5),
  }),
  z.strictObject({
    ...envelope,
    ...turn,
    type: z.literal('thinking.delta'),
    messageId: idSchema,
    text: z.string(),
  }),
  z.strictObject({
    ...envelope,
    ...turn,
    type: z.literal('text.delta'),
    messageId: idSchema,
    text: z.string(),
  }),
  z.strictObject({
    ...envelope,
    ...turn,
    type: z.literal('tool.arguments.delta'),
    callIndex: z.int().nonnegative(),
    delta: z.string(),
  }),
  z.strictObject({
    ...envelope,
    ...turn,
    type: z.literal('tool.started'),
    executionId: idSchema,
    callId: z.string().min(1),
    name: z.string().min(1).max(200),
  }),
  z.strictObject({
    ...envelope,
    ...turn,
    type: z.literal('tool.completed'),
    executionId: idSchema,
    callId: z.string().min(1),
    resultSummary: z.string().max(4000),
    isError: z.boolean(),
  }),
  z.strictObject({
    ...envelope,
    ...turn,
    type: z.literal('proposal.created'),
    proposalId: idSchema,
    targetDocumentId: idSchema,
  }),
  z.strictObject({ ...envelope, ...turn, type: z.literal('turn.completed'), usage: usageSchema }),
  z.strictObject({
    ...envelope,
    type: z.literal('run.finished'),
    status: terminalStatusSchema,
    stopReason: z.union([
      z.literal('complete'),
      z.literal('cancelled'),
      z.literal('interrupted'),
      errorCodeSchema,
    ]),
    usage: usageTotalSchema,
    outputMessageId: idSchema.nullable(),
  }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
