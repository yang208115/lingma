import { readFile } from 'node:fs/promises';
import {
  type ActionArgs,
  type Json,
  type LoopCheckpoint,
  type ModelCall,
  modelEventSchema,
  runEventSchema,
  type Usage,
} from '@lingma/shared';
import { afterEach, expect, it, vi } from 'vitest';
import {
  type ActionContext,
  ActionRegistry,
  AgentError,
  FakeModelAdapter,
  type LoopInput,
  MemoryLoopRecorder,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  runLoop,
} from '../src/index.js';

const runId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';
const unknownUsage: Usage = { inputTokens: null, outputTokens: null, cost: null };
const request = (): ModelRequest => ({
  connectionSnapshot: {},
  modelId: 'fake',
  systemPrompt: '只读合成资料',
  messages: [{ role: 'user', content: '检查惯用手', timestamp: 1 }],
  toolDefinitions: [],
  parameters: {},
});
const call = (
  id = 'read-1',
  name = 'read_document',
  args: Json = { documentId, versionId },
): ModelCall => ({ id, name, arguments: args });
function answer(
  text = '候选',
  calls: ModelCall[] = [],
  stop: 'complete' | 'tool_calls' | 'truncated' | 'error' | 'aborted' = calls.length
    ? 'tool_calls'
    : 'complete',
  usage: Usage = unknownUsage,
): ModelEvent {
  return {
    type: 'response',
    response: {
      transcriptMessage: { role: 'assistant', content: text, toolCalls: calls },
      text,
      calls,
      stop,
      usage,
    },
  };
}
const handlers = () => ({
  read_document: (args: ActionArgs<'read_document'>) => ({
    documentId: args.documentId,
    versionId: args.versionId,
    citationId: 'doc:fixture',
    contentHash: 'a'.repeat(64),
    excerpt: '林舟惯用左手。',
    from: 0,
    to: 8,
    truncated: false,
  }),
});
function setup(turns: (readonly ModelEvent[] | Error)[], overrides: Partial<LoopInput> = {}) {
  const recorder = new MemoryLoopRecorder();
  const adapter = new FakeModelAdapter(turns);
  const input: LoopInput = {
    runId,
    request: request(),
    registry: new ActionRegistry(handlers()),
    adapter,
    recorder,
    signal: new AbortController().signal,
    ...overrides,
  };
  return { input, adapter, recorder, run: () => runLoop(input) };
}
afterEach(() => vi.useRealTimers());

it('preserves thinking streams without an application character cap', async () => {
  const thinking = '想'.repeat(1_000_001);
  const { run, recorder } = setup([[{ type: 'thinking_delta', text: thinking }, answer('正文')]]);
  const result = await run();
  expect(result.status).toBe('completed');
  expect(result.output?.text).toBe('正文');
  expect(recorder.events.filter((event) => event.type === 'thinking.delta')).toMatchObject([
    { text: thinking },
  ]);
});

it('executes the fixture read then answer as two complete turns with replayable matching results', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('../../../fixtures/model/continuity.json', import.meta.url), 'utf8'),
  ) as unknown[][];
  const { run, adapter, recorder } = setup(
    fixture.map((turn) => turn.map((item) => modelEventSchema.parse(item))),
  );
  const result = await run();
  expect(result.status).toBe('completed');
  expect(result.turns).toBe(2);
  expect(adapter.requests).toHaveLength(2);
  expect(adapter.requests[1]?.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'toolResult',
  ]);
  expect(recorder.turns[0]?.results[0]?.callId).toBe('call-read-1');
  expect(result.output?.committed).toBe(true);
  expect(result.output?.text).toContain('惯用手');
  expect(result.checkpoint?.nextTurnIndex).toBe(2);
  expect(result.usage.known.inputTokens).toBeNull();
  expect(result.usage.complete).toBe(false);
  expect(recorder.events.every((event) => runEventSchema.safeParse(event).success)).toBe(true);
  expect(recorder.events.map((event) => event.seq)).toEqual(
    Array.from({ length: recorder.events.length }, (_, i) => i + 1),
  );
});

