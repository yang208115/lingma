import {
  checkpointSchema,
  type Json,
  type LoopCheckpoint,
  type ModelCall,
  modelRequestSchema,
  modelResponseSchema,
  type TranscriptMessage,
  transcriptMessageSchema,
} from '@lingma/shared';
import { AgentError } from './errors.js';
import { canonical } from './json.js';
import type { ModelRequest } from './model/types.js';

export function validateResponse(raw: unknown) {
  const parsed = modelResponseSchema.safeParse(raw);
  if (!parsed.success) throw new AgentError('MODEL_PROTOCOL_ERROR');
  const response = parsed.data;
  if (
    response.text !== response.transcriptMessage.content ||
    canonical(response.calls) !== canonical(response.transcriptMessage.toolCalls) ||
    new Set(response.calls.map((call) => call.id)).size !== response.calls.length ||
    (response.stop === 'complete' && response.calls.length !== 0) ||
    (response.stop === 'tool_calls' && response.calls.length === 0) ||
    ((response.stop === 'complete' || response.stop === 'tool_calls') && response.errorCode)
  )
    throw new AgentError('MODEL_PROTOCOL_ERROR');
  return response;
}
export function validateHistory(raw: readonly unknown[]): TranscriptMessage[] {
  const history = raw.map((item) => transcriptMessageSchema.parse(item));
  let pending: ModelCall[] = [];
  const seen = new Set<string>();
  for (const message of history) {
    if (message.role === 'toolResult') {
      const call = pending.shift();
      if (
        !call ||
        call.id !== message.toolCallId ||
        call.name !== message.toolName ||
        message.result.callId !== call.id
      )
        throw new AgentError('MODEL_PROTOCOL_ERROR');
    } else {
      if (pending.length) throw new AgentError('MODEL_PROTOCOL_ERROR');
      if (message.role === 'assistant') {
        for (const call of message.toolCalls) {
          if (seen.has(call.id)) throw new AgentError('MODEL_PROTOCOL_ERROR');
          seen.add(call.id);
        }
        pending = [...message.toolCalls];
      }
    }
  }
  if (pending.length) throw new AgentError('MODEL_PROTOCOL_ERROR');
  return history;
}
export function publicRequest(raw: ModelRequest): ModelRequest {
  const request = modelRequestSchema.safeParse(raw);
  if (!request.success) throw new AgentError('VALIDATION_ERROR');
  const check = (value: Json): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) check(item);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(api[-_]?key|authorization|password|access[-_]?token|refresh[-_]?token|secret|headers)$/i.test(
          key,
        )
      )
        throw new AgentError('VALIDATION_ERROR');
      check(item);
    }
  };
  check(request.data.connectionSnapshot);
  check(request.data.parameters);
  validateHistory(request.data.messages);
  return request.data;
}
export function validateCheckpoint(
  raw: LoopCheckpoint,
  input: ModelRequest,
  adapterId: string,
): LoopCheckpoint {
  const parsed = checkpointSchema.safeParse(raw);
  if (!parsed.success) throw new AgentError('MODEL_PROTOCOL_ERROR');
  const checkpoint = parsed.data;
  if (
    checkpoint.adapterId !== adapterId ||
    canonical(checkpoint.initialRequest) !== canonical(input) ||
    checkpoint.nextTurnIndex !== checkpoint.lastTurn.turnIndex + 1 ||
    canonical(checkpoint.messages.slice(0, input.messages.length)) !== canonical(input.messages)
  )
    throw new AgentError('MODEL_PROTOCOL_ERROR');
  validateHistory(checkpoint.messages);
  const additions = checkpoint.messages.slice(input.messages.length);
  const rounds = additions.filter((message) => message.role === 'assistant');
  if (
    additions.some((message) => message.role === 'user') ||
    rounds.length !== checkpoint.nextTurnIndex ||
    rounds.slice(0, -1).some((message) => message.toolCalls.length === 0)
  )
    throw new AgentError('MODEL_PROTOCOL_ERROR');
  for (const message of checkpoint.messages)
    if (message.role === 'assistant' && message.protocol && message.protocol.adapter !== adapterId)
      throw new AgentError('MODEL_PROTOCOL_ERROR');
  const response = validateResponse(checkpoint.lastTurn.response);
  if (
    !['complete', 'tool_calls'].includes(response.stop) ||
    checkpoint.lastTurn.results.length !== response.calls.length
  )
    throw new AgentError('MODEL_PROTOCOL_ERROR');
  const tail = checkpoint.messages.slice(-(response.calls.length + 1));
  if (canonical(tail[0]) !== canonical(response.transcriptMessage))
    throw new AgentError('MODEL_PROTOCOL_ERROR');
  for (const [index, call] of response.calls.entries()) {
    const result = checkpoint.lastTurn.results[index];
    const message = tail[index + 1];
    if (
      result?.callId !== call.id ||
      message?.role !== 'toolResult' ||
      message.toolCallId !== call.id ||
      message.toolName !== call.name ||
      canonical(message.result) !== canonical(result)
    )
      throw new AgentError('MODEL_PROTOCOL_ERROR');
  }
  return structuredClone(checkpoint);
}

export function validateNewCalls(
  history: readonly TranscriptMessage[],
  calls: readonly ModelCall[],
): void {
  const seen = new Set(
    history.flatMap((message) =>
      message.role === 'assistant' ? message.toolCalls.map((call) => call.id) : [],
    ),
  );
  for (const call of calls) {
    if (seen.has(call.id)) throw new AgentError('MODEL_PROTOCOL_ERROR');
    seen.add(call.id);
  }
}
