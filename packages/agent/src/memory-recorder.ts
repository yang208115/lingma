import type { RunEvent } from '@lingma/shared';
import type { CompletedTurn, LoopRecord, LoopRecorder, LoopResult } from './loop-types.js';

/** Non-durable reference recorder for tests/examples; P05 supplies the transactional implementation. */
export class MemoryLoopRecorder implements LoopRecorder {
  readonly records: LoopRecord[] = [];
  readonly turns: CompletedTurn[] = [];
  terminal: { result: LoopResult; event: Extract<RunEvent, { type: 'run.finished' }> } | null =
    null;
  record(record: LoopRecord): void {
    this.records.push(structuredClone(record));
  }
  commitTurn(turn: CompletedTurn, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.turns.push(structuredClone(turn));
  }
  finish(result: LoopResult, event: Extract<RunEvent, { type: 'run.finished' }>): void {
    this.terminal = structuredClone({ result, event });
  }
  get events(): RunEvent[] {
    return [
      ...this.records.flatMap((record) => (record.kind === 'event' ? [record.event] : [])),
      ...this.turns.flatMap((turn) => turn.events),
      ...(this.terminal ? [this.terminal.event] : []),
    ].sort((a, b) => a.seq - b.seq);
  }
}
