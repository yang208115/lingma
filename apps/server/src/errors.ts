import type { ErrorCode, Json } from '@lingma/shared';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 500 | 503 = 500,
    readonly details?: Record<string, Json>,
  ) {
    super(message);
  }
}
