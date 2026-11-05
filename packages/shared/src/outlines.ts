import { z } from 'zod';
import { idSchema, timestampSchema } from './domain.js';
import { titleSchema } from './novel.js';

export const chapterOutlineCreationSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          title: titleSchema,
          storyTime: z.string().trim().max(200).optional(),
          summary: z.string().trim().max(1000).optional(),
          content: z
            .string()
            .trim()
            .min(1)
            .max(100_000)
            .describe(
              '完整事件大纲，使用 Markdown 和真实换行；工具 JSON 正常转义即可，不要二次转义成字面量 \\n。',
            ),
        }),
      )
      .min(1)
      .max(30),
    reason: z.string().trim().min(1).max(4000),
    citations: z.array(z.string().min(1)).max(100).default([]),
  })
  .refine(
    (value) => value.items.reduce((total, item) => total + item.content.length, 0) <= 1_000_000,
    '事件大纲内容合计最多 100 万字符',
  );

export const masterOutlineCreationSchema = z.strictObject({
  title: titleSchema.describe('故事总纲标题，不要填写章节或事件标题。'),
  content: z
    .string()
    .trim()
    .min(1)
    .max(100_000)
    .describe(
      '完整故事总纲，涵盖故事起点、主线、人物弧线、主要转折、高潮与结局。使用 Markdown 和真实换行；工具 JSON 正常转义即可，不要二次转义成字面量 \\n。',
    ),
  reason: chapterOutlineCreationSchema.shape.reason,
  citations: chapterOutlineCreationSchema.shape.citations,
});

const chapterCreationItemSchema = z
  .strictObject({
    title: titleSchema.describe('自行拟定的章节标题，包含作者要求的章节序号。'),
    content: z
      .string()
      .max(1_000_000)
      .default('')
      .describe('作者要求写作时提供完整正文；仅新建章节时传空字符串。'),
    volumeId: idSchema
      .nullable()
      .default(null)
      .describe('从本次 volumes 目录复制所属卷 ID；未分卷或新建卷时传 null。'),
    newVolumeTitle: titleSchema
      .optional()
      .describe('需要同时新建卷时填写卷名，不与 volumeId 同时提供；同名卷复用。'),
    outlineIds: z
      .array(idSchema)
      .max(30)
      .default([])
      .describe(
        '需要关联的 chapter_outline 事件 ID，从 allowedDocuments 复制；不填写总纲或其他资料 ID。',
      ),
  })
  .refine((value) => !(value.volumeId && value.newVolumeTitle), '不能同时指定已有卷和新卷名称');

export const chapterCreationSchema = z
  .strictObject({
    ...chapterCreationItemSchema.shape,
    reason: chapterOutlineCreationSchema.shape.reason,
    citations: chapterOutlineCreationSchema.shape.citations,
  })
  .refine((value) => !(value.volumeId && value.newVolumeTitle), '不能同时指定已有卷和新卷名称');

export const outlineCreationPayloadSchema = z.union([
  chapterOutlineCreationSchema.safeExtend({
    kind: z.literal('chapter_outline').default('chapter_outline'),
  }),
  masterOutlineCreationSchema.omit({ title: true, content: true }).extend({
    kind: z.literal('master_outline'),
    items: z.tuple([masterOutlineCreationSchema.pick({ title: true, content: true })]),
  }),
  z.strictObject({
    kind: z.literal('chapter'),
    items: z.tuple([chapterCreationItemSchema]),
    reason: chapterOutlineCreationSchema.shape.reason,
    citations: chapterOutlineCreationSchema.shape.citations,
  }),
]);

export const outlineCreationProposalSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  projectId: idSchema,
  turnIndex: z.int().nonnegative(),
  payload: outlineCreationPayloadSchema,
  status: z.enum(['staged', 'pending', 'accepted', 'rejected', 'abandoned']),
  acceptedDocuments: z.array(z.strictObject({ documentId: idSchema, versionId: idSchema })),
  createdAt: timestampSchema,
});
export type ChapterOutlineCreation = z.infer<typeof chapterOutlineCreationSchema>;
export type OutlineCreationPayload = z.infer<typeof outlineCreationPayloadSchema>;
export type OutlineCreationProposal = z.infer<typeof outlineCreationProposalSchema>;
