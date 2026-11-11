import {
  type Document,
  linkedChapterIds,
  orderedChapters,
  type Structure,
  type UpdateStoryEvent,
} from '@lingma/shared';
import { BookOpen, Clock3, Link2, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Modal } from './Modal.js';

type EventPlan = Omit<UpdateStoryEvent, 'baseStructureVersion'>;

export function StoryEventDetails({
  event,
  structure,
  busy,
  onSave,
  onAddChapter,
  onOpenChapter,
  chaptersOnly = false,
}: {
  event: Document;
  structure: Structure;
  busy: boolean;
  onSave(input: UpdateStoryEvent): Promise<void>;
  onAddChapter(title: string): Promise<void>;
  onOpenChapter(id: string): void;
  chaptersOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const ids = new Set(linkedChapterIds(event));
  const chapters = orderedChapters(structure).filter((chapter) => ids.has(chapter.id));
  return (
    <section
      className={`story-event-details${chaptersOnly ? ' outline-reader-chapters' : ''}`}
      aria-label="事件信息与关联章节"
    >
      {!chaptersOnly && (
        <>
          <div className="story-event-overview">
            <span>
              <Clock3 size={14} aria-hidden="true" />
              {event.storyTime || '时间待定'}
            </span>
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil size={13} aria-hidden="true" /> 编辑事件
            </button>
          </div>
          {event.summary && <p className="story-event-summary">{event.summary}</p>}
        </>
      )}
      <div className="story-event-chapters-heading">
        <h2>
          {!chaptersOnly && <Link2 size={14} aria-hidden="true" />}{' '}
          {chaptersOnly ? '关联正文' : '关联章节'} · {chapters.length} 章
        </h2>
        <button type="button" disabled={busy} onClick={() => setEditing(true)}>
          关联已有章节
        </button>
      </div>
      <div className="story-event-linked-chapters">
        {chapters.map((chapter) => (
          <button type="button" key={chapter.id} onClick={() => onOpenChapter(chapter.id)}>
            <BookOpen size={14} aria-hidden="true" />
            <span>{chapter.title}</span>
          </button>
        ))}
      </div>
      {!chapters.length && (
        <p className="muted">
          {chaptersOnly
            ? '这份规划尚未关联章节。起草后可预览，确认采用再保存为正文。'
            : '这个事件还没有关联章节，可以先完善事件大纲。'}
        </p>
      )}
      <details className="story-event-other-actions">
        <summary>其他章节操作</summary>
        <button
          type="button"
          className="story-event-add-chapter"
          disabled={busy}
          onClick={() => setAdding(true)}
        >
          <Plus size={14} aria-hidden="true" /> 为此事件新建章节
        </button>
        <p className="story-event-hint">
          一个事件可跨多个章节，一个章节也可涉及多个事件。章节仍按阅读顺序排列。
        </p>
      </details>
      {!chaptersOnly && <h2 className="story-event-outline-heading">事件详细大纲</h2>}
      {editing && (
        <EventPlanDialog
          event={event}
          structure={structure}
          onSave={onSave}
          onClose={() => setEditing(false)}
        />
      )}
      {adding && <EventChapterDialog onAdd={onAddChapter} onClose={() => setAdding(false)} />}
    </section>
  );
}

function EventPlanDialog({
  event,
  structure,
  onSave,
  onClose,
}: {
  event: Document;
  structure: Structure;
  onSave(input: UpdateStoryEvent): Promise<void>;
  onClose(): void;
}) {
  const [base] = useState(structure.project.structureVersion);
  const [input, setInput] = useState<EventPlan>(() => ({
    title: event.title,
    storyTime: event.storyTime ?? '',
    summary: event.summary ?? '',
    chapterIds: linkedChapterIds(event),
  }));
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const chapters = orderedChapters(structure);
  const visible = chapters.filter((chapter) =>
    chapter.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Modal
      labelledBy="story-event-plan-title"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="dialog story-event-dialog"
        onSubmit={(submit) => {
          submit.preventDefault();
          setSaving(true);
          setError('');
          void onSave({ ...input, baseStructureVersion: base })
            .then(onClose)
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : '保存失败，请重试');
            })
            .finally(() => setSaving(false));
        }}
      >
        <h2 id="story-event-plan-title">编辑故事事件</h2>
        <fieldset disabled={saving}>
          <label>
            事件名称
            <input
              required
              maxLength={200}
              value={input.title}
              onChange={(change) => setInput({ ...input, title: change.target.value })}
            />
          </label>
          <label>
            故事时间（可选）
            <input
              maxLength={event.kind === 'timeline_event' ? 16000 : 200}
              placeholder="例如：9月初—9月中旬、入学前、三年后"
              value={input.storyTime}
              onChange={(change) => setInput({ ...input, storyTime: change.target.value })}
            />
          </label>
          <label>
            事件概述（可选）
            <textarea
              rows={3}
              maxLength={event.kind === 'timeline_event' ? 4000 : 1000}
              placeholder="用一两句话概括这个大事件"
              value={input.summary}
              onChange={(change) => setInput({ ...input, summary: change.target.value })}
            />
          </label>
          <div className="story-event-chapters-heading">
            <h3>关联已有章节</h3>
            <span>已选 {input.chapterIds.length} 章</span>
          </div>
          <label className="sr-only" htmlFor="event-chapter-search">
            搜索可关联章节
          </label>
          <input
            id="event-chapter-search"
            type="search"
            placeholder="搜索章节"
            value={query}
            onChange={(change) => setQuery(change.target.value)}
          />
          <div className="story-event-chapter-picker">
            {visible.map((chapter) => (
              <label key={chapter.id}>
                <input
                  type="checkbox"
                  checked={input.chapterIds.includes(chapter.id)}
                  onChange={(change) => {
                    setInput({
                      ...input,
                      chapterIds: change.target.checked
                        ? [...input.chapterIds, chapter.id]
                        : input.chapterIds.filter((id) => id !== chapter.id),
                    });
                  }}
                />
                <span>{chapter.title}</span>
              </label>
            ))}
            {!chapters.length && <p className="muted">暂无正文，保存后可为此事件新建章节。</p>}
            {chapters.length > 0 && !visible.length && <p className="muted">没有匹配的章节。</p>}
          </div>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button className="primary" type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存事件'}
          </button>
          <button type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EventChapterDialog({
  onAdd,
  onClose,
}: {
  onAdd(title: string): Promise<void>;
  onClose(): void;
}) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      labelledBy="event-chapter-title"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError('');
          void onAdd(title.trim())
            .then(onClose)
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : '创建失败，请重试');
            })
            .finally(() => setSaving(false));
        }}
      >
        <h2 id="event-chapter-title">为此事件新建章节</h2>
        <label>
          章节名称
          <input
            required
            maxLength={200}
            disabled={saving}
            placeholder="填写这一章的标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <p className="muted">新章节会自动关联此事件，并加入正文目录末尾。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button type="submit" className="primary" disabled={saving || !title.trim()}>
            {saving ? '创建中…' : '创建并打开正文'}
          </button>
          <button type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}
