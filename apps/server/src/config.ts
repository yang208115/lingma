import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const configSchema = z.object({
  HOST: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().trim().min(1).default('.data'),
  TEMP_DIR: z.string().trim().min(1).optional(),
  WEB_DIST_DIR: z.string().trim().min(1).default('apps/web/dist'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(10000),
});
export interface Config {
  host: string;
  port: number;
  dataDir: string;
  tempDir: string;
  webDistDir: string;
  shutdownTimeoutMs: number;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = workspaceRoot): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`配置无效：${fields.join(', ')}。请检查 .env.example。P01 仅允许本机监听。`);
  }
  const parsed = result.data;
  const dataDir = resolve(root, parsed.DATA_DIR);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir,
    tempDir: parsed.TEMP_DIR ? resolve(root, parsed.TEMP_DIR) : resolve(dataDir, 'tmp'),
    webDistDir: resolve(root, parsed.WEB_DIST_DIR),
    shutdownTimeoutMs: parsed.SHUTDOWN_TIMEOUT_MS,
  };
}
export function loadEnvironment(): void {
  const path = resolve(workspaceRoot, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}