it('executes multiple actions sequentially and continues to the final answer', async () => {
  const order: string[] = [];
  const registry = new ActionRegistry({
    read_document: async (args, context) => {
      order.push(`start:${context.executionId}`);
      await Promise.resolve();
      order.push(`end:${context.executionId}`);
      return handlers().read_document(args);
    },
  });
  const { run, adapter, recorder } = setup(
    [[answer('', [call('a'), call('b')])], [answer('完成')]],
    { registry },
  );
  const result = await run();
  expect(result.stopReason).toBe('complete');
  expect(result.status).toBe('completed');
  expect(adapter.requests).toHaveLength(2);
  expect(order).toHaveLength(4);
  expect(order[0]?.slice(6)).toBe(order[1]?.slice(4));
  expect(order[2]?.slice(6)).toBe(order[3]?.slice(4));
  expect(recorder.turns[0]?.results.map((result) => result.callId)).toEqual(['a', 'b']);
});

it('does not execute argument fragments or a final response until the stream fully ends', async () => {
  let executed = false;
  let ended = false;
  const adapter: ModelAdapter = {
    id: 'fake/v1',
    async *stream() {
      yield { type: 'tool_call_delta', callIndex: 0, delta: '{"documentId":' };
      expect(executed).toBe(false);
      yield answer('', [call()]);
      expect(executed).toBe(false);
      ended = true;
    },
  };
  const registry = new ActionRegistry({
    read_document: (args) => {
      expect(ended).toBe(true);
      executed = true;
      return handlers().read_document(args);
    },
  });
  const { run, recorder } = setup([], { adapter, registry });
  await run();
  expect(executed).toBe(true);
  expect(recorder.events.some((event) => event.type === 'tool.arguments.delta')).toBe(true);
});

it.each([
  ['unregistered', 'UNKNOWN_TOOL'],
  ['read_document', 'FORBIDDEN'],
])('returns a correctable result for %s', async (name, code) => {
  const { run, adapter } = setup([[answer('', [call('x', name)])], [answer('改用现有资料')]], {
    registry: new ActionRegistry({}),
  });
  expect((await run()).status).toBe('completed');
  const result = adapter.requests[1]?.messages.at(-1);
  expect(result?.role).toBe('toolResult');
  if (result?.role === 'toolResult')
    expect(result.result).toMatchObject({ callId: 'x', ok: false, error: { code } });
});

it('validates arguments and defaults without rejecting large valid tool results', async () => {
  const seen: unknown[] = [];
  const registry = new ActionRegistry({
    search_documents: (args) => {
      seen.push(args);
      return { matches: [] };
    },
    read_document: (args) => ({
      ...{
        documentId: args.documentId,
        versionId: args.versionId,
        citationId: 'x',
        contentHash: 'a'.repeat(64),
        from: 0,
        to: 8000,
        truncated: false,
        metadata: { note: 'x'.repeat(40_000) },
      },
      excerpt: '文'.repeat(8000),
    }),
  });
  const { run, recorder } = setup(
    [
      [
        answer('', [
          call('bad', 'search_documents', { query: '' }),
          call('ok', 'search_documents', { query: '林舟' }),
          call('big'),
        ]),
      ],
    ],
    { registry },
  );
  await run();
  const results = recorder.turns[0]?.results;
  expect(results?.[0]).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  expect(seen).toEqual([{ query: '林舟', limit: 5 }]);
  expect(results?.[1]?.ok).toBe(true);
  expect(results?.[2]).toMatchObject({
    callId: 'big',
    ok: true,
  });
  expect(JSON.stringify(results?.[2]).length).toBeGreaterThan(32_000);
});

it('continues beyond the former round and tool batch limits until the model finishes', async () => {
  const handler = vi.fn(handlers().read_document);
  const rounds = Array.from({ length: 70 }, (_, turn) => [
    answer(
      '',
      Array.from({ length: turn === 0 ? 40 : 1 }, (_, i) => call(`read-${turn}-${i}`)),
    ),
  ]);
  const { run, recorder } = setup([...rounds, [answer('完成')]], {
    registry: new ActionRegistry({ read_document: handler }),
  });
  const result = await run();
  expect(result.status).toBe('completed');
  expect(result.turns).toBe(71);
  expect(handler).toHaveBeenCalledTimes(109);
  expect(recorder.turns[0]?.results).toHaveLength(40);
});

