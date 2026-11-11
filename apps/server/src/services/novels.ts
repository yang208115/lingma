import { createHash, randomUUID } from 'node:crypto';
import {
  type ConfirmImport,
  type CreateDocument,
  type Document,
  type DocumentDetail,
  type DocumentVersion,
  documentDetailSchema,
  documentSchema,
  documentVersionSchema,
  type ImportResult,
  isElementKind,
  isStoryEventKind,
  isWritingPlanKind,
  linkedChapterIds,
  metadataSchema,
  type NovelSave,
  orderedChapters,
  type Project,
  type PutStructure,
  projectSchema,
  readElementData,
  type StartOutlineWriting,
  type Structure,
  type UpdateChapterPlan,
  type UpdateStoryEvent,
  validateElementFields,
  volumeSchema,
} from '@lingma/shared';
import type { WorkbenchDatabase } from '../db/database.js';
import { AppError } from '../errors.js';

type Row = Record<string, unknown>;
const documentSelect = `SELECT d.*,
  json_extract(v.metadata_json,'$.element.fields.time') AS legacy_story_time,
  json_extract(v.metadata_json,'$.element.summary') AS element_summary,
  json_extract(v.metadata_json,'$.element.archived') AS element_archived, (
  SELECT json_group_array(oc.chapter_id) FROM outline_chapters oc
  JOIN documents c ON c.id=oc.chapter_id AND c.deleted_at IS NULL
  WHERE oc.outline_id=d.id
) AS chapter_ids FROM documents d JOIN document_versions v ON v.id=d.current_version_id`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function project(row: Row): Project {
  return projectSchema.parse({
    id: row.id,
    title: row.title,
    format: row.format ?? 'long',
    setupCompleted: row.setup_completed === undefined || row.setup_completed === 1,
    structureVersion: row.structure_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
function document(row: Row): Document {
  return documentSchema.parse({
    id: row.id,
    projectId: row.project_id,
    volumeId: row.volume_id,
    kind: row.kind,
    chapterId: row.chapter_id,
    chapterIds: JSON.parse(String(row.chapter_ids ?? '[]')),
    parentOutlineId: row.parent_outline_id ?? null,
    storyTime:
      row.kind === 'timeline_event' ? String(row.legacy_story_time ?? '') : (row.story_time ?? ''),
    summary:
      row.kind === 'timeline_event' ? String(row.element_summary ?? '') : (row.summary ?? ''),
    archived: Boolean(row.element_archived),
    title: row.title,
    sortOrder: row.sort_order,
    currentVersionId: row.current_version_id,
    deletedAt: row.deleted_at,
  });
}
function version(row: Row): DocumentVersion {
  return documentVersionSchema.parse({
    id: row.id,
    documentId: row.document_id,
    versionNo: row.version_no,
    content: row.content,
    metadata: JSON.parse(String(row.metadata_json)),
    contentHash: row.content_hash,
    source: row.source,
    createdAt: row.created_at,
  });
}

export class NovelService {
  constructor(readonly database: WorkbenchDatabase) {}
  private get db() {
    return this.database.connection;
  }
  confirmedVersionId(doc: Document): string | null {
    if (!isElementKind(doc.kind)) return null;
    const row = this.db
      .prepare('SELECT confirmed_version_id FROM element_confirmations WHERE document_id=?')
      .get(doc.id) as { confirmed_version_id: string } | undefined;
    return row?.confirmed_version_id ?? null;
  }
  validateElement(projectId: string, kind: string, metadata: DocumentVersion['metadata']): void {
    metadataSchema.parse(metadata);
    if (!isElementKind(kind) || !metadata.element) return;
    const data = readElementData(metadata);
    try {
      validateElementFields(kind, data);
    } catch (error) {
      throw new AppError(
        'VALIDATION_ERROR',
        error instanceof Error ? error.message : '要素字段无效',
        400,
      );
    }
    for (const link of data.links) {
      const target = this.getDocument(link.targetId).document;
      if (target.projectId !== projectId)
        throw new AppError('FORBIDDEN', '关联必须属于当前作品', 403);
    }
    for (const source of data.sources) {
      const version = this.getVersion(source.documentId, source.versionId, projectId);
      if (source.to > version.content.length)
        throw new AppError('VALIDATION_ERROR', '来源片段超出文档范围', 400);
    }
  }
  getProject(id: string, includeDeleted = false): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    if (!row || (!includeDeleted && row.deleted_at))
      throw new AppError('NOT_FOUND', '作品不存在或已移入回收站', 404);
    return project(row);
  }
  listProjects(
    limit: number,
    cursor?: string,
    deleted = false,
  ): { data: Project[]; nextCursor: string | null } {
    const rows = this.db
      .prepare(
        `SELECT * FROM projects WHERE deleted_at IS ${deleted ? 'NOT ' : ''}NULL AND id > ? ORDER BY id LIMIT ?`,
      )
      .all(cursor ?? '', limit + 1) as Row[];
    return {
      data: rows.slice(0, limit).map(project),
      nextCursor: rows.length > limit ? String(rows[limit - 1]?.id) : null,
    };
  }
  createProject(title: string, format: Project['format'] = 'long'): Project {
    return this.database.transaction((db) => {
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO projects(id,title,format,setup_completed,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      ).run(id, title, format, Number(format === 'short'), now, now);
      if (format === 'short')
        this.createDocument(id, {
          baseStructureVersion: 1,
          kind: 'chapter',
          title: '正文',
          volumeId: null,
          chapterId: null,
          content: '',
          metadata: {},
        });
      return this.getProject(id);
    });
  }
  completeProjectSetup(id: string, base: number): Project {
    return this.database.transaction((db) => {
      const current = this.checkStructure(id, base);
      if (!current.setupCompleted) {
        db.prepare('UPDATE projects SET setup_completed=1 WHERE id=?').run(id);
        this.bump(id);
      }
      return this.getProject(id);
    });
  }
  deleteProject(id: string, base: number): Project {
    return this.database.transaction((db) => {
      this.checkStructure(id, base);
      const running = db
        .prepare(`
        SELECT id FROM runs WHERE project_id=? AND status IN ('queued','running','cancelling')
        UNION ALL SELECT id FROM element_generation_jobs WHERE project_id=? AND status IN ('queued','running')
        UNION ALL SELECT id FROM workflow_runs WHERE project_id=? AND status IN ('queued','running')
        LIMIT 1
      `)
        .get(id, id, id);
      if (running)
        throw new AppError(
          'PROJECT_BUSY',
          '作品仍有正在运行的 AI 任务，请先停止或等待结束后删除',
          409,
        );
      db.prepare('UPDATE projects SET deleted_at=? WHERE id=?').run(new Date().toISOString(), id);
      this.bump(id);
      return this.getProject(id, true);
    });
  }
  restoreProject(id: string): Project {
    return this.database.transaction((db) => {
      this.getProject(id, true);
      const result = db
        .prepare('UPDATE projects SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL')
        .run(id);
      if (result.changes) this.bump(id);
      return this.getProject(id);
    });
  }
  private checkStructure(id: string, base: number): Project {
    const current = this.getProject(id);
    if (current.structureVersion !== base)
      throw new AppError('VERSION_CONFLICT', '卷章目录已变化，请刷新目录后重试', 409, {
        currentStructureVersion: current.structureVersion,
      });
    return current;
  }
  private bump(id: string): void {
    this.db
      .prepare('UPDATE projects SET structure_version=structure_version+1, updated_at=? WHERE id=?')
      .run(new Date().toISOString(), id);
  }
  renameProject(id: string, title: string, base: number): Project {
    return this.database.transaction((db) => {
      this.checkStructure(id, base);
      db.prepare('UPDATE projects SET title=? WHERE id=?').run(title, id);
      this.bump(id);
      return this.getProject(id);
    });
  }
  getStructure(id: string): Structure {
    return this.db.transaction(() => ({
      project: this.getProject(id),
      volumes: (
        this.db
          .prepare('SELECT * FROM volumes WHERE project_id=? ORDER BY sort_order,id')
          .all(id) as Row[]
      ).map((row) =>
        volumeSchema.parse({
          id: row.id,
          projectId: row.project_id,
          title: row.title,
          sortOrder: row.sort_order,
        }),
      ),
      documents: (
        this.db
          .prepare(
            `${documentSelect} WHERE d.project_id=? AND d.deleted_at IS NULL ORDER BY d.sort_order,d.id`,
          )
          .all(id) as Row[]
      ).map(document),
    }))();
  }
  putStructure(id: string, input: PutStructure): Structure {
    return this.database.transaction((db) => {
      this.checkStructure(id, input.baseStructureVersion);
      const current = this.getStructure(id);
      const ids = new Set(input.documents.map((item) => item.id));
      if (
        current.documents.length !== ids.size ||
        current.documents.some((item) => !ids.has(item.id))
      )
        throw new AppError('VALIDATION_ERROR', '目录必须完整包含本作品全部未删除文档', 400);
      const volumeIds = new Set(input.volumes.map((item) => item.id));
      for (const volume of input.volumes) {
        const existing = db.prepare('SELECT project_id FROM volumes WHERE id=?').get(volume.id) as
          | Row
          | undefined;
        if (existing && existing.project_id !== id)
          throw new AppError('FORBIDDEN', '卷不属于当前作品', 403);
        db.prepare(
          'INSERT INTO volumes(id,project_id,title,sort_order) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,sort_order=excluded.sort_order',
        ).run(volume.id, id, volume.title, volume.sortOrder);
      }
      for (const item of input.documents) {
        const original = current.documents.find((entry) => entry.id === item.id);
        if (
          (item.volumeId && !volumeIds.has(item.volumeId)) ||
          (!['chapter', 'chapter_plan'].includes(original?.kind ?? '') && item.volumeId !== null)
        )
          throw new AppError('VALIDATION_ERROR', '只有正文或章纲可以关联本作品的卷', 400);
        db.prepare(
          'UPDATE documents SET title=?,volume_id=?,sort_order=? WHERE id=? AND project_id=?',
        ).run(item.title, item.volumeId, item.sortOrder, item.id, id);
      }
      // Detach deleted chapters before removing their old volume; preserve their content/history.
      for (const removed of current.volumes.filter((item) => !volumeIds.has(item.id))) {
        db.prepare(
          'UPDATE documents SET volume_id=NULL WHERE volume_id=? AND deleted_at IS NOT NULL',
        ).run(removed.id);
        db.prepare('DELETE FROM volumes WHERE id=? AND project_id=?').run(removed.id, id);
      }
      this.bump(id);
      return this.getStructure(id);
    });
  }
  private ownVolume(projectId: string, volumeId: string | null): void {
    if (
      volumeId &&
      !this.db
        .prepare('SELECT id FROM volumes WHERE id=? AND project_id=?')
        .get(volumeId, projectId)
    )
      throw new AppError('NOT_FOUND', '本作品中不存在该卷', 404);
  }
  getDocument(id: string, includeDeleted = false): DocumentDetail {
    const row = this.db
      .prepare(`${documentSelect} WHERE d.id=? ${includeDeleted ? '' : 'AND d.deleted_at IS NULL'}`)
      .get(id) as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND', '文档不存在或已删除', 404);
    this.getProject(String(row.project_id));
    const doc = document(row);
    return documentDetailSchema.parse({
      document: doc,
      version: this.getVersion(id, doc.currentVersionId),
    });
  }
  getVersion(documentId: string, versionId: string, projectId?: string): DocumentVersion {
    const row = this.db
      .prepare(
        'SELECT v.*,d.project_id FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=? AND v.document_id=? AND (? IS NULL OR d.project_id=?)',
      )
      .get(versionId, documentId, projectId ?? null, projectId ?? null) as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND', '文档版本不存在或不属于指定作品', 404);
    this.getProject(String(row.project_id));
    return version(row);
  }
  assertVersion(documentId: string, baseVersionId: string): DocumentDetail {
    const current = this.getDocument(documentId);
    if (current.document.currentVersionId !== baseVersionId)
      throw new AppError('VERSION_CONFLICT', '文档已更新，请比较后重新保存', 409, {
        currentVersionId: current.document.currentVersionId,
      });
    return current;
  }
  listVersions(id: string, limit: number, cursor?: number) {
    this.getDocument(id, true);
    const rows = this.db
      .prepare(
        'SELECT * FROM document_versions WHERE document_id=? AND version_no<? ORDER BY version_no DESC LIMIT ?',
      )
      .all(id, cursor ?? Number.MAX_SAFE_INTEGER, limit + 1) as Row[];
    return {
      data: rows.slice(0, limit).map((row) => {
        const { content: _content, metadata: _metadata, ...summary } = version(row);
        return summary;
      }),
      nextCursor: rows.length > limit ? String(rows[limit - 1]?.version_no) : null,
    };
  }
  private insertDocument(
    projectId: string,
    input: Omit<CreateDocument, 'baseStructureVersion'>,
    sortOrder: number,
    source: DocumentVersion['source'] = 'manual',
  ): DocumentDetail {
    const id = randomUUID();
    const versionId = randomUUID();
    this.db
      .prepare(
        'INSERT INTO documents(id,project_id,volume_id,kind,chapter_id,title,sort_order,current_version_id,story_time,summary,parent_outline_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        projectId,
        input.volumeId,
        input.kind,
        input.chapterId,
        input.title,
        sortOrder,
        versionId,
        isWritingPlanKind(input.kind) ? (input.storyTime ?? '') : '',
        isWritingPlanKind(input.kind) ? (input.summary ?? '') : '',
        input.parentOutlineId ?? null,
      );
    this.insertVersion(id, versionId, 1, input.content, input.metadata, source);
    if (input.chapterId)
      this.db
        .prepare('INSERT INTO outline_chapters(outline_id,chapter_id,project_id) VALUES(?,?,?)')
        .run(id, input.chapterId, projectId);
    return this.getDocument(id);
  }
  private insertVersion(
    id: string,
    versionId: string,
    number: number,
    content: string,
    metadata: DocumentVersion['metadata'],
    source: DocumentVersion['source'],
  ): void {
    this.db
      .prepare(
        'INSERT INTO document_versions(id,document_id,version_no,content,metadata_json,content_hash,source,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        versionId,
        id,
        number,
        content,
        JSON.stringify(metadata),
        hash(content),
        source,
        new Date().toISOString(),
      );
  }
  createDocument(
    projectId: string,
    input: CreateDocument,
    source: DocumentVersion['source'] = 'manual',
  ): DocumentDetail {
    return this.database.transaction(() => {
      this.checkStructure(projectId, input.baseStructureVersion);
      this.validateElement(projectId, input.kind, input.metadata);
      this.ownVolume(projectId, input.volumeId);
      if (input.parentOutlineId) this.assertPlanParent(projectId, input.parentOutlineId);
      if (input.chapterId) {
        const chapter = this.getDocument(input.chapterId).document;
        if (chapter.projectId !== projectId || chapter.kind !== 'chapter')
          throw new AppError('VALIDATION_ERROR', '关联的正文必须属于当前作品', 400);
      }
      let volumeId = input.volumeId;
      if (input.newVolumeTitle) {
        if (!['chapter', 'chapter_plan'].includes(input.kind) || volumeId !== null)
          throw new AppError('VALIDATION_ERROR', '仅正文或章纲可新建卷，且不能同时指定已有卷', 400);
        const title = input.newVolumeTitle.trim();
        if (!title || title.length > 200)
          throw new AppError('VALIDATION_ERROR', '卷名称需为 1–200 个字符', 400);
        const existing = this.db
          .prepare(
            'SELECT id FROM volumes WHERE project_id=? AND title=? ORDER BY sort_order,id LIMIT 1',
          )
          .get(projectId, title) as { id: string } | undefined;
        volumeId = existing?.id ?? randomUUID();
        if (!existing)
          this.db
            .prepare(
              'INSERT INTO volumes(id,project_id,title,sort_order) SELECT ?,?,?,COALESCE(MAX(sort_order),-1)+1 FROM volumes WHERE project_id=?',
            )
            .run(volumeId, projectId, title, projectId);
      }
      const next = (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM documents WHERE project_id=?',
          )
          .get(projectId) as { next: number }
      ).next;
      const created = this.insertDocument(projectId, { ...input, volumeId }, next, source);
      if (['character', 'master_outline'].includes(input.kind) && !input.metadata.element)
        this.db
          .prepare(
            'INSERT INTO element_confirmations(document_id,confirmed_version_id) VALUES(?,?)',
          )
          .run(created.document.id, created.version.id);
      this.bump(projectId);
      return created;
    });
  }
  startOutlineWriting(id: string, input: StartOutlineWriting): DocumentDetail {
    return this.database.transaction(() => {
      const outline = this.assertVersion(id, input.baseVersionId).document;
      if (!isWritingPlanKind(outline.kind))
        throw new AppError('VALIDATION_ERROR', '请选择故事事件开始写作', 400);
      const existing = linkedChapterIds(outline)[0];
      if (!input.newChapterTitle && existing) return this.getDocument(existing);
      this.checkStructure(outline.projectId, input.baseStructureVersion);
      this.ownVolume(outline.projectId, input.volumeId);
      const chapter = this.insertDocument(
        outline.projectId,
        {
          kind: 'chapter',
          title: input.newChapterTitle ?? outline.title,
          volumeId: outline.kind === 'chapter_plan' ? outline.volumeId : input.volumeId,
          chapterId: null,
          content: '',
          metadata: {},
        },
        (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM documents WHERE project_id=? AND kind='chapter'",
            )
            .get(outline.projectId) as { next: number }
        ).next,
      );
      this.db
        .prepare('INSERT INTO outline_chapters(outline_id,chapter_id,project_id) VALUES(?,?,?)')
        .run(id, chapter.document.id, outline.projectId);
      if (['chapter_outline', 'chapter_plan'].includes(outline.kind) && !outline.chapterId)
        this.db
          .prepare('UPDATE documents SET chapter_id=? WHERE id=?')
          .run(chapter.document.id, id);
      this.bump(outline.projectId);
      if (outline.kind === 'chapter_plan' && outline.parentOutlineId)
        this.linkPlanChapter(outline.parentOutlineId, chapter.document.id);
      return chapter;
    });
  }
  updateStoryEvent(id: string, input: UpdateStoryEvent): DocumentDetail {
    return this.database.transaction((db) => {
      const current = this.getDocument(id);
      const event = current.document;
      if (!isWritingPlanKind(event.kind))
        throw new AppError('VALIDATION_ERROR', '请选择故事时间线中的事件', 400);
      if (
        ['chapter_outline', 'chapter_plan'].includes(event.kind) &&
        (input.storyTime.length > 200 || input.summary.length > 1000)
      )
        throw new AppError('VALIDATION_ERROR', '事件时间最多 200 字符，概述最多 1000 字符', 400);
      this.checkStructure(event.projectId, input.baseStructureVersion);
      for (const chapterId of input.chapterIds) {
        const chapter = this.getDocument(chapterId).document;
        if (chapter.projectId !== event.projectId || chapter.kind !== 'chapter')
          throw new AppError('VALIDATION_ERROR', '关联章节必须是当前作品的正文', 400);
      }
      db.prepare('UPDATE documents SET title=?,story_time=?,summary=?,chapter_id=? WHERE id=?').run(
        input.title,
        input.storyTime.slice(0, 200),
        input.summary.slice(0, 1000),
        ['chapter_outline', 'chapter_plan'].includes(event.kind)
          ? (input.chapterIds[0] ?? null)
          : null,
        id,
      );
      if (event.kind === 'timeline_event') {
        const data = readElementData(current.version.metadata);
        this.saveDocument(id, {
          baseVersionId: current.version.id,
          content: current.version.content,
          metadata: {
            ...current.version.metadata,
            element: {
              ...data,
              summary: input.summary,
              fields: { ...data.fields, time: input.storyTime },
            },
          },
        });
      }
      db.prepare('DELETE FROM outline_chapters WHERE outline_id=?').run(id);
      const insert = db.prepare(
        'INSERT INTO outline_chapters(outline_id,chapter_id,project_id) VALUES(?,?,?)',
      );
      for (const chapterId of input.chapterIds) insert.run(id, chapterId, event.projectId);
      this.bump(event.projectId);
      return this.getDocument(id);
    });
  }
  private assertPlanParent(projectId: string, parentId: string): void {
    const parent = this.getDocument(parentId).document;
    if (
      parent.projectId !== projectId ||
      parent.archived ||
      !(isStoryEventKind(parent.kind) || parent.kind === 'master_outline')
    )
      throw new AppError('VALIDATION_ERROR', '章纲来源必须是当前作品的总纲或故事规划', 400);
  }
  updateChapterPlan(id: string, input: UpdateChapterPlan): DocumentDetail {
    return this.database.transaction((db) => {
      const plan = this.getDocument(id).document;
      if (plan.kind !== 'chapter_plan') throw new AppError('VALIDATION_ERROR', '请选择章纲', 400);
      this.checkStructure(plan.projectId, input.baseStructureVersion);
      this.ownVolume(plan.projectId, input.volumeId);
      if (input.parentOutlineId) this.assertPlanParent(plan.projectId, input.parentOutlineId);
      db.prepare('UPDATE documents SET parent_outline_id=?,volume_id=? WHERE id=?').run(
        input.parentOutlineId,
        input.volumeId,
        id,
      );
      return this.updateStoryEvent(id, input);
    });
  }
  linkPlanChapter(id: string, chapterId: string): void {
    const plan = this.getDocument(id).document;
    if (!isWritingPlanKind(plan.kind)) return;
    this.updateStoryEvent(id, {
      baseStructureVersion: this.getProject(plan.projectId).structureVersion,
      title: plan.title,
      storyTime: plan.storyTime ?? '',
      summary: plan.summary ?? '',
      chapterIds: [...new Set([...linkedChapterIds(plan), chapterId])],
    });
    if (plan.kind === 'chapter_plan' && plan.parentOutlineId)
      this.linkPlanChapter(plan.parentOutlineId, chapterId);
  }
  saveDocument(
    id: string,
    input: NovelSave,
    source: DocumentVersion['source'] = 'manual',
  ): DocumentDetail {
    return this.database.transaction((db) => {
      const current = this.assertVersion(id, input.baseVersionId);
      this.validateElement(current.document.projectId, current.document.kind, input.metadata);
      const versionId = randomUUID();
      this.insertVersion(
        id,
        versionId,
        current.version.versionNo + 1,
        input.content,
        input.metadata,
        source,
      );
      db.prepare('UPDATE documents SET current_version_id=? WHERE id=?').run(versionId, id);
      db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(
        new Date().toISOString(),
        current.document.projectId,
      );
      return this.getDocument(id);
    });
  }
  restoreDocument(id: string, baseVersionId: string, restoreVersionId: string): DocumentDetail {
    return this.database.transaction(() => {
      const previous = this.getVersion(id, restoreVersionId);
      return this.saveDocument(
        id,
        { baseVersionId, content: previous.content, metadata: previous.metadata },
        'restore',
      );
    });
  }
  deleteDocument(id: string, baseVersionId: string, baseStructureVersion: number): void {
    this.database.transaction((db) => {
      const current = this.assertVersion(id, baseVersionId);
      this.checkStructure(current.document.projectId, baseStructureVersion);
      if (
        db
          .prepare(
            `SELECT r.id FROM runs r JOIN run_documents rd ON rd.run_id=r.id JOIN documents d ON d.id=rd.document_id
             WHERE r.status IN ('queued','running','cancelling') AND (d.id=? OR d.chapter_id=? OR EXISTS (
               SELECT 1 FROM outline_chapters oc WHERE oc.outline_id=d.id AND oc.chapter_id=?
             )) LIMIT 1`,
          )
          .get(id, id, id)
      )
        throw new AppError('PROJECT_BUSY', '活跃运行正在使用此文档，请结束运行后删除', 409);
      db.prepare('UPDATE documents SET chapter_id=NULL WHERE chapter_id=? AND project_id=?').run(
        id,
        current.document.projectId,
      );
      db.prepare('DELETE FROM outline_chapters WHERE outline_id=? OR chapter_id=?').run(id, id);
      db.prepare(`UPDATE documents SET chapter_id=(
        SELECT chapter_id FROM outline_chapters WHERE outline_id=documents.id ORDER BY chapter_id LIMIT 1
      ) WHERE project_id=? AND kind IN ('chapter_outline','chapter_plan') AND chapter_id IS NULL`).run(
        current.document.projectId,
      );
      db.prepare('UPDATE documents SET parent_outline_id=NULL WHERE parent_outline_id=?').run(id);
      db.prepare('UPDATE documents SET deleted_at=? WHERE id=?').run(new Date().toISOString(), id);
      this.bump(current.document.projectId);
    });
  }
  committedImport(projectId: string, id: string, requestHash?: string): ImportResult | null {
    this.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM import_commits WHERE import_id=?').get(id) as
      | Row
      | undefined;
    if (!row) return null;
    if (row.project_id !== projectId) throw new AppError('NOT_FOUND', '导入不存在', 404);
    if (requestHash && row.request_hash !== requestHash)
      throw new AppError('IDEMPOTENCY_CONFLICT', '该导入已使用不同内容确认，请重新创建导入', 409);
    return JSON.parse(String(row.response_json)) as ImportResult;
  }
  confirmImport(projectId: string, id: string, input: ConfirmImport): ImportResult {
    const requestHash = hash(
      JSON.stringify({
        baseStructureVersion: input.baseStructureVersion,
        volumeId: input.volumeId,
        chapters: input.chapters.map((chapter) => ({
          title: chapter.title,
          content: chapter.content,
        })),
      }),
    );
    return this.database.transaction((db) => {
      const existing = this.committedImport(projectId, id, requestHash);
      if (existing) return existing;
      this.checkStructure(projectId, input.baseStructureVersion);
      this.ownVolume(projectId, input.volumeId);
      let next = (
        db
          .prepare(
            'SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM documents WHERE project_id=?',
          )
          .get(projectId) as { next: number }
      ).next;
      const documentIds = input.chapters.map(
        (chapter) =>
          this.insertDocument(
            projectId,
            {
              ...chapter,
              kind: 'chapter',
              volumeId: input.volumeId,
              chapterId: null,
              metadata: {},
            },
            next++,
            'import',
          ).document.id,
      );
      this.bump(projectId);
      const result = {
        importId: id,
        projectId,
        documentIds,
        structureVersion: this.getProject(projectId).structureVersion,
      };
      db.prepare('INSERT INTO import_commits VALUES(?,?,?,?,?)').run(
        id,
        projectId,
        requestHash,
        JSON.stringify(result),
        new Date().toISOString(),
      );
      return result;
    });
  }
  exportText(projectId: string, chapterId?: string): string {
    return this.db.transaction(() => {
      const structure = this.getStructure(projectId);
      let chapters = orderedChapters(structure);
      if (chapterId) {
        if (!chapters.some((item) => item.id === chapterId))
          throw new AppError('NOT_FOUND', '本作品中不存在该正文', 404);
        chapters = chapters.filter((item) => item.id === chapterId);
      }
      const output = [structure.project.title];
      let previousVolume: string | null = null;
      for (const chapter of chapters) {
        if (!chapterId && chapter.volumeId && chapter.volumeId !== previousVolume)
          output.push(
            structure.volumes.find((volume) => volume.id === chapter.volumeId)?.title ?? '',
          );
        let content = this.getVersion(chapter.id, chapter.currentVersionId).content.replace(
          /\r\n?/g,
          '\n',
        );
        const firstLine = content
          .split('\n', 1)[0]
          ?.trim()
          .replace(/^#{1,6}\s+/, '');
        // Models and imported manuscripts may include the same heading as the directory.
        // Only omit that exact leading heading from the export; keep the saved version intact.
        if (firstLine === chapter.title.trim()) {
          const newline = content.indexOf('\n');
          content = newline < 0 ? '' : content.slice(newline + 1).replace(/^\s*\n/, '');
        }
        output.push(chapter.title, content);
        previousVolume = chapter.volumeId;
      }
      return `${output.join('\n\n')}\n`;
    })();
  }
}
