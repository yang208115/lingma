import { z } from 'zod';
import { idSchema, relativePathSchema, skillVersionSchema, timestampSchema } from './domain.js';

export const skillLimits = {
  files: 200,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  entryBytes: 256 * 1024,
  gitDownloadBytes: 32 * 1024 * 1024,
  gitTimeoutMs: 60_000,
  pathDepth: 16,
} as const;
export const skillSourceSchema = skillVersionSchema.shape.sourceSnapshot;
export const skillScopeSchema = z.enum(['general', 'project']);
export const skillScopeInputSchema = z.strictObject({
  projectId: idSchema.nullable().default(null),
});
export const skillListFilterSchema = z
  .object({ scope: skillScopeSchema.optional(), projectId: idSchema.optional() })
  .refine((value) => value.scope !== 'project' || Boolean(value.projectId), {
    message: '项目 Skill 必须指定项目',
  });
export const changeSkillScopeSchema = skillScopeInputSchema.extend({ baseVersionId: idSchema });
export type SkillListFilter = z.infer<typeof skillListFilterSchema>;
export const skillCatalogEntrySchema = z.strictObject({
  skillId: idSchema,
  versionId: idSchema,
  name: z.string(),
  description: z.string(),
});
export type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>;
export const skillSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1).max(200),
  source: skillSourceSchema,
  currentVersionId: idSchema,
  projectId: idSchema.nullable().default(null),
});
export const parsedSkillSchema = z.strictObject({
  body: z.string(),
  missingFiles: z.array(z.string()),
  warnings: z.array(z.string()),
  examples: z.array(relativePathSchema),
});
export const skillDetailSchema = z.strictObject({
  skill: skillSchema,
  version: skillVersionSchema,
  parsed: parsedSkillSchema,
});
export const saveSkillSchema = z.strictObject({
  baseVersionId: idSchema,
  entryContent: z.string().max(skillLimits.entryBytes),
});
export const gitRepositorySchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (!url.port || url.port === '443') &&
        url.pathname !== '/' &&
        !/[\s\\]/u.test(value) &&
        ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      );
    } catch {
      return false;
    }
  }, '仅支持无凭据、无查询参数且使用 443 端口的公开 HTTPS Git 仓库');
export const gitImportSchema = z.strictObject({
  repository: gitRepositorySchema,
  subdir: z.union([z.literal(''), relativePathSchema]).default(''),
});
export const gitSkillImportSchema = gitImportSchema.extend(skillScopeInputSchema.shape);
export const skillUpdateSchema = z.strictObject({ baseVersionId: idSchema });
export const skillImportJobSchema = z.strictObject({
  id: idSchema,
  type: z.enum(['local', 'git']),
  skillId: idSchema.nullable(),
  projectId: idSchema.nullable().default(null),
  baseVersionId: idSchema.nullable(),
  status: z.enum(['queued', 'fetching', 'publishing', 'completed', 'failed', 'interrupted']),
  source: skillSourceSchema,
  versionId: idSchema.nullable(),
  error: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const skillVersionSummarySchema = z.strictObject({
  id: idSchema,
  versionNo: z.int().positive(),
  createdAt: timestampSchema,
});
export const skillJobsSchema = z.array(skillImportJobSchema);
export type Skill = z.infer<typeof skillSchema>;
export type SkillVersion = z.infer<typeof skillVersionSchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillDetail = z.infer<typeof skillDetailSchema>;
export type SkillImportJob = z.infer<typeof skillImportJobSchema>;
export type GitImport = z.infer<typeof gitImportSchema>;
