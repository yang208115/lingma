import {
  elementDataSchema,
  linkedChapterIds,
  metadataSchema,
  normalizeOutlineMarkdown,
  readElementData,
  validateElementFields,
  type WorkflowArtifactPayload,
  type WorkflowInput,
  type WorkflowRun,
  workflowOutputTypes,
} from '@lingma/shared';
import { AppError } from '../errors.js';
import type { WritingStore } from '../writing/store.js';

export function assertWorkflowTarget(store: WritingStore, input: WorkflowInput) {
  store.novels.getProject(input.projectId);
  if (Boolean(input.targetDocumentId) !== Boolean(input.baseVersionId))
    throw new AppError('VALIDATION_ERROR', '修改目标必须同时提供文档与基准版本', 400);
  if (!input.targetDocumentId || !input.baseVersionId) {
    if (input.mode !== 'create' && input.mode !== 'extract')
      throw new AppError('VALIDATION_ERROR', '补全或替代需要选择已有目标', 400);
    return;
  }
  const target = store.novels.assertVersion(input.targetDocumentId, input.baseVersionId);
  const kind = {
    chapter_write: 'chapter',
    worldbuilding: 'worldbuilding',
    master_outline: 'master_outline',
    story_events: 'chapter_outline',
  }[input.taskType];
  if (
    target.document.projectId !== input.projectId ||
    target.document.kind !== kind ||
    target.document.archived
  )
    throw new AppError('FORBIDDEN', '编排目标不属于当前作品或目标类型不匹配', 403);
}

