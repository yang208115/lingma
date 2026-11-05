import type { ModelAdapter, ModelEvent, ModelRequest } from './types.js';

/** Explicit scripted responses only; never falls back to a paid provider. */
export class FakeModelAdapter implements ModelAdapter {
  readonly id = 'fake/v1';
  readonly requests: ModelRequest[] = [];
  private index = 0;
  constructor(private readonly turns: readonly (readonly ModelEvent[] | Error)[]) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    this.requests.push(structuredClone(request));
    const turn = this.turns[this.index++];
    if (!turn) throw new Error('Fake model script exhausted');
    if (turn instanceof Error) throw turn;
    for (const event of turn) {
      signal.throwIfAborted();
      yield structuredClone(event);
    }
  }
}
