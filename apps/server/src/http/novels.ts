import {
  completeProjectSetupSchema,
  confirmImportSchema,
  createDocumentSchema,
  createProjectSchema,
  deleteDocumentSchema,
  deleteProjectSchema,
  idSchema,
  importEncodingSchema,
  novelSaveSchema,
  paginationSchema,
  putStructureSchema,
  renameProjectSchema,
  restoreDocumentSchema,
  startOutlineWritingSchema,
  updateStoryEventSchema,
} from '@lingma/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { ImportService } from '../services/imports.js';
import type { NovelService } from '../services/novels.js';

export function novelRoutes(novels: NovelService, imports: ImportService) {
  const app = new Hono();
  app.use(
    '*',
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: () => {
        throw new AppError('VALIDATION_ERROR', '请求体超过 12 MiB，请缩小文档或文件', 400);
      },
    }),
  );
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/projects', (context) => {
    const { deleted: deletedQuery, ...query } = context.req.query();
    const page = paginationSchema.parse(query);
    if (page.cursor) idSchema.parse(page.cursor);
    const deleted = z.enum(['true', 'false']).default('false').parse(deletedQuery);
    return context.json(novels.listProjects(page.limit, page.cursor, deleted === 'true'));
  });
  app.post('/projects', async (context) => {
    const input = createProjectSchema.parse(await context.req.json());
    return context.json({ data: novels.createProject(input.title, input.format) }, 201);
  });
  app.post('/projects/:id/setup-completion', async (context) => {
    const input = completeProjectSetupSchema.parse(await context.req.json());
    return context.json({
      data: novels.completeProjectSetup(
        idSchema.parse(context.req.param('id')),
        input.baseStructureVersion,
      ),
    });
  });
  app.get('/projects/:id', (context) =>
    context.json({ data: novels.getProject(idSchema.parse(context.req.param('id'))) }),
  );
  app.delete('/projects/:id', async (context) => {
    const input = deleteProjectSchema.parse(await context.req.json());
    return context.json({
      data: novels.deleteProject(
        idSchema.parse(context.req.param('id')),
        input.baseStructureVersion,
      ),
    });
  });
  app.post('/projects/:id/restore', (context) =>
    context.json({ data: novels.restoreProject(idSchema.parse(context.req.param('id'))) }),
  );
  app.patch('/projects/:id', async (context) => {
    const input = renameProjectSchema.parse(await context.req.json());
    return context.json({
      data: novels.renameProject(
        idSchema.parse(context.req.param('id')),
        input.title,
        input.baseStructureVersion,
      ),
    });
  });
  app.get('/projects/:id/structure', (context) =>
    context.json({ data: novels.getStructure(idSchema.parse(context.req.param('id'))) }),
  );
  app.put('/projects/:id/structure', async (context) =>
    context.json({
      data: novels.putStructure(
        idSchema.parse(context.req.param('id')),
        putStructureSchema.parse(await context.req.json()),
      ),
    }),
  );
  app.post('/projects/:id/documents', async (context) =>
    context.json(
      {
        data: novels.createDocument(
          idSchema.parse(context.req.param('id')),
          createDocumentSchema.parse(await context.req.json()),
        ),
      },
      201,
    ),
  );
  app.get('/documents/:id', (context) =>
    context.json({ data: novels.getDocument(idSchema.parse(context.req.param('id'))) }),
  );
  app.post('/documents/:id/start-writing', async (context) =>
    context.json({
      data: novels.startOutlineWriting(
        idSchema.parse(context.req.param('id')),
        startOutlineWritingSchema.parse(await context.req.json()),
      ),
    }),
  );
  app.put('/documents/:id', async (context) =>
    context.json({
      data: novels.saveDocument(
        idSchema.parse(context.req.param('id')),
        novelSaveSchema.parse(await context.req.json()),
      ),
    }),
  );
  app.put('/documents/:id/event-plan', async (context) =>
    context.json({
      data: novels.updateStoryEvent(
        idSchema.parse(context.req.param('id')),
        updateStoryEventSchema.parse(await context.req.json()),
      ),
    }),
  );
  app.delete('/documents/:id', async (context) => {
    const input = deleteDocumentSchema.parse(await context.req.json());
    novels.deleteDocument(
      idSchema.parse(context.req.param('id')),
      input.baseVersionId,
      input.baseStructureVersion,
    );
    return context.json({ data: { deleted: true } });
  });
  app.get('/documents/:id/versions', (context) => {
    const page = paginationSchema.parse(context.req.query());
    if (
      page.cursor &&
      (!/^[1-9]\d*$/.test(page.cursor) || !Number.isSafeInteger(Number(page.cursor)))
    )
      throw new AppError('VALIDATION_ERROR', '版本游标无效', 400);
    return context.json(
      novels.listVersions(
        idSchema.parse(context.req.param('id')),
        page.limit,
        page.cursor ? Number(page.cursor) : undefined,
      ),
    );
  });
  app.get('/documents/:id/versions/:version', (context) =>
    context.json({
      data: novels.getVersion(
        idSchema.parse(context.req.param('id')),
        idSchema.parse(context.req.param('version')),
      ),
    }),
  );
  app.post('/documents/:id/restore', async (context) => {
    const input = restoreDocumentSchema.parse(await context.req.json());
    return context.json({
      data: novels.restoreDocument(
        idSchema.parse(context.req.param('id')),
        input.baseVersionId,
        input.restoreVersionId,
      ),
    });
  });
  app.get('/projects/:id/export.txt', (context) => {
    const id = idSchema.parse(context.req.param('id'));
    const chapter = context.req.query('chapterId');
    if (chapter) idSchema.parse(chapter);
    context.header('Content-Type', 'text/plain; charset=utf-8');
    context.header(
      'Content-Disposition',
      `attachment; filename="novel.txt"; filename*=UTF-8''${encodeURIComponent(`${novels.getProject(id).title}.txt`)}`,
    );
    return context.body(novels.exportText(id, chapter));
  });
  app.post('/projects/:id/imports', async (context) => {
    const id = idSchema.parse(context.req.param('id'));
    let form: FormData;
    try {
      form = await context.req.formData();
    } catch {
      throw new AppError('VALIDATION_ERROR', '请使用表单上传文件', 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw new AppError('VALIDATION_ERROR', '缺少导入文件', 400);
    return context.json(
      {
        data: await imports.create(
          id,
          file.name,
          new Uint8Array(await file.arrayBuffer()),
          importEncodingSchema.parse(form.get('encoding') ?? 'utf-8'),
        ),
      },
      201,
    );
  });
  app.get('/projects/:id/imports/:importId', async (context) =>
    context.json({
      data: await imports.get(
        idSchema.parse(context.req.param('id')),
        idSchema.parse(context.req.param('importId')),
      ),
    }),
  );
  app.post('/projects/:id/imports/:importId/confirm', async (context) =>
    context.json({
      data: await imports.confirm(
        idSchema.parse(context.req.param('id')),
        idSchema.parse(context.req.param('importId')),
        confirmImportSchema.parse(await context.req.json()),
      ),
    }),
  );
  return app;
}
