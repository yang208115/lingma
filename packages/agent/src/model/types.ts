import type {
  ModelEventContract,
  ModelRequestContract,
  ModelResponseContract,
} from '@lingma/shared';

/** Frozen public configuration and canonical messages; credentials are resolved only inside an adapter. */
export type ModelRequest = ModelRequestContract;
export type ModelResponse = ModelResponseContract;
export type ModelEvent = ModelEventContract;
export interface ModelAdapter {
  readonly id: string;
  /** Validate frozen, non-sensitive configuration before the loop records any request. */
  validateRequest?(request: ModelRequest): void;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