type Allowed = { documentId: string; versionId: string }[];
export function normalizeWorkflowOutput(
  store: WritingStore,
  input: WorkflowInput,
  raw: WorkflowArtifactPayload,
  allowed: Allowed,
): WorkflowArtifactPayload {
  const payload = structuredClone(raw);
  if (payload.type !== workflowOutputTypes[input.taskType])
    throw new AppError('VALIDATION_ERROR', '产物类型与本次编排任务不匹配', 400);
  if (payload.type === 'chapter_draft' && !input.targetDocumentId && !payload.title?.trim())
    throw new AppError('VALIDATION_ERROR', '新建正文需要提供章节标题', 400);
  if (
    payload.type === 'outline_event_batch' &&
    input.targetDocumentId &&
    payload.items.length !== 1
  )
    throw new AppError('VALIDATION_ERROR', '修改已有事件只能提交一份对应候选', 400);
  if ('citations' in payload) {
    for (const citation of payload.citations) {
      if (citation === 'author') continue;
      const match = /^doc:([^@]+)@([^#]+)#(\d+)-(\d+)$/.exec(citation);
      if (
        !match ||
        !allowed.some((ref) => ref.documentId === match[1] && ref.versionId === match[2])
      )
        throw new AppError('FORBIDDEN', '生成依据不在本次授权版本中', 403);
      const source = store.novels.getVersion(match[1] as string, match[2] as string);
      if (Number(match[3]) >= Number(match[4]) || Number(match[4]) > source.content.length)
        throw new AppError('VALIDATION_ERROR', '生成依据范围无效', 400);
    }
  }
  if (payload.type !== 'element_candidates') return payload;
  const ids = new Set(payload.items.map((item) => item.tempId));
  if (ids.size !== payload.items.length)
    throw new AppError('VALIDATION_ERROR', '世界观候选标识不能重复', 400);
  if (input.targetDocumentId && payload.items.length !== 1)
    throw new AppError('VALIDATION_ERROR', '修改已有世界观只能提交一个候选', 400);
  for (const item of payload.items) {
    if (item.kind !== 'worldbuilding' || item.targetDocumentId !== input.targetDocumentId)
      throw new AppError('FORBIDDEN', '只能生成本次指定的世界观目标', 403);
    try {
      validateElementFields(item.kind, item.data);
    } catch {
      throw new AppError('VALIDATION_ERROR', '世界观字段或锁定字段无效', 400);
    }
    if (item.data.archived) throw new AppError('FORBIDDEN', '模型不能归档资料', 403);
    for (const source of item.data.sources) {
      if (
        !allowed.some(
          (ref) => ref.documentId === source.documentId && ref.versionId === source.versionId,
        )
      )
        throw new AppError('FORBIDDEN', '世界观来源不在授权版本中', 403);
      const version = store.novels.getVersion(source.documentId, source.versionId);
      if (source.from >= source.to || source.to > version.content.length)
        throw new AppError('VALIDATION_ERROR', '世界观来源范围无效', 400);
    }
    if (input.mode === 'extract' && !item.data.sources.length)
      throw new AppError('VALIDATION_ERROR', '资料提取必须提供来源', 400);
    for (const link of item.data.links)
      if (!ids.has(link.targetId) && !allowed.some((ref) => ref.documentId === link.targetId))
        throw new AppError('FORBIDDEN', '世界观关联不在本次授权范围', 403);
    item.data.source = input.mode === 'extract' ? 'extracted' : 'ai';
    item.data.generationId = null;
    if (input.targetDocumentId && input.baseVersionId) {
      const target = store.novels.getVersion(input.targetDocumentId, input.baseVersionId);
      const document = store.novels.getDocument(input.targetDocumentId).document;
      const original = readElementData(target.metadata);
      const locks = new Set(original.locked);
      if (input.mode === 'fill' || input.mode === 'extract') {
        locks.add('title');
        locks.add('nature');
        if (target.content) locks.add('content');
        if (original.summary) locks.add('summary');
        if (original.tags.length) locks.add('tags');
        if (original.links.length) locks.add('links');
        for (const [field, value] of Object.entries(original.fields))
          if (value.trim()) locks.add(`fields.${field}`);
      }
      for (const field of locks) {
        if (field.startsWith('fields.'))
          item.data.fields[field.slice(7)] = original.fields[field.slice(7)] ?? '';
        else if (field === 'title') item.title = document.title;
        else if (field === 'content') item.content = target.content;
        else if (field === 'summary') item.data.summary = original.summary;
        else if (field === 'tags') item.data.tags = original.tags;
        else if (field === 'links') item.data.links = original.links;
        else if (field === 'nature') item.data.nature = original.nature;
      }
      item.data.locked = original.locked;
    } else {
      if (item.data.locked.length) throw new AppError('FORBIDDEN', '模型不能锁定新资料', 403);
      if (item.data.nature === 'established' && !item.data.sources.length)
        item.data.nature = 'planned';
    }
    metadataSchema.parse({ element: item.data });
  }
  return payload;
}

/** The caller owns the workflow decision transaction, including acceptedResults and its event. */
export function acceptWorkflowOutput(store: WritingStore, w: WorkflowRun, itemIds?: string[]) {
  const input = w.snapshot.input;
  assertWorkflowTarget(store, input);
  const artifact = w.artifacts.find((item) => item.id === w.latestDraftId);
  if (!artifact) throw new AppError('NOT_FOUND', '缺少待采用产物', 404);
  const payload = artifact.payload;
  const pending =
    payload.type === 'element_candidates'
      ? payload.items.map((item) => item.tempId)
      : [artifact.id];
  const selected =
    itemIds ?? pending.filter((id) => !w.acceptedResults.some((item) => item.itemId === id));
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !pending.includes(id))
  )
    throw new AppError('VALIDATION_ERROR', '请选择有效且不重复的候选', 400);
  const mappings = new Map(w.acceptedResults.map((item) => [item.itemId, item.documentId]));
  if (selected.some((id) => mappings.has(id)))
    throw new AppError('VERSION_CONFLICT', '候选已经采用，请刷新结果', 409);
  if (payload.type === 'element_candidates') {
    for (const item of payload.items.filter((item) => selected.includes(item.tempId)))
      for (const link of item.data.links)
        if (
          pending.includes(link.targetId) &&
          !selected.includes(link.targetId) &&
          !mappings.has(link.targetId)
        )
          throw new AppError('VALIDATION_ERROR', '请一并采用依赖的世界观条目', 400);
    for (const item of payload.items.filter((item) => selected.includes(item.tempId))) {
      if (item.targetDocumentId) mappings.set(item.tempId, item.targetDocumentId);
      else {
        const created = store.novels.createDocument(
          w.projectId,
          {
            baseStructureVersion: store.novels.getProject(w.projectId).structureVersion,
            kind: 'worldbuilding',
            title: item.title,
            content: item.content,
            volumeId: null,
            chapterId: null,
            metadata: { element: { ...item.data, links: [] } },
          },
          'proposal',
        );
        mappings.set(item.tempId, created.document.id);
      }
    }
    for (const item of payload.items.filter((item) => selected.includes(item.tempId))) {
      const id = mappings.get(item.tempId) as string;
      const current = store.novels.getDocument(id);
      const data = elementDataSchema.parse({
        ...item.data,
        generationId: w.id,
        links: item.data.links.map((link) => ({
          ...link,
          targetId: mappings.get(link.targetId) ?? link.targetId,
        })),
      });
      const saved = store.novels.saveDocument(
        id,
        {
          baseVersionId: current.version.id,
          content: item.content,
          metadata: { ...current.version.metadata, element: data },
        },
        'proposal',
      );
      rename(store, w.projectId, id, item.title);
      confirm(store, id, saved.version.id);
      w.acceptedResults.push({ itemId: item.tempId, documentId: id, versionId: saved.version.id });
    }
    return pending.every((id) => w.acceptedResults.some((item) => item.itemId === id));
  }
  const items =
    payload.type === 'outline_event_batch'
      ? payload.items
      : payload.type === 'master_outline_candidate'
        ? [{ title: payload.title, content: payload.content }]
        : payload.type === 'chapter_draft'
          ? [{ title: payload.title ?? '新章节', content: payload.content }]
          : null;
  if (!items) throw new AppError('VALIDATION_ERROR', '该产物不能保存为正式资料', 400);
  for (const [index, item] of items.entries()) {
    const kind =
      input.taskType === 'chapter_write'
        ? 'chapter'
        : input.taskType === 'master_outline'
          ? 'master_outline'
          : 'chapter_outline';
    const content = kind === 'chapter' ? item.content : normalizeOutlineMarkdown(item.content);
    const saved =
      input.targetDocumentId && input.baseVersionId
        ? store.novels.saveDocument(
            input.targetDocumentId,
            {
              baseVersionId: input.baseVersionId,
              content,
              metadata: store.novels.getVersion(input.targetDocumentId, input.baseVersionId)
                .metadata,
            },
            'proposal',
          )
        : store.novels.createDocument(
            w.projectId,
            {
              baseStructureVersion: store.novels.getProject(w.projectId).structureVersion,
              kind,
              title: item.title,
              content,
              volumeId: null,
              chapterId: null,
              ...('storyTime' in item ? { storyTime: item.storyTime, summary: item.summary } : {}),
              metadata:
                kind === 'master_outline'
                  ? { element: { schemaVersion: 1, nature: 'planned' } }
                  : {},
            },
            'proposal',
          );
    if (input.targetDocumentId && kind === 'chapter_outline' && 'storyTime' in item)
      store.novels.updateStoryEvent(saved.document.id, {
        baseStructureVersion: store.novels.getProject(w.projectId).structureVersion,
        title: item.title,
        storyTime: item.storyTime ?? '',
        summary: item.summary ?? '',
        chapterIds: linkedChapterIds(saved.document),
      });
    else if (input.targetDocumentId) rename(store, w.projectId, saved.document.id, item.title);
    if (kind === 'master_outline') confirm(store, saved.document.id, saved.version.id);
    w.acceptedResults.push({
      itemId: `${artifact.id}:${index}`,
      documentId: saved.document.id,
      versionId: saved.version.id,
    });
  }
  return true;
}

function rename(store: WritingStore, projectId: string, id: string, title: string) {
  store.db.prepare('UPDATE documents SET title=? WHERE id=?').run(title, id);
  store.db
    .prepare('UPDATE projects SET structure_version=structure_version+1 WHERE id=?')
    .run(projectId);
}
function confirm(store: WritingStore, id: string, versionId: string) {
  store.db
    .prepare(
      'INSERT INTO element_confirmations(document_id,confirmed_version_id) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET confirmed_version_id=excluded.confirmed_version_id',
    )
    .run(id, versionId);
}
