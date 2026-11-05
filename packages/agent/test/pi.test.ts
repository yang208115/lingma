import type { Json, PiConnection } from '@lingma/shared';
import { expect, it, vi } from 'vitest';
import {
  ActionRegistry,
  MemoryLoopRecorder,
  type ModelRequest,
  PiModelAdapter,
  runLoop,
} from '../src/index.js';
import { addDecimal, priceTokens, UsageAccumulator } from '../src/usage.js';

const documentId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';
const secret = 'synthetic-test-credential-never-persist';
const connection = (api: PiConnection['api'] = 'openai-completions'): PiConnection => ({
  api,
  provider: 'fixture',
  baseUrl: 'https://provider.invalid/v1',
  credentialRef: 'fixture-credential',
  contextWindow: 16000,
  maxOutputTokens: 1024,
  reasoning: false,
  pricing: null,
});
const input = (api: PiConnection['api'] = 'openai-completions'): ModelRequest => ({
  connectionSnapshot: connection(api) as unknown as Json,
  modelId: 'fixture-model',
  systemPrompt: '合成协议测试',
  messages: [{ role: 'user', content: '检查资料', timestamp: 1 }],
  toolDefinitions: [],
  parameters: {},
});
function sse(events: unknown[], named = false): Response {
  return new Response(
    events
      .map(
        (event) =>
          `${named ? `event: ${(event as { type: string }).type}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
      )
      .join('') + (named ? '' : 'data: [DONE]\n\n'),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
const completion = (delta: unknown, finish: string | null = null) => ({
  id: 'response-fixture',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fixture-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const usageChunk = {
  id: 'response-fixture',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fixture-model',
  choices: [],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    prompt_tokens_details: { cached_tokens: 3 },
  },
};
const readResult = () => ({
  documentId,
  versionId,
  citationId: 'doc:fixture',
  contentHash: 'a'.repeat(64),
  excerpt: '林舟惯用左手',
  from: 0,
  to: 7,
  truncated: false,
});
function exercise(
  fetcher: typeof fetch,
  request = input(),
  registry = new ActionRegistry({ read_document: readResult }),
) {
  const resolver = vi.fn(() => secret);
  const adapter = new PiModelAdapter({ resolveCredential: resolver, fetch: fetcher });
  const recorder = new MemoryLoopRecorder();
  const run = () =>
    runLoop({
      runId: crypto.randomUUID(),
      request,
      registry,
      adapter,
      recorder,
      signal: new AbortController().signal,
    });
  return { run, adapter, recorder, resolver };
}

it('uses the real pinned SDK to stream completions, replay assistant/tool IDs and preserve known usage', async () => {
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${secret}`);
    requests.push(JSON.parse(String(options?.body)));
    if (requests.length === 1)
      return sse([
        completion({ role: 'assistant', content: '读取资料' }),
        completion({
          tool_calls: [
            {
              index: 0,
              id: 'call-read',
              type: 'function',
              function: { name: 'read_document', arguments: '{"documentId":' },
            },
          ],
        }),
        completion({
          tool_calls: [
            { index: 0, function: { arguments: `"${documentId}","versionId":"${versionId}"}` } },
          ],
        }),
        completion({}, 'tool_calls'),
        usageChunk,
      ]);
    return sse([
      completion({ role: 'assistant', content: '候选存在矛盾' }),
      completion({}, 'stop'),
      usageChunk,
    ]);
  };
  const test = exercise(fetcher);
  const result = await test.run();
  expect(result.status).toBe('completed');
  expect(result.turns).toBe(2);
  expect(requests).toHaveLength(2);
  const messages = requests[1]?.messages as Record<string, unknown>[];
  expect(messages.find((message) => message.role === 'assistant')?.tool_calls).toMatchObject([
    { id: 'call-read', function: { name: 'read_document' } },
  ]);
  const tool = messages.find((message) => message.role === 'tool');
  expect(tool?.tool_call_id).toBe('call-read');
  expect(String(tool?.content)).toContain('林舟');
  expect(result.usage.known).toEqual({ inputTokens: 40, outputTokens: 10, cost: null });
  expect(result.usage.complete).toBe(false);
  expect(test.recorder.events.some((event) => event.type === 'tool.arguments.delta')).toBe(true);
  expect(JSON.stringify(test.recorder)).not.toContain(secret);
  const original = test.recorder.turns[0]?.checkpoint.lastTurn.response.transcriptMessage.protocol
    ?.message as Record<string, unknown>;
  expect(original.role).toBe('assistant');
  expect(original.responseId).toBe('response-fixture');
});

it.each([
  [401, 'PROVIDER_AUTH_ERROR'],
  [403, 'PROVIDER_AUTH_ERROR'],
  [429, 'PROVIDER_RATE_LIMIT'],
  [500, 'PROVIDER_UNAVAILABLE'],
  [408, 'MODEL_TIMEOUT'],
])(
  'classifies HTTP %s without retrying or persisting credential-bearing error text',
  async (status, reason) => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { message: `failure with ${secret}`, type: 'request_error' } }),
        { status: Number(status), headers: { 'Content-Type': 'application/json' } },
      );
    };
    const test = exercise(fetcher);
    const result = await test.run();
    expect(result.stopReason).toBe(reason);
    expect(result.status).toBe('failed');
    expect(calls).toBe(1);
    expect(result.usage.known.inputTokens).toBeNull();
    expect(JSON.stringify(test.recorder)).not.toContain(secret);
  },
);

it('classifies provider context overflow instead of retrying the same input', async () => {
  const test = exercise(
    async () =>
      new Response(JSON.stringify({ error: { message: 'maximum context length exceeded' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  expect((await test.run()).stopReason).toBe('CONTEXT_TOO_LARGE');
});

it.each(['stop', 'length', 'missing finish', 'invalid arguments'])(
  'maps %s with unknown usage conservatively and never executes incomplete calls',
  async (kind) => {
    const handler = vi.fn(readResult);
    const fetcher: typeof fetch = async () =>
      sse([
        completion({ role: 'assistant', content: '部分候选' }),
        ...(kind === 'invalid arguments'
          ? [
              completion({
                tool_calls: [
                  {
                    index: 0,
                    id: 'bad',
                    type: 'function',
                    function: { name: 'read_document', arguments: '{' },
                  },
                ],
              }),
            ]
          : []),
        ...(kind === 'missing finish'
          ? []
          : [
              completion(
                {},
                kind === 'length' ? 'length' : kind === 'invalid arguments' ? 'tool_calls' : 'stop',
              ),
            ]),
        ...(kind === 'invalid arguments' ? [usageChunk] : []),
      ]);
    const test = exercise(fetcher, input(), new ActionRegistry({ read_document: handler }));
    const result = await test.run();
    expect(result.stopReason).toBe(
      kind === 'stop'
        ? 'complete'
        : kind === 'length'
          ? 'OUTPUT_TRUNCATED'
          : kind === 'invalid arguments'
            ? 'MODEL_PROTOCOL_ERROR'
            : 'PROVIDER_UNAVAILABLE',
    );
    expect(result.output?.text).toBe('部分候选');
    expect(result.usage.known).toEqual({
      inputTokens: kind === 'invalid arguments' ? 20 : null,
      outputTokens: kind === 'invalid arguments' ? 5 : null,
      cost: null,
    });
    expect(handler).not.toHaveBeenCalled();
  },
);

it('streams completion reasoning separately from prose without exposing it as final text', async () => {
  const test = exercise(async () =>
    sse([
      completion({ role: 'assistant', reasoning_content: '先核对' }),
      completion({ reasoning_content: '人物资料。' }),
      completion({ content: '小说正文' }),
      completion({}, 'stop'),
      usageChunk,
    ]),
  );
  const result = await test.run();
  expect(result.status).toBe('completed');
  expect(result.output?.text).toBe('小说正文');
  expect(test.recorder.events.filter((event) => event.type === 'thinking.delta')).toMatchObject([
    { turnIndex: 0, text: '先核对' },
    { turnIndex: 0, text: '人物资料。' },
  ]);
  expect(test.recorder.turns[0]?.response.thinking).toBe('先核对人物资料。');
});

it('maps Responses reasoning/text signatures and namespace/call IDs into a replayable snapshot', async () => {
  let calls = 0;
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)));
    calls++;
    if (calls === 1) {
      const reasoning = {
        id: 'reason-1',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '比较事实' }],
        encrypted_content: 'opaque-signature',
      };
      const tool = {
        id: 'fc-1',
        type: 'function_call',
        call_id: 'call-responses',
        name: 'read_document',
        arguments: JSON.stringify({ documentId, versionId }),
        status: 'completed',
      };
      return sse(
        [
          { type: 'response.created', response: { id: 'response-1' } },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...reasoning, summary: [] },
          },
          { type: 'response.output_item.done', output_index: 0, item: reasoning },
          { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 1,
            item_id: 'fc-1',
            delta: tool.arguments,
          },
          { type: 'response.output_item.done', output_index: 1, item: tool },
          {
            type: 'response.completed',
            response: {
              id: 'response-1',
              status: 'completed',
              model: 'fixture-model',
              output: [reasoning, tool],
              usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
            },
          },
        ],
        true,
      );
    }
    const text = {
      id: 'msg-2',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '最终候选', annotations: [] }],
    };
    return sse(
      [
        { type: 'response.created', response: { id: 'response-2' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...text, content: [] } },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'msg-2',
          content_index: 0,
          delta: '最终候选',
        },
        { type: 'response.output_item.done', output_index: 0, item: text },
        {
          type: 'response.completed',
          response: {
            id: 'response-2',
            status: 'completed',
            model: 'fixture-model',
            output: [text],
            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
          },
        },
      ],
      true,
    );
  };
  const request = input('openai-responses');
  request.connectionSnapshot = { ...connection('openai-responses'), reasoning: true };
  const test = exercise(fetcher, request);
  const result = await test.run();
  expect(result.status).toBe('completed');
  expect(result.output?.text).toBe('最终候选');
  expect(calls).toBe(2);
  expect(requests[0]?.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
  expect(JSON.stringify(requests[1]?.input)).toContain('opaque-signature');
  expect(JSON.stringify(requests[1]?.input)).toContain('call-responses');
  expect(JSON.stringify(test.recorder.turns[0]?.checkpoint)).toContain('thinkingSignature');
  expect(test.recorder.turns[0]?.response.thinking).toBe('比较事实');
  expect(JSON.stringify(test.recorder.turns[1]?.checkpoint)).toContain('textSignature');
});

it('uses real Anthropic SDK events and preserves thinking/tool signatures across rounds', async () => {
  let calls = 0;
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    expect(new Headers(options?.headers).get('x-api-key')).toBe(secret);
    requests.push(JSON.parse(String(options?.body)));
    calls++;
    const start = {
      type: 'message_start',
      message: {
        id: `msg-${calls}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 3 },
      },
    };
    const events: unknown[] = [start];
    if (calls === 1)
      events.push(
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '内部比较' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'thinking-signature' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'anthropic-call',
            name: 'read_document',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ documentId, versionId }),
          },
        },
        { type: 'content_block_stop', index: 1 },
      );
    else
      events.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '审查候选' } },
        { type: 'content_block_stop', index: 0 },
      );
    events.push(
      {
        type: 'message_delta',
        delta: { stop_reason: calls === 1 ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    );
    return sse(events, true);
  };
  const request = input('anthropic-messages');
  request.connectionSnapshot = { ...connection('anthropic-messages'), reasoning: true };
  const test = exercise(fetcher, request);
  const result = await test.run();
  expect(result.status).toBe('completed');
  expect(result.output?.text).toBe('审查候选');
  expect(calls).toBe(2);
  expect(requests[0]?.thinking).toMatchObject({ type: 'enabled' });
  expect(JSON.stringify(requests[1]?.messages)).toContain('thinking-signature');
  expect(JSON.stringify(requests[1]?.messages)).toContain('anthropic-call');
  expect(result.usage.known.inputTokens).toBe(46);
  expect(test.recorder.events.filter((event) => event.type === 'thinking.delta')).toMatchObject([
    { turnIndex: 0, text: '内部比较' },
  ]);
  expect(test.recorder.turns[0]?.response.thinking).toBe('内部比较');
});

