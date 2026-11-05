import { z } from 'zod';
import {
  documentKindSchema,
  documentSchema,
  documentVersionSchema,
  idSchema,
  jsonSchema,
  projectFormatSchema,
  projectSchema,
  timestampSchema,
} from './domain.js';

export const novelLimits = {
  documentChars: 1_000_000,
  importBytes: 8 * 1024 * 1024,
  importChars: 4_000_000,
  importChapters: 1000,
} as const;
export const titleSchema = z.string().trim().min(1).max(200);
export const metadataSchema = z
  .record(z.string(), jsonSchema)
  .refine((value) => JSON.stringify(value).length <= 65536, '元数据最多 64Ki 字符');
export const createProjectSchema = z.strictObject({
  title: titleSchema,
  format: projectFormatSchema.default('long'),
});
export const completeProjectSetupSchema = z.strictObject({
  baseStructureVersion: z.int().positive(),
});
export const renameProjectSchema = z.strictObject({
  title: titleSchema,
  baseStructureVersion: z.int().positive(),
});
export const deleteProjectSchema = z.strictObject({
  baseStructureVersion: z.int().positive(),
});
export const volumeSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  title: titleSchema,
  sortOrder: z.int().nonnegative(),
});
export const structureSchema = z.strictObject({
  project: projectSchema,
  volumes: z.array(volumeSchema),
  documents: z.array(documentSchema),
});
export const putStructureSchema = z
  .strictObject({
    baseStructureVersion: z.int().positive(),
    volumes: z
      .array(z.strictObject({ id: idSchema, title: titleSchema, sortOrder: z.int().nonnegative() }))
      .max(1000),
    documents: z
      .array(
        z.strictObject({
          id: idSchema,
          title: titleSchema,
          volumeId: idSchema.nullable(),
          sortOrder: z.int().nonnegative(),
        }),
      )
      .max(20000),
  })
  .refine(
    (value) =>
      new Set(value.volumes.map((item) => item.id)).size === value.volumes.length &&
      new Set(value.documents.map((item) => item.id)).size === value.documents.length,
    '目录 ID 不能重复',
  );
export const createDocumentSchema = z
  .strictObject({
    baseStructureVersion: z.int().positive(),
    kind: documentKindSchema,
    title: titleSchema,
    volumeId: idSchema.nullable().default(null),
    newVolumeTitle: titleSchema.optional(),
    chapterId: idSchema.nullable().default(null),
    storyTime: z.string().trim().max(200).optional(),
    summary: z.string().trim().max(1000).optional(),
    content: z.string().max(novelLimits.documentChars).default(''),
    metadata: metadataSchema.default({}),
  })
  .superRefine((value, context) => {
    if (value.newVolumeTitle && (value.kind !== 'chapter' || value.volumeId !== null))
      context.addIssue({
        code: 'custom',
        path: ['newVolumeTitle'],
        message: '仅新建正文可同时创建卷，且不能同时指定已有卷',
      });
    if (value.kind !== 'chapter_outline' && value.chapterId !== null)
      context.addIssue({ code: 'custom', path: ['chapterId'], message: '只有章纲可以关联正文' });
    if (value.kind !== 'chapter' && value.volumeId !== null)
      context.addIssue({ code: 'custom', path: ['volumeId'], message: '仅正文属于卷' });
  });
export const novelSaveSchema = z.strictObject({
  baseVersionId: idSchema,
  content: z.string().max(novelLimits.documentChars),
  metadata: metadataSchema,
});
export const restoreDocumentSchema = z.strictObject({
  baseVersionId: idSchema,
  restoreVersionId: idSchema,
});
export const deleteDocumentSchema = z.strictObject({
  baseVersionId: idSchema,
  baseStructureVersion: z.int().positive(),
});
export const startOutlineWritingSchema = z.strictObject({
  baseVersionId: idSchema,
  baseStructureVersion: z.int().positive(),
  volumeId: idSchema.nullable().default(null),
  newChapterTitle: titleSchema.optional(),
});
export const updateStoryEventSchema = z.strictObject({
  baseStructureVersion: z.int().positive(),
  title: titleSchema,
  storyTime: z.string().trim().max(16000),
  summary: z.string().trim().max(4000),
  chapterIds: z
    .array(idSchema)
    .max(20000)
    .refine((ids) => new Set(ids).size === ids.length, '关联章节不能重复'),
});
export const documentDetailSchema = z.strictObject({
  document: documentSchema,
  version: documentVersionSchema,
});
export const versionSummarySchema = documentVersionSchema.omit({ content: true, metadata: true });
export const importEncodingSchema = z.enum(['utf-8', 'gb18030', 'big5', 'utf-16le']);
export const importChapterSchema = z.strictObject({
  title: titleSchema,
  content: z.string().max(novelLimits.documentChars),
});
export const confirmImportSchema = z
  .strictObject({
    baseStructureVersion: z.int().positive(),
    volumeId: idSchema.nullable(),
    chapters: z.array(importChapterSchema).min(1).max(novelLimits.importChapters),
  })
  .refine(
    (input) =>
      input.chapters.reduce((size, chapter) => size + chapter.content.length, 0) <=
      novelLimits.importChars,
    '导入正文总长度超限',
  );
export const importResultSchema = z.strictObject({
  importId: idSchema,
  projectId: idSchema,
  documentIds: z.array(idSchema),
  structureVersion: z.int().positive(),
});
export const importPreviewSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  baseStructureVersion: z.int().positive(),
  filename: z.string(),
  encoding: importEncodingSchema,
  chapters: z.array(importChapterSchema).min(1).max(novelLimits.importChapters),
  warnings: z.array(z.string()),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  result: importResultSchema.nullable(),
});
export type Project = z.infer<typeof projectSchema>;
export type Document = z.infer<typeof documentSchema>;
export type DocumentVersion = z.infer<typeof documentVersionSchema>;
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
export type Structure = z.infer<typeof structureSchema>;
export type PutStructure = z.infer<typeof putStructureSchema>;
export type CreateDocument = z.infer<typeof createDocumentSchema>;
export type NovelSave = z.infer<typeof novelSaveSchema>;
export type StartOutlineWriting = z.infer<typeof startOutlineWritingSchema>;
export type UpdateStoryEvent = z.infer<typeof updateStoryEventSchema>;
export type ImportChapter = z.infer<typeof importChapterSchema>;
export type ConfirmImport = z.infer<typeof confirmImportSchema>;
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;
export type ImportEncoding = z.infer<typeof importEncodingSchema>;

export function orderedChapters(structure: Structure): Document[] {
  const chapters = structure.documents.filter((document) => document.kind === 'chapter');
  const byOrder = <T extends { sortOrder: number; id: string }>(a: T, b: T) =>
    a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
  return [null, ...[...structure.volumes].sort(byOrder).map((volume) => volume.id)].flatMap(
    (volumeId) => chapters.filter((chapter) => chapter.volumeId === volumeId).sort(byOrder),
  );
}

export function linkedChapterIds(document: Document): string[] {
  return document.chapterIds ?? (document.chapterId ? [document.chapterId] : []);
}

export function isStoryEventKind(kind: string): kind is 'chapter_outline' | 'timeline_event' {
  return kind === 'chapter_outline' || kind === 'timeline_event';
}
