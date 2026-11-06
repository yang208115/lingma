import {
  elementCandidatePayloadSchema,
  elementCreateSchema,
  elementDecisionSchema,
  elementGenerationInputSchema,
  elementSaveSchema,
  idempotencyKeySchema,
  idSchema,
} from '@lingma/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ElementService } from '../elements/service.js';
import { AppError } from '../errors.js';
import { writeSSEWithTimeout } from './sse.js';
import { eventCursor } from './writing.js';

export function elementRoutes(service: ElementService) {
  const app = new Hono();
  const key = (value: string | undefined) => idempotencyKeySchema.parse(value);
  app.use(
    '*',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: () => {
        throw new AppError('VALIDATION_ERROR', '请求体超过 4 MiB', 400);
      },
    }),
  );
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/projects/:id/elements', (c) =>
    c.json({
      data: service.list(
        idSchema.parse(c.req.param('id')),
        c.req.query('q'),
        c.req.query('status'),
        c.req.query('tag'),
      ),
    }),
  );
  app.post('/projects/:id/elements', async (c) =>
    c.json(
      {
        data: service.create(
          idSchema.parse(c.req.param('id')),
          elementCreateSchema.parse(await c.req.json()),
        ),
      },
      201,
    ),
  );
  app.get('/elements/:id', (c) =>
    c.json({ data: service.entry(idSchema.parse(c.req.param('id'))) }),
  );
  app.put('/elements/:id', async (c) =>
    c.json({
      data: service.save(
        idSchema.parse(c.req.param('id')),
        elementSaveSchema.parse(await c.req.json()),
      ),
    }),
  );
  app.post('/documents/:id/element-confirmations', async (c) => {
    const b = z.strictObject({ baseVersionId: idSchema }).parse(await c.req.json());
    return c.json({ data: service.confirm(idSchema.parse(c.req.param('id')), b.baseVersionId) });
  });
  app.post('/projects/:id/element-generation-previews', async (c) => {
    const preview = await service.preview(
      idSchema.parse(c.req.param('id')),
      elementGenerationInputSchema.parse(await c.req.json()),
    );
    return c.json({
      data: {
        hash: preview.hash,
        totalStages: preview.stages.length,
        estimatedInputTokens: preview.preview.estimatedInputTokens,
        inputLimit: preview.preview.inputLimit,
        sources: preview.preview.allowed,
      },
    });
  });
  app.post('/projects/:id/element-generations', async (c) =>
    c.json(
      {
        data: await service.createGeneration(
          idSchema.parse(c.req.param('id')),
          elementGenerationInputSchema.parse(await c.req.json()),
          key(c.req.header('Idempotency-Key')),
        ),
      },
      202,
    ),
  );
  app.get('/projects/:id/element-generations', (c) =>
    c.json({ data: service.jobs(idSchema.parse(c.req.param('id'))) }),
  );
  app.get('/element-generations/:id', (c) =>
    c.json({ data: service.get(idSchema.parse(c.req.param('id'))) }),
  );
  app.post('/element-generations/:id/cancel', (c) =>
    c.json({ data: service.cancel(idSchema.parse(c.req.param('id'))) }),
  );
  app.post('/element-generations/:id/retry', async (c) =>
    c.json(
      {
        data: await service.retry(
          idSchema.parse(c.req.param('id')),
          key(c.req.header('Idempotency-Key')),
        ),
      },
      202,
    ),
  );
  app.patch('/element-candidates/:id', async (c) => {
    const b = z
      .strictObject({ revision: z.int().positive(), payload: elementCandidatePayloadSchema })
      .parse(await c.req.json());
    return c.json({
      data: service.editCandidate(idSchema.parse(c.req.param('id')), b.revision, b.payload),
    });
  });
  app.post('/element-candidates/:id/regenerate', async (c) => {
    const b = z.strictObject({ revision: z.int().positive() }).parse(await c.req.json());
    return c.json(
      {
        data: await service.regenerateCandidate(
          idSchema.parse(c.req.param('id')),
          b.revision,
          key(c.req.header('Idempotency-Key')),
        ),
      },
      202,
    );
  });
  app.post('/element-generations/:id/decisions', async (c) =>
    c.json({
      data: service.decide(
        idSchema.parse(c.req.param('id')),
        elementDecisionSchema.parse(await c.req.json()),
        key(c.req.header('Idempotency-Key')),
      ),
    }),
  );
  app.get('/element-generations/:id/events', (c) => {
    const id = idSchema.parse(c.req.param('id'));
    let cursor = eventCursor(c.req.header('Last-Event-ID'), c.req.query('after'));
    service.events(id, cursor);
    if (c.req.query('check') === '1') return c.json({ data: { valid: true } });
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const detach = service.writing.attachStream(() => stream.abort());
      try {
        await stream.writeSSE({ event: 'ready', data: '{}', retry: 1000 });
        let heartbeat = Date.now();
        while (!stream.aborted) {
          const events = service.events(id, cursor);
          for (const event of events) {
            await writeSSEWithTimeout(stream, {
              id: String(event.seq),
              event: 'change',
              data: JSON.stringify(event),
            });
            cursor = event.seq;
          }
          if (!['queued', 'running'].includes(service.get(id).status) && !events.length) break;
          if (Date.now() - heartbeat > 15000) {
            await stream.writeSSE({ event: 'heartbeat', data: '{}' });
            heartbeat = Date.now();
          }
          await stream.sleep(250);
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