it('executes valid large argument batches without an aggregate argument budget', async () => {
  const handler = vi.fn(() => ({ matches: [] }));
  const calls = Array.from({ length: 300 }, (_, i) =>
    call(`search-${i}`, 'search_documents', { query: 'x'.repeat(500) }),
  );
  const test = setup([[answer('', calls)], [answer('完成')]], {
    registry: new ActionRegistry({ search_documents: handler }),
  });
  expect((await test.run()).status).toBe('completed');
  expect(handler).toHaveBeenCalledTimes(300);
});

it.each([
  'duplicate',
  'text mismatch',
  'call mismatch',
  'complete with tools',
  'tool stop without calls',
  'unknown stop',
  'double final',
  'event after final',
])('rejects %s without executing a guessed action', async (kind) => {
  const handler = vi.fn(handlers().read_document);
  const good = answer('', [call()]);
  let events: ModelEvent[] = [good];
  if (good.type !== 'response') throw new Error();
  if (kind === 'duplicate') events = [answer('', [call(), call()])];
  if (kind === 'text mismatch') good.response.text = 'not in protocol';
  if (kind === 'call mismatch') good.response.transcriptMessage.toolCalls = [];
  if (kind === 'complete with tools') good.response.stop = 'complete';
  if (kind === 'tool stop without calls') events = [answer('', [], 'tool_calls')];
  if (kind === 'unknown stop')
    events = [{ ...good, response: { ...good.response, stop: 'guess' } } as unknown as ModelEvent];
  if (kind === 'double final') events = [good, good];
  if (kind === 'event after final') events = [good, { type: 'text_delta', text: 'too late' }];
  const { run } = setup([events], { registry: new ActionRegistry({ read_document: handler }) });
  expect((await run()).stopReason).toBe('MODEL_PROTOCOL_ERROR');
  expect(handler).not.toHaveBeenCalled();
});

it('rejects call IDs repeated in later turns while preserving the earlier complete checkpoint', async () => {
  const handler = vi.fn(handlers().read_document);
  const { run } = setup([[answer('', [call()])], [answer('', [call()])]], {
    registry: new ActionRegistry({ read_document: handler }),
  });
  const result = await run();
  expect(result.stopReason).toBe('MODEL_PROTOCOL_ERROR');
  expect(handler).toHaveBeenCalledTimes(1);
  expect(result.checkpoint?.nextTurnIndex).toBe(1);
});

it.each(['missing final', 'disconnect', 'truncated', 'provider error'])(
  'keeps partial output for %s and never executes its calls',
  async (kind) => {
    const handler = vi.fn(handlers().read_document);
    const adapter: ModelAdapter = {
      id: 'failure',
      async *stream() {
        yield { type: 'text_delta', text: '部分候选' };
        if (kind === 'disconnect') throw new Error('private network details');
        if (kind === 'truncated') yield answer('部分候选', [call()], 'truncated');
        if (kind === 'provider error') yield answer('部分候选', [call()], 'error');
      },
    };
    const { run } = setup([], {
      adapter,
      registry: new ActionRegistry({ read_document: handler }),
    });
    const result = await run();
    expect(result.status).toBe(kind === 'truncated' ? 'limited' : 'failed');
    expect(result.output).toMatchObject({ text: '部分候选', committed: false });
    expect(result.checkpoint).toBeNull();
    expect(handler).not.toHaveBeenCalled();
    expect(result.usage.known.inputTokens).toBeNull();
  },
);

it('preserves large streamed text and tool arguments without application truncation', async () => {
  const content = 'x'.repeat(1_000_001);
  const text = setup([[{ type: 'text_delta', text: content }, answer(content)]]);
  const result = await text.run();
  expect(result.status).toBe('completed');
  expect(result.output?.text).toBe(content);
  const args = setup([
    [{ type: 'tool_call_delta', callIndex: 0, delta: 'x'.repeat(128_001) }, answer('', [call()])],
    [answer('完成')],
  ]);
  expect((await args.run()).status).toBe('completed');
  expect(args.recorder.turns[0]?.results[0]?.ok).toBe(true);
});

