import { type ActionContext, ActionError, ActionRegistry, AgentError } from '@lingma/agent';
import type { ActionArgs, ContextPreview, WritingRunInput } from '@lingma/shared';
import { AppError } from '../errors.js';
import type { SkillService } from '../services/skills.js';
import { decodeSkillText } from '../skills/parse.js';
import { canCreateChapters, canCreateOutlines, canPropose, entry, relevance } from './context.js';
import { stageOutlineCreation } from './outlines.js';
import { decode, type Row, type WritingStore } from './store.js';

export function actualActions(
  store: WritingStore,
  runId: string,
  skills: SkillService,
): ActionRegistry {
  const input = decode<WritingRunInput>(store.row(runId).input_json);
  const preview = decode<ContextPreview>(store.row(runId).snapshot_json);
  const skillSource = (versionId: string) => {
    const ref = preview.skills?.find((skill) => skill.versionId === versionId);
    if (!ref) throw new AgentError('FORBIDDEN');
    return ref;
  };
  const source = (documentId: string, versionId: string) => {
    const ref = store.db
      .prepare('SELECT * FROM run_documents WHERE run_id=? AND document_id=? AND version_id=?')
      .get(runId, documentId, versionId) as Row | undefined;
    if (!ref) throw new AgentError('FORBIDDEN');
    const doc = store.novels.getDocument(documentId, true).document;
    if (doc.projectId !== input.projectId) throw new AgentError('FORBIDDEN');
    return {
      ref,
      doc,
      version: store.novels.getVersion(documentId, versionId, input.projectId ?? undefined),
    };
  };
  const execute = <T>(context: ActionContext, fn: () => T): T => {
    context.signal.throwIfAborted();
    try {
      return store.database.transaction(() => ({ value: fn() })).value;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (error instanceof AppError) throw new ActionError(error.code, error.message);
      throw new AgentError('STORAGE_ERROR');
    }
  };
  return new ActionRegistry({
    ...(canCreateChapters(input)
      ? {
          propose_chapter_creation: (
            args: ActionArgs<'propose_chapter_creation'>,
            context: ActionContext,
          ) =>
            execute(context, () => {
              const { reason, citations, ...chapter } = args;
              const item = stageOutlineCreation(
                store,
                runId,
                context.turnIndex,
                context.executionId,
                {
                  kind: 'chapter',
                  items: [chapter],
                  reason,
                  citations,
                },
              );
              return { proposalId: item.id, status: 'staged' as const };
            }),
        }
      : {}),
    ...(canCreateOutlines(input)
      ? {
          propose_master_outline: (
            args: ActionArgs<'propose_master_outline'>,
            context: ActionContext,
          ) =>
            execute(context, () => {
              const item = stageOutlineCreation(
                store,
                runId,
                context.turnIndex,
                context.executionId,
                {
                  kind: 'master_outline',
                  items: [{ title: args.title, content: args.content }],
                  reason: args.reason,
                  citations: args.citations,
                },
              );
              return { proposalId: item.id, status: 'staged' as const };
            }),
          propose_chapter_outlines: (
            args: ActionArgs<'propose_chapter_outlines'>,
            context: ActionContext,
          ) =>
            execute(context, () => {
              const item = stageOutlineCreation(
                store,
                runId,
                context.turnIndex,
                context.executionId,
                { ...args, kind: 'chapter_outline' },
              );
              return {
                proposalId: item.id,
                chapterCount: item.payload.items.length,
                status: 'staged' as const,
              };
            }),
        }
      : {}),
    ...(preview.skills?.length
      ? {
          load_skill: (args: ActionArgs<'load_skill'>, context: ActionContext) =>
            execute(context, () => {
              const ref = skillSource(args.versionId);
              const detail = skills.detail(ref.skillId, ref.versionId);
              return {
                skillId: ref.skillId,
                versionId: ref.versionId,
                name: ref.name,
                content: detail.version.entryContent,
                files: detail.version.files.map((file) => file.relativePath),
                warnings: [
                  ...detail.parsed.warnings,
                  ...detail.parsed.missingFiles.map((path) => `Skill 关联文件缺失：${path}`),
                ],
              };
            }),
          read_skill_file: async (args: ActionArgs<'read_skill_file'>, context: ActionContext) => {
            context.signal.throwIfAborted();
            const ref = skillSource(args.versionId);
            try {
              const { file, bytes } = await skills.file(ref.skillId, ref.versionId, args.path);
              context.signal.throwIfAborted();
              if (!file.mediaType.startsWith('text/')) throw new AgentError('VALIDATION_ERROR');
              const text = decodeSkillText(bytes);
              const from = args.range?.from ?? 0;
              const requestedTo = args.range?.to ?? text.length;
              if (from > text.length || requestedTo > text.length)
                throw new AgentError('VALIDATION_ERROR');
              const to = Math.min(requestedTo, from + 8000);
              return {
                versionId: ref.versionId,
                path: file.relativePath,
                content: text.slice(from, to),
                from,
                to,
                totalChars: text.length,
                truncated: to < requestedTo,
              };
            } catch (error) {
              if (error instanceof AppError) throw new AgentError(error.code);
              throw error;
            }
          },
        }
      : {}),
    read_document: (args, context) =>
      execute(context, () => {
        const { doc, version } = source(args.documentId, args.versionId);
        const from = args.range?.from ?? 0,
          requestedTo = args.range?.to ?? version.content.length;
        if (from > version.content.length || requestedTo > version.content.length)
          throw new AgentError('VALIDATION_ERROR');
        const to = Math.min(requestedTo, from + 8000);
        const result = entry(doc, version, from, to, false, '动作读取');
        return {
          citationId: result.citationId,
          documentId: doc.id,
          versionId: version.id,
          excerpt: result.excerpt,
          contentHash: version.contentHash,
          metadata: version.metadata,
          from,
          to,
          truncated: to < requestedTo,
        };
      }),
    ...(input.context.allowSearch
      ? {
          search_documents: (args: ActionArgs<'search_documents'>, context: ActionContext) =>
            execute(context, () => {
              const preview = decode<ContextPreview>(store.row(runId).snapshot_json);
              const matches = preview.allowed
                .filter((ref) => !args.kinds || args.kinds.includes(ref.kind as 'chapter'))
                .map((ref) => {
                  const found = source(ref.documentId, ref.versionId);
                  return {
                    ...found,
                    score: relevance(
                      `${found.doc.title}\n${found.version.content}\n${JSON.stringify(found.version.metadata)}`,
                      args.query,
                    ),
                  };
                })
                .filter((found) => found.score > 0)
                .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
                .slice(0, args.limit)
                .map((found) => {
                  const query = args.query.slice(0, 20);
                  const hit = found.version.content.indexOf(query);
                  const from = Math.max(0, hit - 300),
                    to = Math.min(found.version.content.length, from + 1600);
                  const result = entry(found.doc, found.version, from, to, false, '中文检索');
                  return {
                    citationId: result.citationId,
                    documentId: found.doc.id,
                    versionId: found.version.id,
                    excerpt: result.excerpt,
                    contentHash: found.version.contentHash,
                    metadata: found.version.metadata,
                  };
                });
              return { matches };
            }),
        }
      : {}),
    ...(canPropose(input) && input.target
      ? {
          propose_document_change: (
            args: ActionArgs<'propose_document_change'>,
            context: ActionContext,
          ) =>
            execute(context, () => {
              const target = input.target;
              if (!target)
                throw new ActionError(
                  'FORBIDDEN',
                  '本次运行没有授权修改目标，请由作者指定目标后新建任务。',
                );
              const found = source(target.documentId, target.baseVersionId);
              if (found.ref.permission !== 'propose')
                throw new ActionError(
                  'FORBIDDEN',
                  '当前目标未授权修改，请由作者开启目标修改权限后新建任务。',
                );
              if (args.content.length > 1_000_000)
                throw new ActionError(
                  'VALIDATION_ERROR',
                  'content 超过文档支持的 100 万 UTF-16 字符，请缩减替换文本。',
                );
              for (const [index, citation] of args.citations.entries())
                if (
                  !store.db
                    .prepare('SELECT id FROM run_context_entries WHERE run_id=? AND citation_id=?')
                    .get(runId, citation)
                )
                  throw new ActionError(
                    'VALIDATION_ERROR',
                    `citations[${index}] 不是本次运行已提供的引用。请逐字复制当前输入或成功读取、检索结果中的 citationId；没有引用时传 []。`,
                  );
              const proposal = store.insertProposal(
                {
                  runId,
                  turnIndex: context.turnIndex,
                  targetDocumentId: target.documentId,
                  baseVersionId: target.baseVersionId,
                  scope: target.selection
                    ? { kind: 'selection', selection: target.selection }
                    : { kind: 'document' },
                  content: args.content,
                  reason: args.reason,
                  citations: args.citations,
                  origin: 'tool',
                },
                context.executionId,
              );
              return {
                proposalId: proposal.id,
                targetDocumentId: target.documentId,
                status: 'staged' as const,
              };
            }),
        }
      : {}),
  });
}
