import { serve } from '@hono/node-server';
import { loadConfig, loadEnvironment } from './config.js';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';
import { openRuntime } from './runtime.js';
import { ImportService } from './services/imports.js';
import { NovelService } from './services/novels.js';
import { SkillService } from './services/skills.js';
import { gitReader } from './skills/git.js';
import { WritingService } from './writing/service.js';

const logger = createLogger();
async function main(): Promise<void> {
  loadEnvironment();
  const config = loadConfig();
  const runtime = await openRuntime(config, {
    onCompromised: () => {
      logger.error({ event: 'storage.lock_compromised', code: 'STORAGE_ERROR' });
      process.kill(process.pid, 'SIGTERM');
    },
  });
  const novels = new NovelService(runtime.db);
  const imports = new ImportService(novels, runtime.directories.temp, runtime.gate);
  const skills = new SkillService(
    runtime.db,
    runtime.blobs,
    runtime.gate,
    gitReader(runtime.directories.temp),
  );
  runtime.onClose(() => skills.close());
  const writing = new WritingService(runtime.db, novels, skills);
  runtime.onClose(() => writing.close());
  const app = createApp({
    writing,
    skills,
    ready: runtime.ready,
    webDistDir: config.webDistDir,
    logger,
    novels,
    imports,
  });
  let stopping = false;
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    logger.info({ event: 'server.listening' });
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    // Only a known OS error code is emitted; arbitrary error messages may contain inputs.
    process.stderr.write(`监听失败：${error.code ?? 'UNKNOWN'}\n`);
    void shutdown(1);
  });
  async function shutdown(exitCode: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    runtime.beginShutdown();
    logger.info({ event: 'server.stopping' });
    const deadline = setTimeout(() => {
      logger.error({ event: 'server.shutdown_timeout' });
      if ('closeAllConnections' in server) server.closeAllConnections();
      process.exit(1);
    }, config.shutdownTimeoutMs);
    try {
      const drained = new Promise<void>((resolve) => server.close(() => resolve()));
      await writing.close();
      if ('closeIdleConnections' in server) server.closeIdleConnections();
      await drained;
      await runtime.close();
      process.exitCode = exitCode;
      logger.info({ event: 'server.stopped' });
    } catch {
      logger.error({ event: 'server.shutdown_failed' });
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  }
  process.once('SIGINT', () => {
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    void shutdown(0);
  });
}

main().catch((error: unknown) => {
  logger.error({ event: 'server.startup_failed' });
  // Startup errors contain only config field names, storage paths or migration diagnostics.
  process.stderr.write(`${error instanceof Error ? error.message : '启动失败'}\n`);
  process.exitCode = 1;
});
