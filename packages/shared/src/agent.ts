import { z } from 'zod';
import { errorCodeSchema, idSchema, jsonSchema, usageSchema } from './domain.js';

export const modelCallSchema = z.strictObject({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(200),
  arguments: jsonSchema,
});
export const actionOutcomeSchema = z.discriminatedUnion('ok', [
  z.strictObject({ callId: z.string().min(1), ok: z.literal(true), value: jsonSchema }),
  z.strictObject({
    callId: z.string().min(1),
    ok: z.literal(false),
    error: z.strictObject({ code: errorCodeSchema, message: z.string().max(4000) }),
  }),
]);
export const assistantTranscriptSchema = z.strictObject({
  role: z.literal('assistant'),
  content: z.string().default(''),
  toolCalls: z.array(modelCallSchema).default([]),
  protocol: z.strictObject({ adapter: z.string().min(1), message: jsonSchema }).optional(),
});
export const transcriptMessageSchema = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.literal('user'),
    content: z.string(),
    timestamp: z.int().nonnegative(),
  }),
  assistantTranscriptSchema,
  z.strictObject({
    role: z.literal('toolResult'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    result: actionOutcomeSchema,
    timestamp: z.int().nonnegative(),
  }),
]);
export const modelRequestSchema = z.strictObject({
  connectionSnapshot: jsonSchema,
  modelId: z.string().min(1),
  systemPrompt: z.string(),
  messages: z.array(transcriptMessageSchema),
  toolDefinitions: z.array(jsonSchema),
  parameters: z.record(z.string(), jsonSchema),
});
export const modelResponseSchema = z.strictObject({
  transcriptMessage: assistantTranscriptSchema,
  text: z.string(),
  thinking: z.string().optional(),
  calls: z.array(modelCallSchema),
  stop: z.enum(['complete', 'tool_calls', 'truncated', 'error', 'aborted']),
  usage: usageSchema,
  errorCode: errorCodeSchema.optional(),
});
export const modelEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text_delta'), text: z.string() }),
  z.strictObject({ type: z.literal('thinking_delta'), text: z.string() }),
  z.strictObject({
    type: z.literal('tool_call_delta'),
    callIndex: z.int().nonnegative(),
    delta: z.string(),
  }),
  z.strictObject({ type: z.literal('response'), response: modelResponseSchema }),
]);
export const checkpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  adapterId: z.string().min(1),
  initialRequest: modelRequestSchema,
  nextTurnIndex: z.int().positive(),
  messages: z.array(transcriptMessageSchema),
  lastTurn: z.strictObject({
    turnIndex: z.int().nonnegative(),
    messageId: idSchema,
    response: modelResponseSchema,
    results: z.array(actionOutcomeSchema),
  }),
});
export const piConnectionSchema = z.strictObject({
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  provider: z.string().min(1).max(200),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, '需要不含凭据或查询参数的 HTTP(S) URL'),
  credentialRef: z.string().min(1).nullable(),
  contextWindow: z.int().positive(),
  maxOutputTokens: z.int().positive(),
  reasoning: z.boolean().default(false),
  pricing: z
    .strictObject({
      input: z
        .string()
        .max(64)
        .regex(/^\d+(\.\d{1,12})?$/),
      output: z
        .string()
        .max(64)
        .regex(/^\d+(\.\d{1,12})?$/),
      cacheRead: z
        .string()
        .max(64)
        .regex(/^\d+(\.\d{1,12})?$/),
      cacheWrite: z
        .string()
        .max(64)
        .regex(/^\d+(\.\d{1,12})?$/),
    })
    .nullable()
    .default(null),
});
export const piParametersSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.int().positive().optional(),
});
export type ModelCall = z.infer<typeof modelCallSchema>;
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;
export type AssistantTranscript = z.infer<typeof assistantTranscriptSchema>;
export type LoopCheckpoint = z.infer<typeof checkpointSchema>;
export type PiConnection = z.infer<typeof piConnectionSchema>;
export type ModelRequestContract = z.infer<typeof modelRequestSchema>;
export type ModelResponseContract = z.infer<typeof modelResponseSchema>;
export type ModelEventContract = z.infer<typeof modelEventSchema>;