it('does not invoke the model for pre-cancelled runs and accepts large frozen requests', async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = setup([[answer()]], { signal: controller.signal });
  expect((await cancelled.run()).status).toBe('cancelled');
  expect(cancelled.adapter.requests).toHaveLength(0);
  const big = request();
  big.systemPrompt = 'x'.repeat(4_000_001);
  const test = setup([[answer()]], { request: big, registry: new ActionRegistry({}) });
  expect((await test.run()).status).toBe('completed');
  expect(test.adapter.requests).toHaveLength(1);
});

it('waits for a non-cooperative model without a timer and still cancels immediately', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let started = false;
  let settled = false;
  const adapter: ModelAdapter = {
    id: 'stuck',
    stream() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              started = true;
              return new Promise<IteratorResult<ModelEvent>>(() => {});
            },
            return() {
              return new Promise<IteratorResult<ModelEvent>>(() => {});
            },
          };
        },
      };
    },
  };
  const { run } = setup([], { adapter, signal: controller.signal });
  const pending = run().then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(3_600_001);
  expect(started).toBe(true);
  expect(settled).toBe(false);
  controller.abort();
  expect((await pending).status).toBe('cancelled');
});

it('lets an entered atomic action settle, records it, then cancels before the next action or checkpoint', async () => {
  const controller = new AbortController();
  let release: () => void = () => {};
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const handler = vi.fn(async (args: ActionArgs<'read_document'>, _ctx: ActionContext) => {
    markReady();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return handlers().read_document(args);
  });
  const { run, recorder } = setup([[answer('', [call('a'), call('b')])]], {
    signal: controller.signal,
    registry: new ActionRegistry({ read_document: handler }),
  });
  const pending = run();
  await ready;
  controller.abort();
  release();
  const result = await pending;
  expect(result.status).toBe('cancelled');
  expect(handler).toHaveBeenCalledTimes(1);
  expect(recorder.records.some((record) => record.kind === 'action')).toBe(true);
  expect(recorder.turns).toHaveLength(0);
});

it('persists only complete checkpoints and resumes without repeating completed actions', async () => {
  const handler = vi.fn(handlers().read_document);
  const registry = new ActionRegistry({ read_document: handler });
  const first = setup([[answer('', [call()])], new Error('disconnect')], { registry });
  const failed = await first.run();
  expect(failed.status).toBe('failed');
  expect(failed.checkpoint?.nextTurnIndex).toBe(1);
  const resumed = setup([[answer('恢复后的候选')]], {
    registry,
    checkpoint: failed.checkpoint as LoopCheckpoint,
  });
  const result = await resumed.run();
  expect(result.status).toBe('completed');
  expect(handler).toHaveBeenCalledTimes(1);
  expect(resumed.recorder.turns[0]?.turnIndex).toBe(1);
  expect(resumed.adapter.requests[0]?.messages.at(-1)?.role).toBe('toolResult');
  expect(result.usage.calls).toBe(1);
});

it.each(['adapter', 'input', 'missing assistant', 'wrong next index', 'orphan result'])(
  'rejects an unverifiable checkpoint: %s',
  async (kind) => {
    const first = setup([[answer('', [call()])], new Error('disconnect')]);
    const completed = await first.run();
    const checkpoint = structuredClone(completed.checkpoint) as LoopCheckpoint;
    if (kind === 'adapter') checkpoint.adapterId = 'other';
    if (kind === 'input') checkpoint.initialRequest.systemPrompt = 'different';
    if (kind === 'missing assistant') checkpoint.messages.splice(1, 1);
    if (kind === 'wrong next index') checkpoint.nextTurnIndex = 20;
    if (kind === 'orphan result') checkpoint.lastTurn.results = [];
    const next = setup([[answer()]], { checkpoint });
    await expect(next.run()).rejects.toBeInstanceOf(AgentError);
    expect(next.adapter.requests).toHaveLength(0);
    expect(next.recorder.records).toHaveLength(0);
  },
);

