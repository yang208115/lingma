import { z } from 'zod';
import { idSchema, timestampSchema, usageTotalSchema } from './domain.js';
import { documentDetailSchema } from './novel.js';
import { contextEntrySchema } from './writing.js';

export const elementKindSchema = z.enum([
  'story_premise',
  'worldbuilding',
  'character',
  'core_conflict',
  'master_outline',
  'timeline_event',
  'foreshadow',
  'narrative_style',
]);
export type ElementKind = z.infer<typeof elementKindSchema>;
export const elementKinds = elementKindSchema.options;
export const basicInformationKinds = [
  'story_premise',
  'worldbuilding',
  'character',
  'core_conflict',
  'narrative_style',
] as const satisfies readonly ElementKind[];
export const isBasicInformationKind = (
  kind: string,
): kind is (typeof basicInformationKinds)[number] =>
  basicInformationKinds.some((entry) => entry === kind);
export const isElementKind = (kind: string): kind is ElementKind =>
  elementKinds.includes(kind as ElementKind);
export const elementLabels: Record<ElementKind, string> = {
  story_premise: '故事定位与主题',
  worldbuilding: '世界与场景',
  character: '人物与关系',
  core_conflict: '核心冲突',
  master_outline: '情节主线',
  timeline_event: '时间线',
  foreshadow: '伏笔与悬念',
  narrative_style: '叙事与文风',
};
export const elementFields: Record<ElementKind, Record<string, string>> = {
  story_premise: {
    genre: '题材',
    audience: '目标读者',
    premise: '一句话梗概',
    sellingPoint: '核心卖点',
    theme: '主题命题',
    emotion: '情绪体验',
    length: '篇幅目标',
  },
  worldbuilding: {
    subtype: '类型（总设定/地点/组织/体系/物品）',
    era: '时代与历史',
    geography: '地域与环境',
    society: '制度与文化',
    resources: '资源与势力',
    rules: '规则与使用条件',
    cost: '代价与限制',
    taboos: '禁忌',
  },
  character: {
    aliases: '别名',
    role: '角色定位',
    identity: '年龄、身份与阵营',
    appearance: '外貌与习惯',
    voice: '对白特征',
    goal: '外在目标',
    need: '内在需要',
    motivation: '动机',
    values: '价值观与底线',
    flaw: '弱点与恐惧',
    history: '关键经历',
    ability: '能力、资源与限制',
    secret: '秘密与知情范围',
    arc: '成长弧线（规划）',
    currentState: '当前状态（附章节依据）',
  },
  core_conflict: {
    level: '层级（主线/支线/内在）',
    protagonist: '推动者',
    opposition: '对立力量',
    goals: '双方目标及不兼容之处',
    stake: '争夺焦点',
    obstacle: '阻碍与持续原因',
    failureCost: '失败代价',
    deadline: '时限',
    escalation: '升级机制',
    choice: '最终抉择',
    progress: '进展与依据',
  },
  master_outline: {
    opening: '故事起点',
    inciting: '诱发事件',
    stages: '阶段目标与分卷',
    turns: '主要转折',
    climax: '高潮',
    ending: '结局方向',
  },
  timeline_event: {
    time: '时间（支持相对时间与自定义历法）',
    event: '事件',
    cause: '前置事件与原因',
    consequence: '后果',
    participants: '参与者与地点',
  },
  foreshadow: {
    clue: '埋设信息',
    surface: '表层解释',
    truth: '真实含义',
    plantedAt: '计划埋设位置',
    payoff: '预期回收',
    progress: '回收状态与正文依据',
  },
  narrative_style: {
    pov: '视角与人物知识边界',
    tense: '时态',
    tone: '基调',
    pace: '节奏',
    dialogue: '对白偏好',
    description: '描写尺度',
    avoid: '禁用表达',
    sample: '参考片段',
  },
};
export const elementNatureSchema = z.enum(['rule', 'established', 'planned']);
export const elementLinkSchema = z.strictObject({
  targetId: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  nature: elementNatureSchema.default('planned'),
});
export const elementSourceSchema = z
  .strictObject({
    documentId: idSchema,
    versionId: idSchema,
    from: z.int().nonnegative(),
    to: z.int().nonnegative(),
  })
  .refine((v) => v.to >= v.from);
