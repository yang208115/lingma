import type { SSEMessage, SSEStreamingApi } from 'hono/streaming';

/** Writes one SSE message, failing fast when a client does not read within the timeout. */
export async function writeSSEWithTimeout(
  stream: SSEStreamingApi,
  message: SSEMessage,
  timeoutMs = 5000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stream.writeSSE(message),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('slow client')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
