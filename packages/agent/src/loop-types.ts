import type {
  ActionOutcome,
  Json,
  LoopCheckpoint,
  ModelCall,
  RunEvent,
  Usage,
} from '@lingma/shared';
import type { ActionRegistry } from './actions/registry.js';
import type { ModelAdapter, ModelEvent, ModelRequest, ModelResponse } from './model/types.js';
import type { UsageSummary } from './usage.js';

export type LoopRecord =
  | { kind: 'event'; event: RunEvent }
  | { kind: 'request'; turnIndex: number; messageId: string; request: ModelRequest }
  | { kind: 'model_event'; turnIndex: number; event: ModelEvent }
  | { kind: 'response'; turnIndex: number; response: ModelResponse }
  | {
      kind: 'action';
      turnIndex: number;
      executionId: string;
      call: ModelCall;
      result: ActionOutcome;
    };
export interface CompletedTurn {
  turnIndex: number;
  messageId: string;
  response: ModelResponse;
  results: ActionOutcome[];
  checkpoint: LoopCheckpoint;
  events: RunEvent[];
}
export interface LoopResult {
  status: 'completed' | 'limited' | 'failed' | 'cancelled';
  stopReason: Extract<RunEvent, { type: 'run.finished' }>['stopReason'];
  turns: number;
  attemptedTurns: number;
  output: { messageId: string; text: string; committed: boolean } | null;
  checkpoint: LoopCheckpoint | null;
  usage: UsageSummary;
  recordingFailed: boolean;
}
export interface LoopRecorder {
  record(record: LoopRecord): void | Promise<void>;
  /** P05 must atomically publish the checkpoint, activate staged proposals and persist this event. */
  commitTurn(turn: CompletedTurn, signal: AbortSignal): void | Promise<void>;
  /** P05 must atomically store terminal state and the terminal event. */
  finish(
    result: LoopResult,
    event: Extract<RunEvent, { type: 'run.finished' }>,
  ): void | Promise<void>;
}
export interface LoopInput {
  runId: string;
  adapter: ModelAdapter;
  registry: ActionRegistry;
  request: ModelRequest;
  recorder: LoopRecorder;
  signal: AbortSignal;
  checkpoint?: LoopCheckpoint;
  initialSeq?: number;
  clock?: { now(): number; wallNow(): number };
}
export type { Json, Usage };
