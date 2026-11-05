import type { ErrorCode, Json } from '@lingma/shared';

/** Only these explicit, bounded codes cross the injected-service boundary. Raw causes stay private. */
export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message = code,
  ) {
    super(message);
  }
}
/** Deliberately authored tool feedback, safe to return to the model. */
export class ActionError extends AgentError {
  constructor(
    code: ErrorCode,
    readonly publicMessage: string,
    readonly publicDetails?: Json,
  ) {
    super(code);
  }
}
export class LoopStop extends Error {
  constructor(readonly reason: ErrorCode | 'cancelled') {
    super(reason);
  }
}
