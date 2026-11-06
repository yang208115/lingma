import {
  idempotencyKeySchema,
  idSchema,
  paginationSchema,
  providerInputSchema,
  renameSessionSchema,
  sessionInputSchema,
  writingRunInputSchema,
} from '@lingma/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { acceptOutlineCreation, rejectOutlineCreation } from '../writing/outlines.js';
import type { WritingService } from '../writing/service.js';
import { writeSSEWithTimeout } from './sse.js';

export function eventCursor(header: string | undefined, query: string | undefined) {
  const raw = header !== undefined ? header : (query ?? '0');
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new AppError('VALIDATION_ERROR', '事件游标必须是非负安全整数', 400);
  return Number(raw);
}
export function writingRoutes(service: WritingService) {
  const app = new Hono();
  const providerSaveSchema = providerInputSchema.safeExtend({
    apiKey: z.string().trim().min(1).max(8192).optional(),
  });
  const sessionQuerySchema = paginationSchema.extend({
    q: z.string().trim().max(200).default(''),
    deleted: z.enum(['0', '1']).default('0'),
  });
  const page = (query: Record<string, string>) => {
    const result = paginationSchema.parse(query);
    if (result.cursor) idSchema.parse(result.cursor);
    return result;
  };
  const limit = bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: () => {
      throw new AppError('VALIDATION_ERROR', '请求体超过 4 MiB', 400);
    },
  });
  for (const path of [
    '/agent-prompt',
    '/runs',
    '/runs/*',
    '/context/*',
    '/provider-configs',
    '/provider-configs/*',
    '/proposals/*',
    '/outline-proposals/*',
    '/sessions/*',
    '/projects/:id/sessions',
  ])
    app.use(path, limit);
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/agent-prompt', (c) => c.json({ data: service.prompt.get() }));
  app.put('/agent-prompt', async (c) => c.json({ data: service.prompt.save(await c.req.json()) }));
  app.get('/provider-configs', (c) => c.json({ data: service.providers.list(), nextCursor: null }));
  app.post('/provider-configs', async (c) => {
    const { apiKey, ...config } = providerSaveSchema.parse(await c.req.json());
    return c.json({ data: service.providers.save(config, undefined, undefined, apiKey) }, 201);
  });
  app.get('/provider-configs/:id', (c) =>
    c.json({ data: service.providers.get(idSchema.parse(c.req.param('id'))) }),
  );
  app.put('/provider-configs/:id', async (c) => {
    const body = z
      .strictObject({
        config: providerInputSchema,
        revision: z.int().positive(),
        apiKey: z.string().trim().min(1).max(8192).optional(),
      })
      .parse(await c.req.json());
    return c.json({
      data: service.providers.save(
        body.config,
        idSchema.parse(c.req.param('id')),
        body.revision,
        body.apiKey,
      ),
    });
  });
  app.post('/provider-configs/:id/check', async (c) =>
    c.json({ data: await service.checkProvider(idSchema.parse(c.req.param('id'))) }),
  );
  app.get('/provider-configs/:id/checks', (c) =>
    c.json({ data: service.checks(idSchema.parse(c.req.param('id'))) }),
  );
  app.post('/context/preview', async (c) =>
    c.json({ data: await service.preview(writingRunInputSchema.parse(await c.req.json())) }),
  );
  app.get('/projects/:id/sessions', (c) => {
    const query = sessionQuerySchema.parse(c.req.query());
    if (query.cursor) idSchema.parse(query.cursor);
    return c.json(
      service.store.sessions(
        idSchema.parse(c.req.param('id')),
        query.limit,
        query.cursor,
        query.q,
        query.deleted === '1',
      ),
    );
  });
  app.post('/projects/:id/sessions', async (c) => {
    const input = sessionInputSchema.parse(await c.req.json());
    return c.json(
      {
        data: service.store.session(
          idSchema.parse(c.req.param('id')),
          input.chapterId,
          input.title,
        ),
      },
      201,
    );
  });
  app.get('/sessions/:id/messages', (c) => {
    const paging = page(c.req.query());
    return c.json(
      service.store.messages(idSchema.parse(c.req.param('id')), paging.limit, paging.cursor),
    );
  });
  app.get('/sessions/:id', (c) =>
    c.json({ data: service.store.sessionDetail(idSchema.parse(c.req.param('id'))) }),
  );
  app.patch('/sessions/:id', async (c) => {
    const input = renameSessionSchema.parse(await c.req.json());
    return c.json({
      data: service.store.renameSession(idSchema.parse(c.req.param('id')), input.title),
    });
  });
  app.delete('/sessions/:id', (c) =>
    c.json({ data: service.store.deleteSession(idSchema.parse(c.req.param('id'))) }),
  );
  app.post('/sessions/:id/restore', (c) =>
    c.json({ data: service.store.restoreSession(idSchema.parse(c.req.param('id'))) }),
  );
  app.get('/runs', (c) => {
    const page = paginationSchema.parse({
      limit: c.req.query('limit') ?? 50,
      ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
    });
    const project = c.req.query('projectId'),
      session = c.req.query('sessionId');
    if (project) idSchema.parse(project);
    if (session) idSchema.parse(session);
    if (page.cursor) idSchema.parse(page.cursor);
    return c.json(service.store.list(project, page.limit, page.cursor, session));
  });
  app.post('/runs', async (c) => {
    const key = idempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    return c.json(
      { data: await service.create(writingRunInputSchema.parse(await c.req.json()), key) },
      202,
    );
  });
  app.get('/runs/:id', (c) =>
    c.json({ data: service.store.detail(idSchema.parse(c.req.param('id'))) }),
  );
  app.post('/runs/:id/cancel', (c) =>
    c.json({ data: service.cancel(idSchema.parse(c.req.param('id'))) }),
  );
  app.post('/runs/:id/retry', (c) =>
    c.json(
      {
        data: service.retry(
          idSchema.parse(c.req.param('id')),
          idempotencyKeySchema.parse(c.req.header('Idempotency-Key')),
        ),
      },
      202,
    ),
  );
  app.post('/runs/:id/proposals', async (c) => {
    const { messageId } = z.strictObject({ messageId: idSchema }).parse(await c.req.json());
    return c.json(
      {
        data: service.store.candidate(
          idSchema.parse(c.req.param('id')),
          messageId,
          idempotencyKeySchema.parse(c.req.header('Idempotency-Key')),
        ),
      },
      201,
    );
  });
  app.get('/proposals/:id', (c) =>
    c.json({ data: service.store.proposal(idSchema.parse(c.req.param('id'))) }),
  );
  app.post('/outline-proposals/:id/accept', (c) =>
    c.json({
      data: acceptOutlineCreation(
        service.store,
        idSchema.parse(c.req.param('id')),
        idempotencyKeySchema.parse(c.req.header('Idempotency-Key')),
      ),
    }),
  );
  app.post('/outline-proposals/:id/reject', (c) =>
    c.json({ data: rejectOutlineCreation(service.store, idSchema.parse(c.req.param('id'))) }),
  );
  app.post('/proposals/:id/accept', (c) =>
    c.json({
      data: service.store.accept(
        idSchema.parse(c.req.param('id')),
        idempotencyKeySchema.parse(c.req.header('Idempotency-Key')),
      ),
    }),
  );
  app.post('/proposals/:id/reject', (c) =>
    c.json({ data: service.store.reject(idSchema.parse(c.req.param('id'))) }),
  );
  app.get('/runs/:id/events', (c) => {
    const id = idSchema.parse(c.req.param('id'));
    let cursor = eventCursor(c.req.header('Last-Event-ID'), c.req.query('after'));
    service.store.events(id, cursor, 1); // Validate before committing HTTP 200.
    if (c.req.query('check') === '1') return c.json({ data: { valid: true } });
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const detach = service.attachStream(() => stream.abort());
      let heartbeat = Date.now();
      const send = (value: Parameters<typeof stream.writeSSE>[0]) =>
        writeSSEWithTimeout(stream, value);
      try {
        await send({ event: 'ready', data: '{}', retry: 500 });
        while (!stream.aborted) {
          const events = service.store.events(id, cursor, 32);
          for (const event of events) {
            await send({ id: String(event.seq), event: event.type, data: JSON.stringify(event) });
            cursor = event.seq;
          }
          const snapshot = service.store.summary(id);
          if (
            !['queued', 'running', 'cancelling'].includes(snapshot.status) &&
            cursor >= snapshot.lastEventSeq
          )
            break;
          if (Date.now() - heartbeat >= 15000) {
            await send({ event: 'heartbeat', data: '{}' });
            heartbeat = Date.now();
          }
          if (events.length === 0) await stream.sleep(200);
        }
      } catch {
        stream.abort();
      } finally {
        detach();
      }
    });
  });
  return app;
}