it('rejects foreign protocol snapshots, unknown parameters and missing public credentials before transport', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return sse([]);
  };
  const bad = input();
  bad.parameters = { maxRetries: 2 };
  await expect(exercise(fetcher, bad).run()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  const missing = input();
  missing.connectionSnapshot = { ...connection(), credentialRef: null };
  expect((await exercise(fetcher, missing).run()).stopReason).toBe('PROVIDER_AUTH_ERROR');
  const foreign = input();
  foreign.messages.push({ role: 'assistant', content: 'old text', toolCalls: [] });
  expect((await exercise(fetcher, foreign).run()).stopReason).toBe('MODEL_PROTOCOL_ERROR');
  expect(calls).toBe(0);
});

it.each(['userinfo', 'query', 'fragment'])(
  'rejects a secret-bearing connection %s before any recorder write',
  async (kind) => {
    const request = input();
    request.connectionSnapshot = {
      ...connection(),
      baseUrl:
        kind === 'userinfo'
          ? `https://user:${secret}@provider.invalid/v1`
          : `https://provider.invalid/v1${kind === 'query' ? '?' : '#'}key=${secret}`,
    };
    const fetcher = vi.fn<typeof fetch>();
    const test = exercise(fetcher, request);
    await expect(test.run()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(test.recorder.records).toHaveLength(0);
    expect(test.recorder.terminal).toBeNull();
    expect(test.resolver).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it('calculates decimal estimates exactly, separates currencies, and retains known costs after a failed call', async () => {
  expect(addDecimal('0.1', '0.2')).toBe('0.3');
  expect(addDecimal('100.00', '0.000')).toBe('100');
  expect(priceTokens(20, '1.25')).toBe('0.000025');
  const stats = new UsageAccumulator();
  const first = stats.begin();
  stats.set(first, {
    inputTokens: 20,
    outputTokens: 5,
    cost: { amount: '0.1', currency: 'USD', source: 'provider' },
  });
  const second = stats.begin();
  stats.set(second, {
    inputTokens: null,
    outputTokens: 2,
    cost: { amount: '0.2', currency: 'USD', source: 'estimate' },
  });
  stats.begin();
  expect(stats.summary()).toMatchObject({
    known: {
      inputTokens: 20,
      outputTokens: 7,
      cost: { amount: '0.3', currency: 'USD', source: 'estimate' },
    },
    complete: false,
    byCurrency: [{ mixedSources: true }],
  });
  const fourth = stats.begin();
  stats.set(fourth, {
    inputTokens: 10,
    outputTokens: 0,
    cost: { amount: '2', currency: 'CNY', source: 'provider' },
  });
  expect(stats.summary().known.cost).toBeNull();
  expect(stats.summary().byCurrency.map((item) => item.currency)).toEqual(['CNY', 'USD']);
  const request = input();
  request.connectionSnapshot = {
    ...connection(),
    pricing: { input: '1', output: '2', cacheRead: '0.5', cacheWrite: '1' },
  };
  const test = exercise(
    async () =>
      sse([completion({ role: 'assistant', content: '候选' }), completion({}, 'stop'), usageChunk]),
    request,
  );
  const result = await test.run();
  expect(result.usage.known.cost).toEqual({
    amount: '0.0000285',
    currency: 'USD',
    source: 'estimate',
  });
});

it('preserves explicit provider billing, expands scientific decimals and leaves absent zero token counts unknown', async () => {
  const request = input();
  request.connectionSnapshot = { ...connection(), provider: 'openrouter' };
  const usage = {
    ...usageChunk,
    usage: {
      ...usageChunk.usage,
      cost: 1e-8,
      is_byok: false,
      completion_tokens: 0,
      total_tokens: 20,
    },
  };
  const test = exercise(
    async () =>
      sse([completion({ role: 'assistant', content: '候选' }), completion({}, 'stop'), usage]),
    request,
  );
  const result = await test.run();
  expect(result.status).toBe('completed');
  expect(result.usage.known).toEqual({
    inputTokens: 20,
    outputTokens: null,
    cost: { amount: '0.00000001', currency: 'USD', source: 'provider' },
  });
  expect(result.usage.complete).toBe(false);
});

it('retains partial Anthropic usage when a streamed request fails before output usage is known', async () => {
  const test = exercise(
    async () =>
      sse(
        [
          {
            type: 'message_start',
            message: {
              id: 'partial',
              type: 'message',
              role: 'assistant',
              model: 'fixture-model',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 19, output_tokens: 0 },
            },
          },
          {
            type: 'error',
            error: { type: 'overloaded_error', message: 'synthetic stream failure' },
          },
        ],
        true,
      ),
    input('anthropic-messages'),
  );
  const result = await test.run();
  expect(result.status).toBe('failed');
  expect(result.usage.known.inputTokens).toBe(19);
  expect(result.usage.known.outputTokens).toBeNull();
  expect(result.usage.complete).toBe(false);
});
