import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ImportService } from '../services/imports.js';
import type { NovelService } from '../services/novels.js';
import type { SkillService } from '../services/skills.js';
import type { WritingService } from '../writing/service.js';
import { elementRoutes } from './elements.js';
import { novelRoutes } from './novels.js';
import { skillRoutes } from './skills.js';
import { workflowRoutes } from './workflows.js';
import { writingRoutes } from './writing.js';

type Environment = { Variables: { requestId: string } };
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function createApp(options: {
  ready: () => boolean;
  webDistDir: string;
  logger: Logger;
  novels?: NovelService;
  imports?: ImportService;
  skills?: SkillService;
  writing?: WritingService;
}) {
  const app = new Hono<Environment>();
  app.use('*', async (context, next) => {
    const requestId = randomUUID();
    context.set('requestId', requestId);
    context.header('X-Request-ID', requestId);
    const started = performance.now();
    await next();
    options.logger.info({
      event: 'http.request',
      requestId,
      status: context.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });
  app.use('*', secureHeaders());
  app.use('*', async (context, next) => {
    const url = new URL(context.req.url);
    const host = context.req.header('host') ?? url.host;
    let hostname: string;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      throw new AppError('FORBIDDEN', '无效的 Host', 403);
    }
    if (!loopback.has(hostname)) throw new AppError('FORBIDDEN', '仅允许本机 Host', 403);
    const origin = context.req.header('origin');
    if (origin) {
      const allowed = new Set([
        `http://${host}`,
        `https://${host}`,
        'http://127.0.0.1:5173',
        'http://localhost:5173',
      ]);
      if (!allowed.has(origin)) throw new AppError('FORBIDDEN', '不允许的请求来源', 403);
    }
    if (context.req.header('sec-fetch-site') === 'cross-site')
      throw new AppError('FORBIDDEN', '不允许跨站访问', 403);
    await next();
  });

  const health = () => ({ data: { status: 'ok' as const } });
  app.get('/api/v1/health', (context) => context.json(health()));
  app.get('/health', (context) => context.json(health()));
  for (const path of ['/api/v1/ready', '/ready']) {
    app.get(path, (context) => {
      const ready = options.ready();
      context.header('Cache-Control', 'no-store');
      return context.json({ data: { status: ready ? 'ready' : 'not_ready' } }, ready ? 200 : 503);
    });
  }
  app.use('/api/*', async (_context, next) => {
    if (!options.ready()) throw new AppError('MAINTENANCE_MODE', '服务尚未就绪', 503);
    await next();
  });
  if (options.novels && options.imports)
    app.route('/api/v1', novelRoutes(options.novels, options.imports));
  if (options.skills) app.route('/api/v1', skillRoutes(options.skills));
  if (options.writing) app.route('/api/v1', writingRoutes(options.writing));
  if (options.writing) app.route('/api/v1', workflowRoutes(options.writing.workflows));
  if (options.writing) app.route('/api/v1', elementRoutes(options.writing.elements));
  app.all('/api/*', () => {
    throw new AppError('NOT_FOUND', '接口不存在', 404);
  });

  app.use('*', serveStatic({ root: options.webDistDir }));
  app.get('*', async (context, next) => {
    if (context.req.path.startsWith('/assets/') || /\.[^/]+$/.test(context.req.path)) return next();
    if (!context.req.header('accept')?.includes('text/html') && context.req.path !== '/')
      return next();
    if (!existsSync(resolve(options.webDistDir, 'index.html'))) return next();
    context.header('Cache-Control', 'no-cache');
    return serveStatic({ path: resolve(options.webDistDir, 'index.html') })(context, next);
  });
  app.notFound(() => {
    throw new AppError('NOT_FOUND', '资源不存在', 404);
  });
  app.onError((error, context) => {
    const mapped =
      error instanceof AppError
        ? error
        : error instanceof SyntaxError
          ? new AppError('VALIDATION_ERROR', '请求 JSON 格式无效', 400)
          : error instanceof ZodError
            ? new AppError('VALIDATION_ERROR', '输入参数无效', 400, {
                fields: error.issues.map((issue) => issue.path.join('.')),
              })
            : 'code' in error &&
                typeof error.code === 'string' &&
                /^(SQLITE_|EIO$|ENOSPC$|EROFS$|EACCES$|EPERM$)/.test(error.code)
              ? new AppError('STORAGE_ERROR', '存储暂时不可用，请检查数据目录后重试', 503)
              : new AppError('INTERNAL_ERROR', '服务暂时不可用', 500);
    const requestId = context.get('requestId') ?? randomUUID();
    options.logger.error({ event: 'http.error', requestId, code: mapped.code });
    return context.json(
      {
        error: {
          code: mapped.code,
          message: mapped.message,
          requestId,
          ...(mapped.details ? { details: mapped.details } : {}),
        },
      },
      mapped.status,
    );
  });
  return app;
}
