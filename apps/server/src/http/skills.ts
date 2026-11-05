import {
  changeSkillScopeSchema,
  gitSkillImportSchema,
  idSchema,
  paginationSchema,
  saveSkillSchema,
  skillLimits,
  skillListFilterSchema,
  skillScopeInputSchema,
  skillUpdateSchema,
} from '@lingma/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { SkillService } from '../services/skills.js';
import { safeSkillPath } from '../skills/parse.js';

export function skillRoutes(skills: SkillService) {
  const app = new Hono();
  app.use(
    '/skills/*',
    bodyLimit({
      maxSize: skillLimits.totalBytes + 1024 * 1024,
      onError: () => {
        throw new AppError('VALIDATION_ERROR', 'Skill 上传超过 17 MiB 请求限制', 400);
      },
    }),
  );
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/skills', (context) => {
    const { scope, projectId, ...pagination } = context.req.query();
    const { limit, cursor } = paginationSchema.parse(pagination);
    if (cursor) idSchema.parse(cursor);
    return context.json(
      skills.list(limit, cursor, skillListFilterSchema.parse({ scope, projectId })),
    );
  });
  app.get('/skill-imports', (context) =>
    context.json({ data: skills.jobs(skillListFilterSchema.parse(context.req.query())) }),
  );
  app.get('/skill-imports/:jobId', (context) =>
    context.json({ data: skills.job(idSchema.parse(context.req.param('jobId'))) }),
  );
  app.post('/skills/import/local', async (context) => {
    let form: FormData;
    try {
      form = await context.req.formData();
    } catch {
      throw new AppError('VALIDATION_ERROR', '请上传 Skill 文件或目录', 400);
    }
    const files = form.getAll('files');
    const paths = z
      .array(z.string())
      .max(skillLimits.files)
      .parse(JSON.parse(String(form.get('paths') ?? '[]')));
    if (files.length !== paths.length || !files.every((file) => file instanceof File))
      throw new AppError('VALIDATION_ERROR', '文件与路径清单不匹配', 400);
    // The browser sends relative directory names, never a path on the author's machine.
    const normalized = paths.map(safeSkillPath);
    const prefix = normalized.includes('SKILL.md')
      ? ''
      : normalized.find((path) => /^[^/]+\/SKILL\.md$/.test(path))?.slice(0, -'SKILL.md'.length);
    if (prefix === undefined || (prefix && normalized.some((path) => !path.startsWith(prefix))))
      throw new AppError('VALIDATION_ERROR', '请选择根部包含 SKILL.md 的单个目录', 400);
    const skillId = form.get('skillId');
    const base = form.get('baseVersionId');
    if (Boolean(skillId) !== Boolean(base))
      throw new AppError('VALIDATION_ERROR', '更新必须提供 Skill 和基准版本', 400);
    const target = skillId
      ? { skillId: idSchema.parse(skillId), baseVersionId: idSchema.parse(base) }
      : undefined;
    const { projectId } = skillScopeInputSchema.parse({ projectId: form.get('projectId') ?? null });
    for (const file of files)
      if ((file as File).size > skillLimits.fileBytes)
        throw new AppError('VALIDATION_ERROR', '单个文件不能超过 2 MiB', 400);
    const input = await Promise.all(
      files.map(async (file, index) => ({
        path: (normalized[index] ?? '').slice(prefix.length),
        bytes: new Uint8Array(await (file as File).arrayBuffer()),
      })),
    );
    return context.json(
      {
        data: skills.importLocal(
          input,
          prefix ? prefix.slice(0, -1) : 'SKILL.md',
          target,
          projectId,
        ),
      },
      202,
    );
  });
  app.post('/skills/import/git', async (context) => {
    const { projectId, ...input } = gitSkillImportSchema.parse(await context.req.json());
    return context.json({ data: skills.importGit(input, undefined, projectId) }, 202);
  });
  app.patch('/skills/:id/scope', async (context) => {
    const input = changeSkillScopeSchema.parse(await context.req.json());
    return context.json({
      data: skills.changeScope(
        idSchema.parse(context.req.param('id')),
        input.baseVersionId,
        input.projectId,
      ),
    });
  });
  app.get('/skill-versions/:versionId', (context) =>
    context.json({ data: skills.snapshot(idSchema.parse(context.req.param('versionId'))) }),
  );
  app.get('/skills/:id', (context) =>
    context.json({ data: skills.detail(idSchema.parse(context.req.param('id'))) }),
  );
  app.put('/skills/:id', async (context) => {
    const input = saveSkillSchema.parse(await context.req.json());
    return context.json({
      data: await skills.save(
        idSchema.parse(context.req.param('id')),
        input.baseVersionId,
        input.entryContent,
      ),
    });
  });
  app.post('/skills/:id/update-source', async (context) => {
    const input = skillUpdateSchema.parse(await context.req.json());
    return context.json(
      { data: skills.updateGit(idSchema.parse(context.req.param('id')), input.baseVersionId) },
      202,
    );
  });
  app.get('/skills/:id/versions', (context) => {
    const { limit, cursor } = paginationSchema.parse(context.req.query());
    let before: number | undefined;
    if (cursor) {
      if (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
        throw new AppError('VALIDATION_ERROR', '版本游标无效', 400);
      before = Number(cursor);
    }
    return context.json(skills.versions(idSchema.parse(context.req.param('id')), limit, before));
  });
  app.get('/skills/:id/versions/:versionId', (context) =>
    context.json({
      data: skills.detail(
        idSchema.parse(context.req.param('id')),
        idSchema.parse(context.req.param('versionId')),
      ),
    }),
  );
  app.get('/skills/:id/versions/:versionId/file', async (context) => {
    const { file, bytes } = await skills.file(
      idSchema.parse(context.req.param('id')),
      idSchema.parse(context.req.param('versionId')),
      context.req.query('path') ?? '',
    );
    context.header('Content-Type', 'application/octet-stream');
    context.header(
      'Content-Disposition',
      `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.relativePath.split('/').at(-1) ?? 'attachment')}`,
    );
    context.header('Content-Security-Policy', "default-src 'none'; sandbox");
    context.header('X-Content-Type-Options', 'nosniff');
    return context.body(Buffer.from(bytes));
  });
  return app;
}
