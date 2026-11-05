import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { type GitImport, skillLimits } from '@lingma/shared';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { type SkillInputFile, safeSkillPath } from './parse.js';

const resultSchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.array(z.strictObject({ path: z.string(), bytes: z.instanceof(Uint8Array) })),
});
export type GitReader = (
  input: GitImport,
  signal: AbortSignal,
) => Promise<{ commit: string; files: SkillInputFile[] }>;
export function gitReader(tempRoot: string): GitReader {
  return async (input, signal) => {
    if (input.subdir) safeSkillPath(input.subdir);
    const dir = await mkdtemp(resolve(tempRoot, 'skill-git-'));
    let worker: Worker | undefined;
    try {
      return await new Promise((resolveResult, reject) => {
        const compiled = new URL('./git-worker.js', import.meta.url);
        // Node 22.19+ strips worker TypeScript during development; production uses tsc output.
        worker = new Worker(
          existsSync(compiled) ? compiled : new URL('./git-worker.ts', import.meta.url),
          {
            workerData: { ...input, dir },
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 192 },
          },
        );
        const fail = () =>
          reject(new AppError('VALIDATION_ERROR', 'Git 导入已取消或超过 60 秒限制', 400));
        const timer = setTimeout(fail, skillLimits.gitTimeoutMs);
        signal.addEventListener('abort', fail, { once: true });
        if (signal.aborted) fail();
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', fail);
        };
        worker.once('message', (message: unknown) => {
          cleanup();
          const result = resultSchema.safeParse(message);
          if (result.success) resolveResult(result.data);
          else
            reject(
              new AppError(
                'VALIDATION_ERROR',
                typeof message === 'object' &&
                  message &&
                  'error' in message &&
                  typeof message.error === 'string'
                  ? message.error
                  : 'Git 导入失败',
                400,
              ),
            );
        });
        worker.once('error', () => {
          cleanup();
          reject(new AppError('VALIDATION_ERROR', 'Git 导入失败或超过内存限制', 400));
        });
        worker.once('exit', () => {
          cleanup();
          reject(new AppError('VALIDATION_ERROR', 'Git 导入进程退出', 400));
        });
      });
    } finally {
      await worker?.terminate();
      await rm(dir, { recursive: true, force: true });
    }
  };
}