it.each(['lost round', 'inserted user', 'early terminal', 'wrong logical index'])(
  'rejects a structurally inconsistent checkpoint: %s',
  async (kind) => {
    const first = setup([[answer('', [call('a')])], [answer('', [call('b')])]], {});
    const result = await first.run();
    const checkpoint = structuredClone(result.checkpoint) as LoopCheckpoint;
    if (kind === 'lost round') checkpoint.messages.splice(1, 2);
    if (kind === 'inserted user')
      checkpoint.messages.splice(1, 0, { role: 'user', content: 'unrecorded input', timestamp: 2 });
    if (kind === 'early terminal') {
      const earlier = checkpoint.messages[1];
      if (earlier?.role !== 'assistant') throw new Error();
      earlier.toolCalls = [];
      checkpoint.messages.splice(2, 1);
    }
    if (kind === 'wrong logical index') {
      checkpoint.lastTurn.turnIndex++;
      checkpoint.nextTurnIndex++;
    }
    const resumed = setup([[answer()]], { checkpoint });
    await expect(resumed.run()).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_ERROR' });
    expect(resumed.recorder.records).toHaveLength(0);
    expect(resumed.adapter.requests).toHaveLength(0);
  },
);

it('counts checkpoint rounds after the frozen input history and can resume across multiple new runs', async () => {
  const input = request();
  input.messages.push({ role: 'assistant', content: 'prior conversation', toolCalls: [] });
  const first = setup([[answer('', [call('a')])]], { request: input });
  const firstResult = await first.run();
  const second = setup([[answer('', [call('b')])]], {
    request: input,
    checkpoint: firstResult.checkpoint as LoopCheckpoint,
  });
  const secondResult = await second.run();
  expect(secondResult.stopReason).toBe('MODEL_PROTOCOL_ERROR');
  expect(secondResult.checkpoint?.nextTurnIndex).toBe(2);
  const third = setup([[answer('final')]], {
    request: input,
    checkpoint: secondResult.checkpoint as LoopCheckpoint,
  });
  const thirdResult = await third.run();
  expect(thirdResult.status).toBe('completed');
  expect(thirdResult.checkpoint?.nextTurnIndex).toBe(3);
  expect(thirdResult.turns).toBe(1);
  expect(thirdResult.usage.calls).toBe(1);
});

it.each(['record', 'commit', 'finish'])(
  'does not claim persistence success if the recorder fails at %s',
  async (stage) => {
    const recorder = new MemoryLoopRecorder();
    if (stage === 'record')
      recorder.record = () => {
        throw new Error('private disk failure');
      };
    if (stage === 'commit')
      recorder.commitTurn = () => {
        throw new Error('private commit failure');
      };
    if (stage === 'finish')
      recorder.finish = () => {
        throw new Error('private terminal failure');
      };
    const test = setup([[answer()]], { recorder });
    const result = await test.run();
    expect(result.stopReason).toBe('STORAGE_ERROR');
    expect(result.status).toBe('failed');
    expect(result.recordingFailed).toBe(true);
    if (stage === 'commit') expect(result.checkpoint).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private');
  },
);

it('publishes proposal.created only with a fully committed turn', async () => {
  const proposalId = '44444444-4444-4444-8444-444444444444';
  const registry = new ActionRegistry({
    propose_document_change: () => ({ proposalId, targetDocumentId: documentId, status: 'staged' }),
  });
  const proposal = call('proposal', 'propose_document_change', {
    content: '候选',
    reason: '依据',
    citations: [],
  });
  const { run, recorder } = setup([[answer('', [proposal])]], {
    registry,
  });
  await run();
  expect(
    recorder.records
      .filter((record) => record.kind === 'event')
      .some((record) => record.event.type === 'proposal.created'),
  ).toBe(false);
  expect(recorder.turns[0]?.events.map((event) => event.type)).toEqual([
    'proposal.created',
    'turn.completed',
  ]);
  const failed = setup([[answer('', [proposal])]], { registry });
  failed.recorder.commitTurn = () => {
    throw new Error();
  };
  await failed.run();
  expect(failed.recorder.events.some((event) => event.type === 'proposal.created')).toBe(false);
});

