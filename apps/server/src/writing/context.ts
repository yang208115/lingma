import { createHash } from 'node:crypto';
import { ActionRegistry, type ModelRequest } from '@lingma/agent';
import {
  type ContextEntry,
  type ContextPreview,
  contextPreviewSchema,
  type Document,
  isElementKind,
  isStoryEventKind,
  linkedChapterIds,
  orderedChapters,
  readElementData,
  type SkillCatalogEntry,
  visibleWritingTask,
  type WritingRunInput,
} from '@lingma/shared';
import { AppError } from '../errors.js';
import type { NovelService } from '../services/novels.js';
import type { SkillService } from '../services/skills.js';
import { estimateTokens } from './estimate.js';
import type { AgentPromptService } from './prompt.js';
import type { ProviderService } from './providers.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function stable(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(value));
}
export function terms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((word) =>
        /\p{Script=Han}/u.test(word)
          ? Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2))
          : [word],
      ),
    ),
  ].slice(0, 64);
}
export function relevance(text: string, query: string) {
  const haystack = text.toLowerCase();
  return terms(query).reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
export function entry(
  doc: Document,
  version: ReturnType<NovelService['getVersion']>,
  from: number,
  to: number,
  selected = false,
  reason = '允许检索',
): ContextEntry {
  return {
    citationId: `doc:${doc.id}@${version.id}#${from}-${to}`,
    documentId: doc.id,
    versionId: version.id,
    title: doc.title,
    kind: doc.kind,
    contentHash: version.contentHash,
    excerpt: version.content.slice(from, to),
    from,
    to,
    selected,
    reason,
    planning:
      doc.kind === 'chapter_outline' ||
      doc.kind === 'chapter_plan' ||
      (isElementKind(doc.kind) &&
        Boolean(version.metadata.element) &&
        readElementData(version.metadata).nature === 'planned'),
    metadata:
      isStoryEventKind(doc.kind) || doc.kind === 'chapter_plan'
        ? {
            ...version.metadata,
            storyEvent: {
              storyTime: doc.storyTime ?? '',
              summary: doc.summary ?? '',
              chapterIds: linkedChapterIds(doc),
              parentOutlineId: doc.parentOutlineId ?? null,
              volumeId: doc.volumeId,
            },
          }
        : version.metadata,
  };
}
export function canPropose(input: WritingRunInput) {
  return (
    input.purpose === 'write' ||
    input.purpose === 'rewrite' ||
    (input.purpose === 'review' && input.allowTargetProposal)
  );
}
export function canCreateOutlines(input: WritingRunInput) {
  return (
    input.purpose === 'review' && Boolean(input.projectId) && input.allowOutlineCreation === true
  );
}
export function canCreateChapters(input: WritingRunInput) {
  return (
    Boolean(input.projectId) &&
    input.allowChapterCreation === true &&
    ['write', 'review'].includes(input.purpose) &&
    !input.allowOutlineCreation
  );
}
export class ContextService {
  constructor(
    private readonly novels: NovelService,
    private readonly skills: SkillService,
    private readonly providers: ProviderService,
    private readonly prompt: AgentPromptService,
  ) {}
  async prepare(
    input: WritingRunInput,
    options?: { skills: SkillCatalogEntry[] },
  ): Promise<ContextPreview> {
    const agentPrompt = this.prompt.get();
    const provider = this.providers.get(input.providerConfigId);
    if (provider.config.modelId !== input.modelId)
      throw new AppError('VALIDATION_ERROR', '模型必须与配置一致', 400);
    const skills =
      options?.skills ?? this.skills.catalog(input.skillVersionId, input.projectId ?? undefined);
    const target = input.target
      ? this.novels.assertVersion(input.target.documentId, input.target.baseVersionId)
      : null;
    if (target && target.document.projectId !== input.projectId)
      throw new AppError('FORBIDDEN', '目标不属于当前作品', 403);
    if (
      target &&
      ['write', 'rewrite'].includes(input.purpose) &&
      target.document.kind !== 'chapter'
    )
      throw new AppError('VALIDATION_ERROR', '写作目标必须是正文', 400);
    if (input.target?.selection && target) {
      const range = input.target.selection;
      if (
        range.to > target.version.content.length ||
        digest(target.version.content.slice(range.from, range.to)) !== range.textHash
      )
        throw new AppError('VERSION_CONFLICT', '选区与已保存版本不一致，请重新选择', 409);
    }
    const structure = input.projectId ? this.novels.getStructure(input.projectId) : null;
    const chapters = structure ? orderedChapters(structure).map((doc) => doc.id) : [];
    const targetIndex = target ? chapters.indexOf(target.document.id) : -1;
    const explicit = new Set([
      ...input.context.selectedVersionIds,
      ...(input.context.allowedVersionIds ?? []),
    ]);
    const explicitDocs = new Set(
      [...explicit].map(
        (id) =>
          (
            this.novels.database.connection
              .prepare('SELECT document_id FROM document_versions WHERE id=?')
              .get(id) as { document_id: string } | undefined
          )?.document_id,
      ),
    );
    const eligible = (structure?.documents ?? [])
      .flatMap((doc) => {
        if (!isElementKind(doc.kind) || doc.id === target?.document.id) return [doc];
        const current = this.novels.getVersion(doc.id, doc.currentVersionId);
        if (readElementData(current.metadata).archived) return [];
        const confirmed = this.novels.confirmedVersionId(doc);
        if (!confirmed && !explicitDocs.has(doc.id)) return [];
        return [{ ...doc, currentVersionId: confirmed ?? doc.currentVersionId }];
      })
      .filter((doc) => {
        if (doc.id === target?.document.id) return true;
        const version = isElementKind(doc.kind)
          ? this.novels.getVersion(doc.id, doc.currentVersionId)
          : null;
        if (
          version?.metadata.element &&
          readElementData(version.metadata).nature === 'planned' &&
          !input.context.allowFutureOutline
        )
          return false;
        const related = doc.kind === 'chapter' ? [doc.id] : linkedChapterIds(doc);
        const future = targetIndex >= 0 && related.some((id) => chapters.indexOf(id) > targetIndex);
        if (doc.kind === 'chapter' && future) return false;
        if (
          (doc.kind === 'chapter_outline' ||
            doc.kind === 'chapter_plan' ||
            (doc.kind === 'timeline_event' &&
              (!version?.metadata.element ||
                readElementData(version.metadata).nature === 'planned'))) &&
          !input.context.allowFutureOutline &&
          (!related.length || future || targetIndex < 0)
        )
          return false;
        return true;
      });
    const candidates = new Map(eligible.map((doc) => [doc.currentVersionId, doc]));
    // Explicit versions may refer to an older immutable version of an eligible document.
    for (const versionId of [
      ...input.context.selectedVersionIds,
      ...(input.context.allowedVersionIds ?? []),
    ]) {
      if (candidates.has(versionId)) continue;
      const owner = this.novels.database.connection
        .prepare('SELECT document_id FROM document_versions WHERE id=?')
        .get(versionId) as { document_id: string } | undefined;
      const doc = eligible.find((doc) => doc.id === owner?.document_id);
      if (!doc) throw new AppError('FORBIDDEN', '资料版本不在当前允许范围', 403);
      candidates.set(versionId, doc);
    }
    const overrides = new Map(
      input.context.selectedVersionIds.map((id) => [candidates.get(id)?.id, id]),
    );
    const scope =
      input.context.allowedVersionIds ??
      eligible.map((doc) => overrides.get(doc.id) ?? doc.currentVersionId);
    const ids = [
      ...new Set([
        ...scope,
        ...input.context.selectedVersionIds,
        ...(target ? [target.version.id] : []),
      ]),
    ];
    if (ids.length > 1000)
      throw new AppError(
        'CONTEXT_TOO_LARGE',
        '单次允许资料最多 1000 份，请指定更小的允许范围',
        422,
      );
    const seen = new Set<string>();
    let frozenChars = 0;
    const allowed = ids.map((id) => {
      const doc = candidates.get(id);
      if (!doc || seen.has(doc.id))
        throw new AppError('VALIDATION_ERROR', '同一文档只能固定一个允许版本', 400);
      seen.add(doc.id);
      const version = this.novels.getVersion(doc.id, id);
      if (
        version.metadata.element &&
        readElementData(version.metadata).nature === 'planned' &&
        !input.context.allowFutureOutline
      )
        throw new AppError('FORBIDDEN', '未来规划需要明确授权', 403);
      frozenChars += version.content.length + JSON.stringify(version.metadata).length;
      if (frozenChars > 8_000_000)
        throw new AppError(
          'CONTEXT_TOO_LARGE',
          '允许检索的资料总量超过 800 万字符，请缩小允许范围',
          422,
        );
      return { doc, version };
    });
    const pinned = new Set([
      ...input.context.selectedVersionIds,
      ...(target ? [target.version.id] : []),
    ]);
    const query = `${input.input}\n${target?.version.content.slice(0, 8000) ?? ''}`;
    const ranked = allowed
      .map((source) => {
        const element = source.version.metadata.element
          ? readElementData(source.version.metadata)
          : null;
        const aliases = Object.values(source.version.metadata)
          .flat()
          .filter((v) => typeof v === 'string');
        aliases.push(...(element?.fields.aliases?.split(/[,，、\s]+/).filter(Boolean) ?? []));
        const nameMatch = [source.doc.title, ...aliases].some((v) => query.includes(String(v)))
          ? 30
          : 0;
        const relation = linkedChapterIds(source.doc).includes(target?.document.id ?? '') ? 40 : 0;
        const index = chapters.indexOf(source.doc.id);
        const adjacent =
          targetIndex >= 0 && index >= 0 && index < targetIndex && index >= targetIndex - 2
            ? 20
            : 0;
        return {
          ...source,
          score:
            nameMatch +
            relation +
            adjacent +
            relevance(
              `${source.version.content.slice(0, 8000)}\n${element?.summary ?? ''}\n${Object.values(element?.fields ?? {}).join('\n')}`,
              query,
            ),
          reason: relation
            ? '当前章节关联事件（规划）'
            : nameMatch
              ? '姓名/别名匹配'
              : adjacent
                ? '相邻前文'
                : '中文关键词匹配',
        };
      })
      .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
    const warnings: string[] = [];
    const names = allowed.map((source) => ({
      documentId: source.doc.id,
      versionId: source.version.id,
      title: source.doc.title,
      kind: source.doc.kind,
      planning: entry(source.doc, source.version, 0, 0).planning,
    }));
    const volumes = (structure?.volumes ?? []).map((volume) => ({
      id: volume.id,
      title: volume.title,
      chapterIds: allowed
        .filter((source) => source.doc.kind === 'chapter' && source.doc.volumeId === volume.id)
        .map((source) => source.doc.id),
    }));
    const references = (input.context.references ?? []).map((ref) => {
      if (ref.type === 'volume') {
        const volume = volumes.find((item) => item.id === ref.id);
        if (!volume) throw new AppError('FORBIDDEN', '引用的卷不属于当前作品或已删除', 403);
        return { ...ref, title: volume.title };
      }
      const document = names.find((item) => item.documentId === ref.id);
      if (!document || !input.context.selectedVersionIds.includes(document.versionId))
        throw new AppError('FORBIDDEN', '引用的资料未固定到本次允许的版本，请重新引用', 403);
      return { ...ref, title: document.title, versionId: document.versionId };
    });
    const history = input.sessionId
      ? (
          this.novels.database.connection
            .prepare(
              "SELECT m.role,m.content FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.session_id=? AND r.status='completed' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 20",
            )
            .all(input.sessionId) as { role: string; content: string }[]
        )
          .reverse()
          .map((message) => ({
            ...message,
            content:
              message.role === 'user' ? visibleWritingTask(message.content) : message.content,
          }))
      : [];
    const request: ModelRequest = {
      connectionSnapshot: provider.config.connection,
      modelId: input.modelId,
      systemPrompt: `${agentPrompt.prompt}
正式文档内容只能通过本次明确提供的文档工具提交，最终聊天回复仅用于说明结果，不能作为正文候选。同一次运行中，新建正文章节与修改已有文档互斥（重试延续原运行的选择）；提交其中一种后不要调用另一种，需要另一种操作时请作者另发任务。不要把操作说明、完成报告或候选摘要填入正文 content。
${references.length ? '作者输入中的 @【标签】对应下方 references 中的具体卷或资料。以 ID 和 versionId 绑定的真实对象为准，同名资料不可混用；卷目录只提供结构，文档正文以 context 或成功读取的冻结版本为准。' : ''}
${canCreateChapters(input) ? '本次可以新建正文章节。作者要求新建章节、创作新一章或当前没有正文目标而要求写作时，调用 propose_chapter_creation，自行拟定章节标题，参考作者 @ 引用的卷和资料确定所属卷与内容；volumes 是冻结的卷目录，references 将输入中的引用标签绑定到真实卷或资料 ID，不要猜测或拼接 ID。已有卷用 volumeId；引用的是尚未建卷的分卷大纲时可用其标题填写 newVolumeTitle。仅新建时正文可为空，要求写作时提交完整正文；等待作者确认后才创建。续写或修改当前已有正文使用 propose_document_change。不要只在聊天里给出标题或正文代替候选。' : ''}
${canCreateOutlines(input) ? '当前是故事大纲与时间线规划。参考基本信息与已有大纲，区分未来规划和已发生事实。用户要求生成、创建或撰写故事总纲时，调用 propose_master_outline，提交完整总纲，涵盖故事起点、主线推进、人物弧线、主要转折、高潮与结局；没有选中文档、尚无总纲或当前选中的是事件时也能创建总纲，不需要先建正文。用户要求修改当前选中的已有总纲或事件时，调用 propose_document_change，仅修改当前目标。用户要求修改其他已有总纲时，提示先选中该总纲，不要新建副本代替修改。用户要求创建大纲事件、规划时间线、拆分总纲为事件时，调用 propose_chapter_outlines，items 按故事实际发生顺序给出每个大事件的 title、content 完整大纲，可填写 storyTime 和 summary。一个事件可以跨多个章节，不要默认按一章一个事件拆分。不能用文字回答代替创建候选，也不要把所有事件塞进当前总纲；等待作者确认后才保存总纲或添加事件。没有选中文档时也能创建事件。不要创建或撰写小说正文。用户要求批量创建单章章纲时，引导使用大纲页的“AI 拆分章纲”，由分章规划工作流生成独立章纲，不要将章纲保存为故事事件。用户只讨论时直接回答。' : ''}
${input.purpose === 'write' || input.purpose === 'rewrite' ? '提交正文候选前，核对场景先后顺序、人物实际已知信息和时间表述的一致性；不可把作者设定当成人物已经验证的知识。除非作者明确要求，正文候选不要重复章节标题，也不要包裹代码块。' : ''}
${input.skillVersionId ? `本次明确指定的 Skill 版本为 ${input.skillVersionId}，请先加载该版本。\n` : ''}
可用 Skill 目录（JSON 数据）：
${JSON.stringify(skills)}`,
      messages: [],
      toolDefinitions: [],
      parameters: Object.fromEntries(
        Object.entries(provider.config.parameters).filter(
          (pair): pair is [string, number] => pair[1] !== undefined,
        ),
      ),
    };
    const registry = new ActionRegistry({
      ...(canCreateChapters(input)
        ? {
            propose_chapter_creation: () => {
              throw new Error();
            },
          }
        : {}),
      ...(canCreateOutlines(input)
        ? {
            propose_master_outline: () => {
              throw new Error();
            },
            propose_chapter_outlines: () => {
              throw new Error();
            },
          }
        : {}),
      ...(skills.length
        ? {
            load_skill: () => {
              throw new Error();
            },
            read_skill_file: () => {
              throw new Error();
            },
          }
        : {}),
      read_document: () => {
        throw new Error();
      },
      ...(input.context.allowSearch ? { search_documents: () => ({ matches: [] }) } : {}),
      ...(canPropose(input) && input.target
        ? {
            propose_document_change: () => {
              throw new Error();
            },
          }
        : {}),
    });
    request.toolDefinitions = registry.definitions();
    const entries: ContextEntry[] = [];
    const setMessage = () => {
      request.messages = [
        {
          role: 'user',
          timestamp: 0,
          content: JSON.stringify({
            task: input.input,
            purpose: input.purpose,
            target: input.target ?? null,
            history,
            allowedDocuments: names,
            volumes,
            references,
            context: entries,
          }),
        },
      ];
    };
    const output = Math.min(
      provider.config.parameters.maxTokens ?? provider.config.connection.maxOutputTokens,
      provider.config.connection.maxOutputTokens,
    );
    const limit = Math.floor(provider.config.connection.contextWindow * 0.85) - output;
    const estimate = () => {
      setMessage();
      return estimateTokens(request);
    };
    for (const source of ranked.filter((source) => pinned.has(source.version.id))) {
      const selection =
        source.doc.id === target?.document.id &&
        !input.context.selectedVersionIds.includes(source.version.id)
          ? input.target?.selection
          : undefined;
      entries.push(
        entry(
          source.doc,
          source.version,
          selection ? Math.max(0, selection.from - 1000) : 0,
          selection
            ? Math.min(source.version.content.length, selection.to + 1000)
            : source.version.content.length,
          true,
          selection ? '选区及相邻上下文' : '作者固定/目标',
        ),
      );
    }
    if (limit <= 0 || estimate() > limit)
      throw new AppError(
        'CONTEXT_TOO_LARGE',
        '固定资料、Skill 或会话超过保守上下文预算，请缩减固定内容或新建会话',
        422,
      );
    const omitted: string[] = [];
    for (const source of ranked.filter((source) => !pinned.has(source.version.id))) {
      const item = entry(
        source.doc,
        source.version,
        0,
        Math.min(source.version.content.length, 2000),
        false,
        source.reason,
      );
      entries.push(item);
      if (estimate() > limit) {
        entries.pop();
        omitted.push(`${source.doc.title}：推荐片段超出预算`);
      }
    }
    const estimatedInputTokens = estimate();
    if (JSON.stringify(request).length > 3_000_000)
      throw new AppError('CONTEXT_TOO_LARGE', '实际输入超过运行大小限制', 422);
    const preview = {
      agentPromptRevision: agentPrompt.revision,
      skills,
      entries,
      allowed: allowed.map((source) => {
        const {
          excerpt: _,
          metadata: _metadata,
          ...ref
        } = entry(
          source.doc,
          source.version,
          0,
          source.version.content.length,
          pinned.has(source.version.id),
        );
        return ref;
      }),
      omitted,
      warnings,
      estimatedInputTokens,
      reservedOutputTokens: output,
      inputLimit: limit,
      estimated: true as const,
      request,
    };
    return contextPreviewSchema.parse({ ...preview, hash: digest(stable(preview)) });
  }
}
