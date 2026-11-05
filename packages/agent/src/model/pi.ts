import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import {
  assistantTranscriptSchema,
  type ErrorCode,
  type Json,
  type ModelCall,
  type PiConnection,
  piConnectionSchema,
  piParametersSchema,
  type Usage,
} from '@lingma/shared';
import { AgentError } from '../errors.js';
import { canonical, json } from '../json.js';
import { addDecimal, priceTokens } from '../usage.js';
import type { ModelAdapter, ModelEvent, ModelRequest, ModelResponse } from './types.js';

export const PI_ADAPTER_ID = 'pi-ai/1.5.0';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const money = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
function checkedNative(value: unknown, model: Model<Api>): AssistantMessage {
  if (
    !record(value) ||
    value.role !== 'assistant' ||
    !Array.isArray(value.content) ||
    value.api !== model.api ||
    value.provider !== model.provider ||
    value.model !== model.id ||
    !count(value.timestamp) ||
    !['stop', 'toolUse', 'length', 'error', 'aborted'].includes(String(value.stopReason)) ||
    !record(value.usage)
  )
    throw new AgentError('MODEL_PROTOCOL_ERROR');
  for (const block of value.content) {
    if (!record(block)) throw new AgentError('MODEL_PROTOCOL_ERROR');
    for (const key of [
      'textSignature',
      'thinkingSignature',
      'thoughtSignature',
      'namespace',
      'argumentsError',
    ]) {
      if (block[key] !== undefined && typeof block[key] !== 'string')
        throw new AgentError('MODEL_PROTOCOL_ERROR');
    }
    if (block.redacted !== undefined && typeof block.redacted !== 'boolean')
      throw new AgentError('MODEL_PROTOCOL_ERROR');
    if (block.type === 'text' && typeof block.text === 'string') continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') continue;
    if (
      block.type === 'toolCall' &&
      typeof block.id === 'string' &&
      block.id &&
      typeof block.name === 'string' &&
      block.name &&
      record(block.arguments)
    ) {
      json(block.arguments);
      continue;
    }
    throw new AgentError('MODEL_PROTOCOL_ERROR');
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'])
    if (!count(value.usage[key])) throw new AgentError('MODEL_PROTOCOL_ERROR');
  const cost = value.usage.cost;
  if (
    !record(cost) ||
    !['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every((key) => money(cost[key]))
  )
    throw new AgentError('MODEL_PROTOCOL_ERROR');
  return value as unknown as AssistantMessage;
}
function extract(message: AssistantMessage): {
  text: string;
  thinking: string;
  calls: ModelCall[];
} {
  return {
    text: message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(''),
    thinking: message.content
      .filter((block) => block.type === 'thinking' && !block.redacted)
      .map((block) => (block.type === 'thinking' ? block.thinking : ''))
      .join(''),
    calls: message.content
      .filter((block) => block.type === 'toolCall')
      .map((call) => ({ id: call.id, name: call.name, arguments: json(call.arguments) })),
  };
}
/** JSON serialization strips SDK optional undefined fields; diagnostic stacks and raw errors are never persisted. */
function protocolMessage(message: AssistantMessage, errorCode?: ErrorCode): Json {
  const { diagnostics: _diagnostics, errorMessage: _error, ...rest } = message;
  return json(
    JSON.parse(JSON.stringify({ ...rest, ...(errorCode ? { errorMessage: errorCode } : {}) })),
  );
}
function decimalFromNumber(value: number): string {
  const text = value.toString();
  if (!/[eE]/.test(text)) return text;
  const [digits = '0', exponent = '0'] = text.toLowerCase().split('e');
  const [whole = '', fraction = ''] = digits.split('.');
  const point = whole.length + Number(exponent);
  const all = whole + fraction;
  return point <= 0
    ? `0.${'0'.repeat(-point)}${all}`
    : point >= all.length
      ? all + '0'.repeat(point - all.length)
      : `${all.slice(0, point)}.${all.slice(point)}`;
}
export function normalizePiUsage(message: AssistantMessage, connection: PiConnection): Usage {
  const raw = message.usage;
  // pi-ai fills missing token fields with zero; without presence evidence, zero stays unknown.
  const input = raw.input + raw.cacheRead + raw.cacheWrite;
  if (!Number.isSafeInteger(input)) throw new AgentError('MODEL_PROTOCOL_ERROR');
  let cost: Usage['cost'] = null;
  if (raw.cost.totalFromProvider === true)
    cost = { amount: decimalFromNumber(raw.cost.total), currency: 'USD', source: 'provider' };
  else if (input > 0 && raw.output > 0 && connection.pricing) {
    let amount = '0';
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
      amount = addDecimal(amount, priceTokens(raw[key], connection.pricing[key]));
    cost = { amount, currency: 'USD', source: 'estimate' };
  }
  return {
    inputTokens: input > 0 ? input : null,
    outputTokens: raw.output > 0 ? raw.output : null,
    cost,
  };
}
export function classifyPiError(status?: number, error?: unknown): ErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_ERROR';
  if (status === 429) return 'PROVIDER_RATE_LIMIT';
  if (status === 408 || (error instanceof Error && /timeout|timed out/i.test(error.name)))
    return 'MODEL_TIMEOUT';
  if (error instanceof AgentError) return error.code;
  return 'PROVIDER_UNAVAILABLE';
}
export interface PiAdapterOptions {
  resolveCredential(reference: string, signal: AbortSignal): string | Promise<string>;
  /** Injection supports local protocol tests; production can enforce its own outbound network policy. */
  fetch?: typeof globalThis.fetch;
}
function checkedConfiguration(request: ModelRequest) {
  const config = piConnectionSchema.safeParse(request.connectionSnapshot);
  const params = piParametersSchema.safeParse(request.parameters);
  if (!config.success || !params.success) throw new AgentError('VALIDATION_ERROR');
  const connection = config.data;
  if (params.data.maxTokens && params.data.maxTokens > connection.maxOutputTokens)
    throw new AgentError('VALIDATION_ERROR');
  return { connection, parameters: params.data };
}
export class PiModelAdapter implements ModelAdapter {
  readonly id = PI_ADAPTER_ID;
  constructor(private readonly options: PiAdapterOptions) {}
  validateRequest(request: ModelRequest): void {
    checkedConfiguration(request);
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    const { connection, parameters } = checkedConfiguration(request);
    const model: Model<Api> = {
      id: request.modelId,
      name: request.modelId,
      api: connection.api,
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: connection.reasoning,
      contextWindow: connection.contextWindow,
      maxTokens: connection.maxOutputTokens,
    };
    const messages: Message[] = request.messages.map((message) => {
      if (message.role === 'user') return { ...message };
      if (message.role === 'toolResult')
        return {
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: [{ type: 'text', text: JSON.stringify(message.result) }],
          isError: !message.result.ok,
          timestamp: message.timestamp,
        };
      const wrapper = assistantTranscriptSchema.parse(message);
      if (wrapper.protocol?.adapter !== this.id) throw new AgentError('MODEL_PROTOCOL_ERROR');
      const original = checkedNative(wrapper.protocol.message, model);
      const { text, calls } = extract(original);
      if (wrapper.content !== text || canonical(wrapper.toolCalls) !== canonical(calls))
        throw new AgentError('MODEL_PROTOCOL_ERROR');
      return original;
    });
    const tools = request.toolDefinitions.map((definition) => {
      if (
        !record(definition) ||
        typeof definition.name !== 'string' ||
        typeof definition.description !== 'string' ||
        !record(definition.parameters)
      )
        throw new AgentError('VALIDATION_ERROR');
      return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      };
    });
    let apiKey: string;
    try {
      if (connection.credentialRef)
        apiKey = await this.options.resolveCredential(connection.credentialRef, signal);
      else if (['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.baseUrl).hostname))
        apiKey = 'lingma-keyless-local';
      else throw new AgentError('PROVIDER_AUTH_ERROR');
      if (!apiKey) throw new AgentError('PROVIDER_AUTH_ERROR');
    } catch {
      throw new AgentError('PROVIDER_AUTH_ERROR');
    }
    signal.throwIfAborted();
    let status: number | undefined;
    try {
      type Invoke = (
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions,
      ) => AsyncIterable<import('@earendil-works/pi-ai').AssistantMessageEvent>;
      let stream: Invoke;
      if (connection.api === 'openai-completions') {
        const api = await import('@earendil-works/pi-ai/api/openai-completions');
        stream = (model, context, options) =>
          api.streamSimple(model as Model<'openai-completions'>, context, options);
      } else if (connection.api === 'openai-responses') {
        const api = await import('@earendil-works/pi-ai/api/openai-responses');
        stream = (model, context, options) =>
          api.streamSimple(model as Model<'openai-responses'>, context, options);
      } else {
        const api = await import('@earendil-works/pi-ai/api/anthropic-messages');
        stream = (model, context, options) =>
          api.streamSimple(model as Model<'anthropic-messages'>, context, options);
      }
      signal.throwIfAborted();
      const source = stream(
        model,
        normalizeContext({ systemPrompt: request.systemPrompt, messages, tools }),
        {
          signal,
          apiKey,
          maxRetries: 0,
          transport: 'sse',
          maxTokens: parameters.maxTokens ?? connection.maxOutputTokens,
          ...(connection.reasoning ? { reasoning: 'medium' as const } : {}),
          ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature }),
          fetch: async (url, init) => {
            const response = await (this.options.fetch ?? globalThis.fetch)(url, {
              ...init,
              redirect: 'error',
            });
            status = response.status;
            return response;
          },
          onResponse: (response) => {
            status = response.status;
          },
        },
      );
      let started = false;
      let ended = false;
      for await (const event of source) {
        signal.throwIfAborted();
        if (ended) throw new AgentError('MODEL_PROTOCOL_ERROR');
        if (event.type === 'start') {
          if (started) throw new AgentError('MODEL_PROTOCOL_ERROR');
          started = true;
        } else if (event.type === 'text_delta') {
          if (!started) throw new AgentError('MODEL_PROTOCOL_ERROR');
          yield { type: 'text_delta', text: event.delta };
        } else if (event.type === 'thinking_delta') {
          if (!started) throw new AgentError('MODEL_PROTOCOL_ERROR');
          const block = event.partial.content[event.contentIndex];
          if (block?.type === 'thinking' && !block.redacted)
            yield { type: 'thinking_delta', text: event.delta };
        } else if (event.type === 'toolcall_delta') {
          if (!started) throw new AgentError('MODEL_PROTOCOL_ERROR');
          const callIndex =
            event.partial.content
              .slice(0, event.contentIndex + 1)
              .filter((block) => block.type === 'toolCall').length - 1;
          if (callIndex < 0) throw new AgentError('MODEL_PROTOCOL_ERROR');
          yield { type: 'tool_call_delta', callIndex, delta: event.delta };
        } else if (event.type === 'done' || event.type === 'error') {
          if (event.type === 'done' && !started) throw new AgentError('MODEL_PROTOCOL_ERROR');
          const raw = checkedNative(event.type === 'done' ? event.message : event.error, model);
          if (event.reason !== raw.stopReason) throw new AgentError('MODEL_PROTOCOL_ERROR');
          const { text, thinking, calls } = extract(raw);
          let code: ErrorCode | undefined;
          if (raw.content.some((block) => block.type === 'toolCall' && block.argumentsError))
            code = 'MODEL_PROTOCOL_ERROR';
          else if (isContextOverflow(raw, connection.contextWindow)) code = 'CONTEXT_TOO_LARGE';
          else if (event.type === 'error' && event.reason !== 'aborted')
            code = classifyPiError(status);
          const stop: ModelResponse['stop'] = code
            ? 'error'
            : raw.stopReason === 'stop'
              ? 'complete'
              : raw.stopReason === 'toolUse'
                ? 'tool_calls'
                : raw.stopReason === 'length'
                  ? 'truncated'
                  : raw.stopReason === 'aborted'
                    ? 'aborted'
                    : 'error';
          const response: ModelResponse = {
            transcriptMessage: {
              role: 'assistant',
              content: text,
              toolCalls: calls,
              protocol: { adapter: this.id, message: protocolMessage(raw, code) },
            },
            text,
            thinking,
            calls,
            stop,
            usage: normalizePiUsage(raw, connection),
            ...(code ? { errorCode: code } : {}),
          };
          ended = true;
          yield { type: 'response', response };
        }
      }
      if (!ended) throw new AgentError('MODEL_PROTOCOL_ERROR');
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new AgentError(classifyPiError(status, error));
    }
  }
}
