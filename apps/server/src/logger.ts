import type { ErrorCode } from '@lingma/shared';

// Keep an allowlist: never serialize requests, headers, config, arbitrary errors or prompts.
export interface LogEntry {
  event: string;
  requestId?: string;
  status?: number;
  durationMs?: number;
  code?: ErrorCode;
}
export interface Logger {
  info(entry: LogEntry): void;
  error(entry: LogEntry): void;
}
export function createLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const log = (level: 'info' | 'error', entry: LogEntry) =>
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        event: entry.event,
        requestId: entry.requestId,
        status: entry.status,
        durationMs: entry.durationMs,
        code: entry.code,
      }),
    );
  return { info: (entry) => log('info', entry), error: (entry) => log('error', entry) };
}
