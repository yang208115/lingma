import {
  agentCapabilitySchema,
  agentProfileConfigSchema,
  idempotencyKeySchema,
  idSchema,
  workflowDecisionSchema,
  workflowInputSchema,
  workflowTemplateConfigSchema,
} from '@lingma/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { WorkflowService } from '../workflows/service.js';
import { writeSSEWithTimeout } from './sse.js';
import { eventCursor } from './writing.js';

export function workflowRoutes(service: WorkflowService) {
  const app = new Hono();
  const lib = service.library;
  const key = (value: string | undefined) => idempotencyKeySchema.parse(value);
  const version = z.strictObject({ expectedRevision: z.int().positive() });
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
  app.get('/agent-capabilities', (c) => c.json({ data: agentCapabilitySchema.options }));
  app.get('/agent-profiles', (c) => c.json({ data: lib.profiles() }));
  app.post('/agent-profiles', async (c) => {
    const input = agentProfileConfigSchema.parse(await c.req.json());
    return c.json(
      {
        data: service.store.once(
          'profile:create',
          key(c.req.header('Idempotency-Key')),
          input,
          () => lib.createProfile(input),
        ),
      },
      201,
    );
  });
  app.get('/agent-profiles/:id', (c) =>
    c.json({ data: lib.profile(idSchema.parse(c.req.param('id'))) }),
  );
  app.patch('/agent-profiles/:id/draft', async (c) => {
    const b = version.extend({ config: agentProfileConfigSchema }).parse(await c.req.json());
    return c.json({
      data: lib.saveProfile(idSchema.parse(c.req.param('id')), b.expectedRevision, b.config),
    });
  });
  app.post('/agent-profiles/:id/versions', async (c) => {
    const id = idSchema.parse(c.req.param('id'));
    const b = version.parse(await c.req.json());
    return c.json({
      data: service.store.once(
        `profile:publish:${id}`,
        key(c.req.header('Idempotency-Key')),
        b,
        () => lib.publishProfile(id, b.expectedRevision),
      ),
    });
  });
  app.post('/agent-profiles/:id/archive', async (c) => {
    const b = version.extend({ archived: z.boolean() }).parse(await c.req.json());
    return c.json({
      data: lib.archive(idSchema.parse(c.req.param('id')), b.expectedRevision, b.archived),
    });
  });
  app.post('/agent-profiles/:id/test-runs', async (c) => {
    const b = version.extend({ input: workflowInputSchema }).parse(await c.req.json());
    return c.json(
      {
        data: await service.testProfile(
          idSchema.parse(c.req.param('id')),
          b.expectedRevision,
          b.input,
          key(c.req.header('Idempotency-Key')),
        ),
      },
      202,
    );
  });
  app.get('/agent-test-runs/:id', (c) =>
    c.json({ data: service.testResult(idSchema.parse(c.req.param('id'))) }),
  );
  app.get('/workflow-templates', (c) => c.json({ data: lib.templates() }));
  app.post('/workflow-templates', async (c) => {
    const b = workflowTemplateConfigSchema.parse(await c.req.json());
    return c.json(
      {
        data: service.store.once('template:create', key(c.req.header('Idempotency-Key')), b, () =>
          lib.createTemplate(b),
        ),
      },
      201,
    );
  });
  app.patch('/workflow-templates/:id/draft', async (c) => {
    const b = version.extend({ config: workflowTemplateConfigSchema }).parse(await c.req.json());
    return c.json({
      data: lib.saveTemplate(idSchema.parse(c.req.param('id')), b.expectedRevision, b.config),
    });
  });
  app.post('/workflow-templates/:id/versions', async (c) => {
    const id = idSchema.parse(c.req.param('id'));
    const b = version.parse(await c.req.json());
    return c.json({
      data: service.store.once(
        `template:publish:${id}`,
        key(c.req.header('Idempotency-Key')),
        b,
        () => lib.publishTemplate(id, b.expectedRevision),
      ),
    });
  });
  app.post('/workflow-previews', async (c) =>
    c.json({ data: await service.preview(workflowInputSchema.parse(await c.req.json())) }),
  );
  app.post('/workflows', async (c) =>
    c.json(
      {
        data: await service.create(
          workflowInputSchema.parse(await c.req.json()),
          key(c.req.header('Idempotency-Key')),
        ),
      },
      202,
    ),
  );
  app.get('/workflows', (c) =>
    c.json({
      data: service.list(
        idSchema.parse(c.req.query('projectId')),
        idSchema.optional().parse(c.req.query('sessionId')),
      ),
    }),
  );
  app.get('/workflows/:id', (c) =>
    c.json({ data: service.get(idSchema.parse(c.req.param('id'))) }),
  );
  app.post('/workflows/:id/refresh-sources', async (c) => {
    const b = version
      .extend({ content: z.string().min(1).max(1000000).optional() })
      .parse(await c.req.json());
    return c.json({
      data: await service.refreshSources(
        idSchema.parse(c.req.param('id')),
        b.expectedRevision,
        b.content,
        key(c.req.header('Idempotency-Key')),
      ),
    });
  });
  app.post('/workflows/:id/decisions', async (c) =>
    c.json({
      data: service.decide(
        idSchema.parse(c.req.param('id')),
        workflowDecisionSchema.parse(await c.req.json()),
        key(c.req.header('Idempotency-Key')),
      ),
    }),
  );
  app.get('/workflows/:id/events', (c) => {
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
          const events = service.events(id, cursor) as { seq: number; type: string }[];
          for (const event of events) {
            await writeSSEWithTimeout(stream, {
              id: String(event.seq),
              event: 'change',
              data: JSON.stringify(event),
            });
            cursor = event.seq;
          }
          if (['completed', 'cancelled'].includes(service.get(id).status) && events.length === 0)
            break;
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