it('treats permission errors as tool results but stops on storage and invalid handler results', async () => {
  const forbidden = setup([[answer('', [call()])], [answer()]], {
    registry: new ActionRegistry({
      read_document: () => {
        throw new AgentError('FORBIDDEN');
      },
    }),
  });
  expect((await forbidden.run()).status).toBe('completed');
  expect(forbidden.recorder.turns[0]?.results[0]).toMatchObject({
    ok: false,
    error: { code: 'FORBIDDEN' },
  });
  const storage = setup([[answer('', [call()])]], {
    registry: new ActionRegistry({
      read_document: () => {
        throw new AgentError('STORAGE_ERROR');
      },
    }),
  });
  expect((await storage.run()).stopReason).toBe('STORAGE_ERROR');
  const broken = setup([[answer('', [call()])]], {
    registry: new ActionRegistry({
      read_document: () => ({ secret: 'must not enter records' }) as never,
    }),
  });
  expect((await broken.run()).stopReason).toBe('INTERNAL_ERROR');
  expect(JSON.stringify(broken.recorder)).not.toContain('must not enter');
});

it('refuses secrets in recorded configuration', async () => {
  const unsafe = request();
  unsafe.connectionSnapshot = { apiKey: 'never-record-me' };
  const test = setup([[answer()]], { request: unsafe });
  await expect(test.run()).rejects.toBeInstanceOf(AgentError);
  expect(test.recorder.records).toHaveLength(0);
});

it('keeps known usage from completed and failed responses without treating unknown later calls as zero', async () => {
  const stats: Usage = {
    inputTokens: 10,
    outputTokens: 3,
    cost: { amount: '0.1', currency: 'USD', source: 'provider' },
  };
  const second = answer('中断前输出', [], 'error', {
    inputTokens: 7,
    outputTokens: 2,
    cost: { amount: '0.2', currency: 'USD', source: 'estimate' },
  });
  const test = setup([[answer('', [call()], 'tool_calls', stats)], [second]]);
  const result = await test.run();
  expect(result.status).toBe('failed');
  expect(result.usage).toMatchObject({
    known: {
      inputTokens: 17,
      outputTokens: 5,
      cost: { amount: '0.3', currency: 'USD', source: 'estimate' },
    },
    complete: true,
  });
  const interrupted = setup([[answer('', [call()], 'tool_calls', stats)], new Error('disconnect')]);
  const failed = await interrupted.run();
  expect(failed.usage).toMatchObject({
    known: { inputTokens: 10, outputTokens: 3, cost: { amount: '0.1' } },
    calls: 2,
    complete: false,
  });
});

it('checks cancellation immediately before a provider request and after the last commit', async () => {
  const before = new AbortController();
  const one = setup([[answer()]], { signal: before.signal });
  one.recorder.record = (record) => {
    if (record.kind === 'request') before.abort();
  };
  expect((await one.run()).status).toBe('cancelled');
  expect(one.adapter.requests).toHaveLength(0);
  const during = new AbortController();
  const two = setup([[answer()]], { signal: during.signal });
  two.recorder.commitTurn = (turn) => {
    two.recorder.turns.push(structuredClone(turn));
    during.abort();
  };
  const result = await two.run();
  expect(result.status).toBe('cancelled');
  expect(result.checkpoint?.nextTurnIndex).toBe(1);
  expect(two.adapter.requests).toHaveLength(1);
});

it('refuses a foreign protocol payload before executing its actions', async () => {
  const response = answer('', [call()]);
  if (response.type !== 'response') throw new Error();
  response.response.transcriptMessage.protocol = { adapter: 'other', message: {} };
  const handler = vi.fn(handlers().read_document);
  const foreign = setup([[response]], { registry: new ActionRegistry({ read_document: handler }) });
  expect((await foreign.run()).stopReason).toBe('MODEL_PROTOCOL_ERROR');
  expect(handler).not.toHaveBeenCalled();
});
