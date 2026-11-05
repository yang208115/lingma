import { expect, it } from 'vitest';
import { FakeModelAdapter, type ModelEvent, type ModelRequest } from '../src/index.js';

const request: ModelRequest = {
  connectionSnapshot: {},
  modelId: 'fake',
  systemPrompt: '固定案例',
  messages: [],
  toolDefinitions: [],
  parameters: {},
};
const response: ModelEvent = {
  type: 'response',
  response: {
    transcriptMessage: { role: 'assistant', content: '候选', toolCalls: [] },
    text: '候选',
    calls: [],
    stop: 'complete',
    usage: { inputTokens: null, outputTokens: null, cost: null },
  },
};
async function collect(source: AsyncIterable<ModelEvent>) {
  const result: ModelEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

it('scripts text, complete protocol responses, and failures without a provider', async () => {
  const model = new FakeModelAdapter([
    [{ type: 'text_delta', text: '候选' }, response],
    new Error('disconnected'),
  ]);
  expect(await collect(model.stream(request, new AbortController().signal))).toHaveLength(2);
  expect(model.requests[0]).toEqual(request);
  await expect(collect(model.stream(request, new AbortController().signal))).rejects.toThrow(
    'disconnected',
  );
  await expect(collect(model.stream(request, new AbortController().signal))).rejects.toThrow(
    'exhausted',
  );
});
it('cancels before starting and between chunks', async () => {
  const controller = new AbortController();
  const model = new FakeModelAdapter([[{ type: 'text_delta', text: 'partial' }, response]]);
  const stream = model.stream(request, controller.signal)[Symbol.asyncIterator]();
  expect((await stream.next()).done).toBe(false);
  controller.abort();
  await expect(stream.next()).rejects.toThrow();
  await expect(collect(model.stream(request, controller.signal))).rejects.toThrow();
  expect(model.requests).toHaveLength(1);
});
