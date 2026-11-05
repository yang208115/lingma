import { z } from 'zod';
import {
  documentKindSchema,
  errorCodeSchema,
  hashSchema,
  idSchema,
  jsonSchema,
  relativePathSchema,
} from './domain.js';
import {
  chapterCreationSchema,
  chapterOutlineCreationSchema,
  masterOutlineCreationSchema,
} from './outlines.js';
import { workflowArtifactPayloadSchema } from './workflow-artifacts.js';

const rangeSchema = z
  .strictObject({ from: z.int().nonnegative(), to: z.int().positive() })
  .refine((range) => range.to > range.from, { message: '无效的 UTF-16 范围' });
const citationSchema = z.strictObject({
  citationId: z.string().min(1),
  documentId: idSchema,
  versionId: idSchema,
  excerpt: z.string().max(8000),
  contentHash: hashSchema,
  metadata: z.record(z.string(), jsonSchema).optional(),
});
const proposalArgs = z.strictObject({
  content: z
    .string()
    .describe(
      '本次授权范围的完整替换文本。整篇修改提供修改后的全文；选区修改只提供该选区的替换文本。',
    ),
  reason: z.string().min(1).max(4000).describe('说明本次修改的理由及如何响应作者要求。'),
  citations: z
    .array(z.string().min(1))
    .max(100)
    .describe(
      '逐字复制本次输入或成功读取、检索结果中的 citationId，不自行拼接。没有引用时传空数组 []。',
    ),
});
export const actionSchemas = {
  propose_chapter_creation: {
    args: chapterCreationSchema,
    result: z.strictObject({ proposalId: idSchema, status: z.literal('staged') }),
  },
  propose_master_outline: {
    args: masterOutlineCreationSchema,
    result: z.strictObject({
      proposalId: idSchema,
      status: z.literal('staged'),
    }),
  },
  propose_chapter_outlines: {
    args: chapterOutlineCreationSchema,
    result: z.strictObject({
      proposalId: idSchema,
      chapterCount: z.int().positive(),
      status: z.literal('staged'),
    }),
  },
  submit_workflow_artifact: {
    args: workflowArtifactPayloadSchema,
    result: z.strictObject({ artifactId: idSchema, status: z.literal('staged') }),
  },
  load_skill: {
    args: z.strictObject({ versionId: idSchema }),
    result: z.strictObject({
      skillId: idSchema,
      versionId: idSchema,
      name: z.string(),
      content: z.string(),
      files: z.array(relativePathSchema),
      warnings: z.array(z.string()),
    }),
  },
  read_skill_file: {
    args: z.strictObject({
      versionId: idSchema,
      path: relativePathSchema,
      range: rangeSchema.optional(),
    }),
    result: z.strictObject({
      versionId: idSchema,
      path: relativePathSchema,
      content: z.string(),
      from: z.int().nonnegative(),
      to: z.int().nonnegative(),
      totalChars: z.int().nonnegative(),
      truncated: z.boolean(),
    }),
  },
  search_documents: {
    args: z.strictObject({
      query: z.string().trim().min(1).max(500),
      kinds: z.array(documentKindSchema).optional(),
      limit: z.int().min(1).max(20).default(5),
    }),
    result: z.strictObject({ matches: z.array(citationSchema).max(20) }),
  },
  read_document: {
    args: z.strictObject({
      documentId: idSchema,
      versionId: idSchema,
      range: rangeSchema.optional(),
    }),
    result: z.strictObject({
      ...citationSchema.shape,
      from: z.int().nonnegative(),
      to: z.int().nonnegative(),
      truncated: z.boolean(),
    }),
  },
  propose_document_change: {
    args: proposalArgs,
    result: z.strictObject({
      proposalId: idSchema,
      targetDocumentId: idSchema,
      status: z.literal('staged'),
    }),
  },
} as const;
export type ActionName = keyof typeof actionSchemas;
export type ActionArgs<N extends ActionName> = z.infer<(typeof actionSchemas)[N]['args']>;
export type ActionResult<N extends ActionName> = z.infer<(typeof actionSchemas)[N]['result']>;
export const actionNameSchema = z.enum([
  'propose_chapter_creation',
  'propose_master_outline',
  'propose_chapter_outlines',
  'submit_workflow_artifact',
  'load_skill',
  'read_skill_file',
  'search_documents',
  'read_document',
  'propose_document_change',
]);
export const actionCallSchema = z.discriminatedUnion('name', [
  z.strictObject({
    callId: z.string().min(1),
    name: z.literal('propose_chapter_creation'),
    args: chapterCreationSchema,
  }),
  z.strictObject({
    callId: z.string().min(1),
    name: z.literal('propose_master_outline'),
    args: masterOutlineCreationSchema,
  }),
  z.strictObject({
    callId: z.string().min(1),
    name: z.literal('propose_chapter_outlines'),
    args: chapterOutlineCreationSchema,
  }),
  z.strictObject({
    callId: z.string().min(1),
    name: z.literal('submit_workflow_artifact'),
    args: workflowArtifactPayloadSchema,
  }),
  z.strictObject({
    callId: z.string().min(1),
    name: z.literal('load_skill'),
    args: actionSchemas.load_skill.args,
  }),
  z.strictObject({
    callId: z.string().min(1),
    name: z.literal('read_skill_file'),
    args: actionSchemas.read_skill_file.args,
  }),
  z.strictObject({
    callId: z.string().min(1),
    name: z.literal('search_documents'),
    args: actionSchemas.search_documents.args,
  }),
  z.strictObject({
    callId: z.string().min(1),
    name: z.literal('read_document'),
    args: actionSchemas.read_document.args,
  }),
  z.strictObject({
    callId: z.string().min(1),
    name: z.literal('propose_document_change'),
    args: proposalArgs,
  }),
]);
export const toolErrorSchema = z.strictObject({
  callId: z.string().min(1),
  ok: z.literal(false),
  error: z.strictObject({ code: errorCodeSchema, message: z.string() }),
});

