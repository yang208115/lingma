import { randomUUID } from 'node:crypto';
import {
  type ContextPreview,
  normalizeOutlineMarkdown,
  type OutlineCreationPayload,
  type OutlineCreationProposal,
  outlineCreationProposalSchema,
  type WritingRunInput,
} from '@lingma/shared';
import { AppError } from '../errors.js';
import { canCreateChapters, canCreateOutlines, digest, stable } from './context.js';
import type { WritingStore } from './store.js';
import { assertRunWriteMode } from './write-mode.js';

function proposal(store: WritingStore, id: string): OutlineCreationProposal {
  const row = store.db.prepare('SELECT * FROM outline_creation_proposals WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new AppError('NOT_FOUND', '文档创建候选不存在', 404);
  return outlineCreationProposalSchema.parse({
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    turnIndex: row.turn_index,
    payload: JSON.parse(String(row.payload_json)),
    status: row.status,
    acceptedDocuments: JSON.parse(String(row.accepted_json)),
    createdAt: row.created_at,
  });
}

export function listOutlineProposals(store: WritingStore, runId: string) {
  return (
    store.db
      .prepare('SELECT id FROM outline_creation_proposals WHERE run_id=? ORDER BY rowid')
      .all(runId) as { id: string }[]
  ).map((row) => proposal(store, row.id));
}

export function stageOutlineCreation(
  store: WritingStore,
  runId: string,
  turnIndex: number,
  executionId: string,
  payload: OutlineCreationPayload,
) {
  const run = store.row(runId);
  const input = JSON.parse(String(run.input_json)) as WritingRunInput;
  if (
    !(payload.kind === 'chapter' ? canCreateChapters(input) : canCreateOutlines(input)) ||
    !input.projectId ||
    run.status !== 'running'
  )
    throw new AppError('FORBIDDEN', '本次任务未授权创建此类文档', 403);
  store.novels.getProject(input.projectId);
  if (payload.kind === 'chapter') {
    assertRunWriteMode(store, runId, 'create');
    const chapter = payload.items[0];
    const preview = JSON.parse(String(run.snapshot_json)) as ContextPreview;
    const frozen = JSON.parse(
      String(preview.request.messages.find((message) => message.role === 'user')?.content),
    ) as { volumes?: { id: string }[] };
    if (chapter.volumeId && !frozen.volumes?.some((volume) => volume.id === chapter.volumeId))
      throw new AppError('FORBIDDEN', '所属卷不在本次作品的冻结目录中', 403);
    for (const id of chapter.outlineIds) {
      const ref = store.db
        .prepare('SELECT document_id FROM run_documents WHERE run_id=? AND document_id=?')
        .get(runId, id);
      const document = store.novels.getDocument(id).document;
      if (
        !ref ||
        document.projectId !== input.projectId ||
        document.kind !== 'chapter_outline' ||
        document.archived
      )
        throw new AppError('FORBIDDEN', '关联事件不在本次允许的故事事件中', 403);
    }
  }
  for (const citation of payload.citations)
    if (
      !store.db
        .prepare('SELECT id FROM run_context_entries WHERE run_id=? AND citation_id=?')
        .get(runId, citation)
    )
      throw new AppError('VALIDATION_ERROR', '引用不在本次实际资料中', 400);
  const normalized = {
    ...payload,
    items: payload.items.map((item) => ({
      ...item,
      content: payload.kind === 'chapter' ? item.content : normalizeOutlineMarkdown(item.content),
    })),
  };
  const hash = digest(stable(normalized));
  const previous = store.db
    .prepare('SELECT id FROM outline_creation_proposals WHERE run_id=? AND payload_hash=?')
    .get(runId, hash) as { id: string } | undefined;
  if (previous) return proposal(store, previous.id);
  const id = randomUUID();
  store.db
    .prepare(
      "INSERT INTO outline_creation_proposals(id,run_id,project_id,turn_index,tool_execution_id,payload_json,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?,'staged',?)",
    )
    .run(
      id,
      runId,
      input.projectId,
      turnIndex,
      executionId,
      JSON.stringify(normalized),
      hash,
      new Date().toISOString(),
    );
  return proposal(store, id);
}

export function acceptOutlineCreation(store: WritingStore, id: string, key: string) {
  return store.once(`outline-creation:accept:${id}`, key, {}, () => {
    const item = proposal(store, id);
    if (item.status === 'accepted') return item;
    if (item.status !== 'pending') throw new AppError('FORBIDDEN', '只有待审阅候选可以创建', 403);
    if (item.payload.kind === 'chapter') assertRunWriteMode(store, item.runId, 'create');
    if (['queued', 'running', 'cancelling'].includes(String(store.row(item.runId).status)))
      throw new AppError('PROJECT_BUSY', '请等待本次生成结束后再创建文档', 409);
    store.novels.getProject(item.projectId);
    if (
      item.payload.kind === 'chapter' &&
      store.db
        .prepare(
          "SELECT id FROM runs WHERE project_id=? AND id<>? AND (purpose IN ('write','rewrite') OR json_extract(input_json,'$.allowChapterCreation')=1) AND status IN ('queued','running','cancelling')",
        )
        .get(item.projectId, item.runId)
    )
      throw new AppError('PROJECT_BUSY', '请先结束当前作品的其他写作任务', 409);
    if (
      store.db
        .prepare(
          "SELECT id FROM workflow_runs WHERE project_id=? AND status IN ('queued','running','awaiting_input','awaiting_acceptance','paused','interrupted','failed','limited')",
        )
        .get(item.projectId)
    )
      throw new AppError('PROJECT_BUSY', '请先结束当前作品的协作流程', 409);
    if (
      store.db
        .prepare(
          "SELECT id FROM element_generation_jobs WHERE project_id=? AND status IN ('queued','running')",
        )
        .get(item.projectId)
    )
      throw new AppError('PROJECT_BUSY', '请先结束基本信息生成任务', 409);
    const acceptedDocuments = item.payload.items.map((outline) => {
      const current = store.novels.getProject(item.projectId);
      if ('outlineIds' in outline) {
        for (const id of outline.outlineIds) {
          const document = store.novels.getDocument(id).document;
          const ref = store.db
            .prepare('SELECT version_id FROM run_documents WHERE run_id=? AND document_id=?')
            .get(item.runId, id) as { version_id: string } | undefined;
          if (
            !ref ||
            document.projectId !== item.projectId ||
            document.kind !== 'chapter_outline' ||
            document.archived
          )
            throw new AppError('FORBIDDEN', '关联事件已不可用，请重新生成章节候选', 403);
          if (document.currentVersionId !== ref.version_id)
            throw new AppError('VERSION_CONFLICT', '关联事件已修改，请重新生成章节候选', 409);
        }
      }
      const created = store.novels.createDocument(
        item.projectId,
        {
          baseStructureVersion: current.structureVersion,
          kind: item.payload.kind,
          title: outline.title,
          storyTime: 'storyTime' in outline ? outline.storyTime : undefined,
          summary: 'summary' in outline ? outline.summary : undefined,
          content:
            item.payload.kind === 'chapter'
              ? outline.content
              : normalizeOutlineMarkdown(outline.content),
          chapterId: null,
          volumeId: 'volumeId' in outline ? outline.volumeId : null,
          ...('newVolumeTitle' in outline && outline.newVolumeTitle
            ? { newVolumeTitle: outline.newVolumeTitle }
            : {}),
          metadata:
            item.payload.kind === 'master_outline'
              ? { element: { schemaVersion: 1, nature: 'planned' } }
              : {},
        },
        'proposal',
      );
      if ('outlineIds' in outline) {
        for (const id of new Set(outline.outlineIds)) {
          store.db
            .prepare('INSERT INTO outline_chapters(outline_id,chapter_id,project_id) VALUES(?,?,?)')
            .run(id, created.document.id, item.projectId);
          store.db
            .prepare('UPDATE documents SET chapter_id=COALESCE(chapter_id,?) WHERE id=?')
            .run(created.document.id, id);
        }
      }
      if (item.payload.kind === 'master_outline')
        store.db
          .prepare(
            'INSERT INTO element_confirmations(document_id,confirmed_version_id) VALUES(?,?)',
          )
          .run(created.document.id, created.version.id);
      return { documentId: created.document.id, versionId: created.version.id };
    });
    store.db
      .prepare("UPDATE outline_creation_proposals SET status='accepted',accepted_json=? WHERE id=?")
      .run(JSON.stringify(acceptedDocuments), id);
    return proposal(store, id);
  });
}

export function rejectOutlineCreation(store: WritingStore, id: string) {
  return store.database.transaction(() => {
    const item = proposal(store, id);
    if (item.status === 'rejected') return item;
    if (item.status !== 'pending') throw new AppError('FORBIDDEN', '只有待审阅候选可以拒绝', 403);
    store.db.prepare("UPDATE outline_creation_proposals SET status='rejected' WHERE id=?").run(id);
    return proposal(store, id);
  });
}