export const elementDataSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  summary: z.string().max(4000).default(''),
  tags: z.array(z.string().max(100)).max(30).default([]),
  fields: z.record(z.string().max(100), z.string().max(16000)).default({}),
  nature: elementNatureSchema.default('rule'),
  links: z.array(elementLinkSchema).max(100).default([]),
  sources: z.array(elementSourceSchema).max(100).default([]),
  source: z.enum(['manual', 'organized', 'ai', 'extracted']).default('manual'),
  generationId: idSchema.nullable().default(null),
  archived: z.boolean().default(false),
  locked: z.array(z.string().max(100)).max(100).default([]),
});
export type ElementData = z.infer<typeof elementDataSchema>;
export function readElementData(metadata: Record<string, unknown>): ElementData {
  return elementDataSchema.parse(metadata.element ?? {});
}
export function validateElementFields(kind: ElementKind, data: ElementData) {
  const unknown = Object.keys(data.fields).filter((key) => !(key in elementFields[kind]));
  if (unknown.length) throw new Error(`未知要素字段：${unknown.join('、')}`);
  const locks = [
    'title',
    'summary',
    'content',
    'nature',
    'tags',
    'links',
    ...Object.keys(elementFields[kind]).map((key) => `fields.${key}`),
  ];
  if (data.locked.some((key) => !locks.includes(key))) throw new Error('未知锁定字段');
}
export const elementEntrySchema = documentDetailSchema.extend({
  confirmedVersionId: idSchema.nullable(),
  status: z.enum(['draft', 'confirmed', 'archived']),
  data: elementDataSchema,
});
export type ElementEntry = z.infer<typeof elementEntrySchema>;
export function hasElementContent(entry: ElementEntry): boolean {
  const filled = (value: unknown): boolean => {
    if (typeof value === 'string') return Boolean(value.trim());
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.some(filled);
    return value !== null && typeof value === 'object' && Object.values(value).some(filled);
  };
  return Boolean(
    entry.version.content.trim() ||
      entry.data.summary.trim() ||
      Object.values(entry.data.fields).some((value) => value.trim()) ||
      entry.data.tags.some((tag) => tag.trim()) ||
      entry.data.links.length ||
      Object.entries(entry.version.metadata).some(
        ([key, value]) => key !== 'element' && filled(value),
      ),
  );
}
export const elementCreateSchema = z.strictObject({
  kind: elementKindSchema,
  title: z.string().trim().min(1).max(200),
  content: z.string().max(1000000).default(''),
  data: elementDataSchema.default(() => elementDataSchema.parse({})),
});
export const elementSaveSchema = z.strictObject({
  baseVersionId: idSchema,
  title: z.string().trim().min(1).max(200),
  content: z.string().max(1000000),
  data: elementDataSchema,
});
export const elementGenerationInputSchema = z.strictObject({
  providerConfigId: idSchema,
  modelId: z.string().min(1).max(200),
  idea: z.string().max(12000).default(''),
  preferences: z.string().max(4000).default(''),
  kinds: z
    .array(elementKindSchema)
    .min(1)
    .max(8)
    .refine((v) => new Set(v).size === v.length),
  mode: z.enum(['create', 'fill', 'replace', 'extract']).default('fill'),
  targetDocumentId: idSchema.optional(),
  selectedVersionIds: z.array(idSchema).max(100).default([]),
  useDrafts: z.boolean().default(false),
  characterCount: z.int().min(1).max(10).default(3),
  maxCalls: z.int().min(1).max(20).default(12),
  expectedHash: z.string().optional(),
  guided: z.boolean().default(false),
});
export type ElementGenerationInput = z.infer<typeof elementGenerationInputSchema>;
// Keep the original schema readable for stored task history; new requests are single-category.
export const singleElementGenerationInputSchema = elementGenerationInputSchema.refine(
  (input) => input.kinds.length === 1,
  { message: '每次只能生成一个要素分类', path: ['kinds'] },
);
export const elementCandidatePayloadSchema = z.strictObject({
  tempId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  kind: elementKindSchema,
  title: z.string().trim().min(1).max(200),
  targetDocumentId: idSchema.nullable().default(null),
  content: z.string().max(100000).default(''),
  data: elementDataSchema,
  reason: z.string().max(4000).default(''),
  openQuestions: z.array(z.string().max(2000)).max(30).default([]),
});
export const elementBatchSchema = z.strictObject({
  items: z.array(elementCandidatePayloadSchema).min(1).max(30),
});
export const elementGuidanceSchema = z.strictObject({
  reply: z.string().trim().min(1).max(6000),
  question: z.string().trim().min(1).max(2000),
});
export const guidedElementBatchSchema = z.strictObject({
  items: z.array(elementCandidatePayloadSchema).max(10),
  guidance: elementGuidanceSchema,
});
export const basicInformationBatchProposalSchema = z.strictObject({
  items: z
    .array(elementCandidatePayloadSchema.extend({ kind: z.enum(basicInformationKinds) }))
    .min(1)
    .max(10)
    .describe(
      '一次提交本轮所有受影响的设定，可同时包含多个分类、多个已有条目的修改和新增条目。已有条目填写其实际 targetDocumentId，并提供修改后的完整内容；每个目标只出现一次。',
    ),
});
export const elementCandidateSchema = elementCandidatePayloadSchema.extend({
  id: idSchema,
  jobId: idSchema,
  baseVersionId: idSchema.nullable(),
  revision: z.int().positive(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  acceptedDocumentId: idSchema.nullable(),
  acceptedVersionId: idSchema.nullable(),
});
export type ElementCandidate = z.infer<typeof elementCandidateSchema>;
export const elementGenerationSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  input: elementGenerationInputSchema,
  status: z.enum([
    'queued',
    'running',
    'completed',
    'partial',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  stage: z.int().nonnegative(),
  totalStages: z.int().nonnegative(),
  callCount: z.int().nonnegative(),
  runId: idSchema.nullable(),
  error: z.string().nullable(),
  reviewStatus: z.enum(['pending', 'partially_accepted', 'accepted', 'rejected', 'processed']),
  lastEventSeq: z.int().nonnegative(),
  candidates: z.array(elementCandidateSchema),
  guidance: elementGuidanceSchema.nullable().default(null),
  usage: usageTotalSchema,
  createdAt: timestampSchema,
});
export type ElementGeneration = z.infer<typeof elementGenerationSchema>;
export const elementDecisionSchema = z
  .strictObject({
    action: z.enum(['accept', 'reject']),
    candidates: z
      .array(z.strictObject({ id: idSchema, revision: z.int().positive() }))
      .min(1)
      .max(100),
  })
  .refine((v) => new Set(v.candidates.map((c) => c.id)).size === v.candidates.length);

export const elementEntriesSchema = z.array(elementEntrySchema);
export const elementGenerationsSchema = z.array(elementGenerationSchema);
export const elementGenerationPreviewSchema = z.object({
  hash: z.string(),
  totalStages: z.number(),
  estimatedInputTokens: z.number(),
  inputLimit: z.number(),
  sources: z.array(contextEntrySchema.omit({ excerpt: true, metadata: true })),
});
