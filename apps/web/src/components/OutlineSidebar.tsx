import {
  type Document,
  isStoryEventKind,
  linkedChapterIds,
  orderedChapters,
  type Structure,
} from '@lingma/shared';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Clock3,
  FileText,
  ListTree,
  Plus,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';

export function OutlineSidebar({
  structure,
  documentId,
  busy,
  onOpen,
  onCreate,
  onOpenWriting,
  onReorder,
  onAiCreate,
  onManage,
  onOpenForeshadows,
}: {
  structure: Structure;
  documentId: string;
  busy: boolean;
  onOpen(id: string): void;
  onCreate(kind: 'master_outline' | 'chapter_outline'): void;
  onOpenWriting(id: string): void;
  onReorder(sourceId: string, targetId: string): void;
  onAiCreate(kind: 'master_outline' | 'chapter_outline'): void;
  onManage(): void;
  onOpenForeshadows(): void;
}) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const documents = [...structure.documents].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );
  const totals = documents.filter(
    (document) => document.kind === 'master_outline' && (showArchived || !document.archived),
  );
  const events = documents.filter(
    (document) => isStoryEventKind(document.kind) && (showArchived || !document.archived),
  );
  const chapters = orderedChapters(structure);
  const related = (event: Document) => {
    const ids = new Set(linkedChapterIds(event));
    return chapters.filter((chapter) => ids.has(chapter.id));
  };
  const matches = (document: Document) =>
    [document.title, document.storyTime, document.summary, ...related(document).map((c) => c.title)]
      .join('\n')
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  function outlineButton(document: Document) {
    return (
      <button
        type="button"
        key={document.id}
        className={`document-link ${document.id === documentId ? 'selected' : ''}`}
        aria-current={document.id === documentId ? 'page' : undefined}
        onClick={() => onOpen(document.id)}
      >
        <FileText size={14} aria-hidden="true" />
        <span>
          {document.title}
          {document.archived ? '（已归档）' : ''}
        </span>
      </button>
    );
  }
  return (
    <aside
      id="workspace-outline-sidebar"
      className="sidebar outline-sidebar"
      aria-label="故事时间线目录"
    >
      <div className="outline-sidebar-heading">
        <ListTree size={20} aria-hidden="true" />
        <h1>故事大纲</h1>
      </div>
      <p className="outline-project-title">{structure.project.title}</p>
      <p className="outline-progress">
        {events.length} 个事件 · {events.filter((event) => related(event).length).length}{' '}
        个已关联章节
      </p>
      <label className="sr-only" htmlFor="outline-search">
        搜索事件、大纲与关联章节
      </label>
      <input
        id="outline-search"
        type="search"
        placeholder="搜索事件、时间或章节"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <nav aria-label="总纲与故事时间线">
        <div className="outline-section-heading">
          <h2>故事总纲</h2>
          <button type="button" disabled={busy} onClick={() => onCreate('master_outline')}>
            <Plus size={13} aria-hidden="true" /> 新建
          </button>
        </div>
        <p className="outline-empty-note">统一规划故事的起点、转折与结局。</p>
        {totals.filter(matches).map(outlineButton)}
        {!totals.length && <p className="outline-empty-note">先写下故事走向、转折与结局。</p>}
        <button
          type="button"
          className="outline-ai-create"
          disabled={busy}
          onClick={() => onAiCreate('master_outline')}
        >
          <Sparkles size={14} aria-hidden="true" /> AI 生成总纲
        </button>
        <div className="outline-section-heading">
          <h2>故事时间线</h2>
          <button type="button" disabled={busy} onClick={() => onCreate('chapter_outline')}>
            <Plus size={13} aria-hidden="true" /> 添加事件
          </button>
        </div>
        <p className="outline-empty-note">按故事发生顺序排列，可拖动调整。</p>
        <div className="story-timeline">
          {events.filter(matches).map((event) => {
            const linked = related(event);
            const index = events.indexOf(event);
            return (
              <article
                key={event.id}
                className={`timeline-event${event.id === documentId ? ' is-selected' : ''}${draggedId === event.id ? ' is-dragging' : ''}`}
                draggable={!busy && !query.trim() && !showArchived}
                onDragStart={(drag) => {
                  drag.dataTransfer.setData('text/plain', event.id);
                  drag.dataTransfer.effectAllowed = 'move';
                  setDraggedId(event.id);
                }}
                onDragEnd={() => setDraggedId(null)}
                onDragOver={(drag) => {
                  if (draggedId && !busy && !query.trim() && !showArchived) drag.preventDefault();
                }}
                onDrop={(drag) => {
                  drag.preventDefault();
                  if (
                    draggedId &&
                    draggedId !== event.id &&
                    !busy &&
                    !query.trim() &&
                    !showArchived
                  )
                    onReorder(draggedId, event.id);
                  setDraggedId(null);
                }}
              >
                <span className="timeline-event-dot" aria-hidden="true" />
                <div className="timeline-event-time">
                  <Clock3 size={11} aria-hidden="true" />
                  {event.storyTime || '时间待定'}
                </div>
                {outlineButton(event)}
                {event.summary && <p className="timeline-event-summary">{event.summary}</p>}
                <details className="timeline-event-chapters" open={event.id === documentId}>
                  <summary>
                    {linked.length ? `${linked.length} 个关联章节` : '尚未关联章节'}
                  </summary>
                  {linked.map((chapter) => (
                    <button
                      type="button"
                      key={chapter.id}
                      onClick={() => onOpenWriting(chapter.id)}
                    >
                      <BookOpen size={12} aria-hidden="true" />
                      <span>{chapter.title}</span>
                    </button>
                  ))}
                  <button type="button" onClick={() => onOpen(event.id)}>
                    <Plus size={12} aria-hidden="true" /> 管理关联章节
                  </button>
                </details>
                <div className="timeline-event-order">
                  <button
                    type="button"
                    disabled={busy || index === 0 || Boolean(query.trim()) || showArchived}
                    aria-label={`上移事件：${event.title}`}
                    title="上移事件"
                    onClick={() => {
                      const previous = events[index - 1];
                      if (previous) onReorder(event.id, previous.id);
                    }}
                  >
                    <ArrowUp size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy || index === events.length - 1 || Boolean(query.trim()) || showArchived
                    }
                    aria-label={`下移事件：${event.title}`}
                    title="下移事件"
                    onClick={() => {
                      const next = events[index + 1];
                      if (next) onReorder(event.id, next.id);
                    }}
                  >
                    <ArrowDown size={12} aria-hidden="true" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        <button
          type="button"
          className="outline-ai-create"
          disabled={busy}
          onClick={() => onAiCreate('chapter_outline')}
        >
          <Sparkles size={14} aria-hidden="true" /> AI 规划事件
        </button>
        {!events.length && (
          <div className="outline-empty-note">
            <p>先规划大事件，再用多个章节展开；同一章也可以关联多个事件。</p>
            <button type="button" disabled={busy} onClick={() => onCreate('chapter_outline')}>
              <Plus size={13} aria-hidden="true" /> 添加第一个事件
            </button>
          </div>
        )}
        {query.trim() && !totals.some(matches) && !events.some(matches) && (
          <p className="outline-empty-note" role="status">
            没有匹配的大纲或事件。
          </p>
        )}
      </nav>
      <button type="button" className="outline-manage" onClick={onOpenForeshadows}>
        伏笔与悬念 ·{' '}
        {
          documents.filter((document) => document.kind === 'foreshadow' && !document.archived)
            .length
        }
      </button>
      <label className="outline-archive-toggle">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(change) => setShowArchived(change.target.checked)}
        />
        显示已归档总纲与事件
      </label>
      <button type="button" className="outline-manage" onClick={onManage}>
        大纲与时间线管理
      </button>
    </aside>
  );
}