export const actionDescriptions: Record<ActionName, string> = {
  propose_chapter_creation:
    '为当前作品新建正文章节：自行拟标题 title，按作者要求提供 content（只建空章时为空），从 volumes 目录选择 volumeId，或提供 newVolumeTitle 同时新建卷；可用 outlineIds 关联 chapter_outline 事件。无需先有正文或当前目标。提交待作者确认的创建候选，确认后创建正式章节，不覆盖当前正文。新建章节或写新一章时使用本工具；续写、修改当前章使用 propose_document_change。同一次运行不能同时使用这两种写入工具，需另发任务。content 只能填写正文，完成说明留在聊天回复中。不要只在聊天中提供标题或正文代替提交候选。',
  propose_master_outline:
    '为当前作品生成一份完整的故事总纲候选，提供 title、content、reason、citations，涵盖故事起点、主线推进、人物弧线、主要转折、高潮与结局。无需先选中文档或创建正文；作者确认后新建为故事总纲（master_outline），不会自动覆盖已有总纲。修改当前已有总纲请使用 propose_document_change；拆分故事事件请使用 propose_chapter_outlines。',
  propose_chapter_outlines:
    '为当前作品提出故事时间线的大事件候选，items 按故事实际发生顺序排列，每个事件提供 title、content 完整大纲，可提供 storyTime（自由文本时间）和 summary（简短概述）；一次最多 30 个事件。一个事件可以跨多个章节，不按一章一个事件拆分。只建立待作者确认的候选，不创建正文、不覆盖现有大纲。',
  submit_workflow_artifact:
    '提交本节点的完整结构化产物，不修改正式文档。只提交一次最终产物，审校必须引用给定的稿件产物 ID。',
  load_skill:
    '按可用 Skill 目录的 versionId 加载完整 SKILL.md、附件路径及诊断信息；先读取再遵循其中的任务指导，可按需加载多个 Skill。',
  read_skill_file:
    '读取已提供 Skill 版本 manifest 内的 UTF-8 文本附件；path 相对于 Skill 根目录。每次最多 8000 个 UTF-16 字符，truncated 时用 range 继续读取。不执行脚本。',
  search_documents: '在本次允许的冻结资料清单中检索限长片段，不扩大作品或版本范围。',
  read_document: '读取本次允许的文档版本及 UTF-16 范围，返回可追溯引用。',
  propose_document_change:
    '为本次授权的当前目标提交修改候选，等待作者确认后应用。同一次运行若已提交新建章节候选，不可再修改已有文档，需另发修改任务。只提交 content、reason、citations 三个字段；目标文档、基准版本及整篇或选区范围由服务端绑定。整篇任务的 content 是修改后的全文，选区任务的 content 只替换授权选区；续写时包含需要保留的原文。content 不能是聊天完成说明或候选摘要。引用使用本次已提供的 citationId，无引用传 []。示例：{"content":"完整替换文本","reason":"响应作者的修改要求","citations":[]}。成功返回 proposalId、targetDocumentId 和 staged 状态。',
};
export function actionToolDefinition(name: ActionName) {
  return {
    name,
    description: actionDescriptions[name],
    parameters: z.toJSONSchema(actionSchemas[name].args, { target: 'draft-7', io: 'input' }),
  };
}
