import {
  type Document,
  isStoryEventKind,
  linkedChapterIds,
  orderedChapters,
  type Structure,
} from '@lingma/shared';
import { ArrowDown, ArrowUp, ChevronRight, Clock3, FileText, Plus, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

export function OutlineSidebar({
  structure,
  documentId,
  busy,
  onOpen,
  onCreate,
  onReorder,
  onAiCreate,
  onManage,
}: {
  structure: Structure;
  documentId: string;
  busy: boolean;
  onOpen(id: string): void;
  onCreate(kind: 'master_outline' | 'chapter_outline' | 'chapter_plan'): void;
  onReorder(sourceId: string, targetId: string): void;
  onAiCreate(kind: 'master_outline' | 'chapter_outline' | 'chapter_plan'): void;
  onManage(): void;
}) {
  const selectedKind = structure.documents.find((item) => item.id === documentId)?.kind;
  const [section, setSection] = useState(
    selectedKind === 'chapter_plan'
      ? 'plans'
      : selectedKind === 'master_outline'
        ? 'totals'
        : 'events',
  );
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedKind)
      setSection(
        selectedKind === 'chapter_plan'
          ? 'plans'
          : selectedKind === 'master_outline'
            ? 'totals'
            : 'events',
      );
  }, [selectedKind]);
  const documents = [...structure.documents].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );
  const available = documents.filter((item) => showArchived || !item.archived);
  const events = available.filter((item) => isStoryEventKind(item.kind));
  const plans = available.filter((item) => item.kind === 'chapter_plan');
  const totals = available.filter((item) => item.kind === 'master_outline');
  const chapters = orderedChapters(structure);
  const relatedCount = (item: Document) => {
    const ids = new Set(linkedChapterIds(item));
    return chapters.filter((chapter) => ids.has(chapter.id)).length;
  };
  const visible = (section === 'plans' ? plans : section === 'events' ? events : totals).filter(
    (item) =>
      [
        item.title,
        item.storyTime,
        item.summary,
        structure.documents.find((parent) => parent.id === item.parentOutlineId)?.title,
        structure.volumes.find((volume) => volume.id === item.volumeId)?.title,
        ...chapters
          .filter((chapter) => linkedChapterIds(item).includes(chapter.id))
          .map((chapter) => chapter.title),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const kind =
    section === 'plans'
      ? 'chapter_plan'
      : section === 'events'
        ? 'chapter_outline'
        : 'master_outline';
  return (
    <aside
      id="workspace-outline-sidebar"
      className="sidebar outline-sidebar outline-reader-index"
      aria-label="故事时间线目录"
    >
      <header className="outline-index-header">
        <nav className="outline-index-tabs" aria-label="规划分类">
          <button
            type="button"
            aria-pressed={section === 'totals'}
            onClick={() => setSection('totals')}
          >
            故事总纲
          </button>
          <button
            type="button"
            aria-pressed={section === 'events'}
            onClick={() => setSection('events')}
          >
            故事时间线
          </button>
          <button
            type="button"
            aria-pressed={section === 'plans'}
            onClick={() => setSection('plans')}
          >
            章纲
          </button>
        </nav>
        <label className="sr-only" htmlFor="outline-search">
          搜索事件、大纲与关联章节
        </label>
        <input
          id="outline-search"
          type="search"
          placeholder="搜索规划"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>
      <nav aria-label="总纲与故事时间线" className="outline-index-list">
        {visible.map((item) => {
          const group = section === 'plans' ? plans : events;
          const index = group.indexOf(item);
          const selected = item.id === documentId;
          const event = isStoryEventKind(item.kind) || item.kind === 'chapter_plan';
          return (
            <article
              key={item.id}
              className={`outline-index-item${selected ? ' is-selected' : ''}`}
              draggable={event && !busy && !query.trim() && !showArchived}
              onDragStart={(drag) => {
                drag.dataTransfer.setData('text/plain', item.id);
                drag.dataTransfer.effectAllowed = 'move';
                setDraggedId(item.id);
              }}
              onDragEnd={() => setDraggedId(null)}
              onDragOver={(drag) => {
                if (event && draggedId && !busy && !query.trim() && !showArchived)
                  drag.preventDefault();
              }}
              onDrop={(drag) => {
                drag.preventDefault();
                if (
                  event &&
                  draggedId &&
                  draggedId !== item.id &&
                  !busy &&
                  !query.trim() &&
                  !showArchived
                )
                  onReorder(draggedId, item.id);
                setDraggedId(null);
              }}
            >
              <button
                type="button"
                className="outline-index-open"
                aria-current={selected ? 'page' : undefined}
                onClick={() => onOpen(item.id)}
              >
                <FileText size={17} aria-hidden="true" />
                <span className="outline-index-copy">
                  <strong>
                    {item.title}
                    {item.archived ? '（已归档）' : ''}
                  </strong>
                  {event && (
                    <small>
                      {item.kind === 'chapter_plan'
                        ? `${relatedCount(item) ? '已关联正文' : '待写正文'} · ${structure.documents.find((parent) => parent.id === item.parentOutlineId)?.title ?? '独立章纲'}`
                        : `关联正文 ${relatedCount(item)} 章`}
                    </small>
                  )}
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
              {selected && item.storyTime && (
                <p className="outline-index-time">
                  <Clock3 size={14} aria-hidden="true" />
                  {item.storyTime}
                </p>
              )}
              {selected && event && (
                <div className="outline-index-order">
                  <button
                    type="button"
                    aria-label={`上移${item.kind === 'chapter_plan' ? '章纲' : '事件'}：${item.title}`}
                    disabled={busy || index === 0 || Boolean(query.trim()) || showArchived}
                    onClick={() => {
                      const previous = group[index - 1];
                      if (previous) onReorder(item.id, previous.id);
                    }}
                  >
                    <ArrowUp size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`下移${item.kind === 'chapter_plan' ? '章纲' : '事件'}：${item.title}`}
                    disabled={
                      busy || index === group.length - 1 || Boolean(query.trim()) || showArchived
                    }
                    onClick={() => {
                      const next = group[index + 1];
                      if (next) onReorder(item.id, next.id);
                    }}
                  >
                    <ArrowDown size={13} aria-hidden="true" />
                  </button>
                </div>
              )}
            </article>
          );
        })}
        {!visible.length && (
          <p className="outline-empty-note">
            {query.trim()
              ? '没有匹配的规划。'
              : section === 'plans'
                ? '先把卷规划拆成多章，再逐章展开正文。'
                : section === 'events'
                  ? '添加故事事件，规划关键转折与人物的选择。'
                  : '写下故事的起点、转折与结局。'}
          </p>
        )}
      </nav>
      <div className="outline-index-create">
        <button type="button" disabled={busy} onClick={() => onCreate(kind)}>
          <Plus size={15} aria-hidden="true" />
          {section === 'plans'
            ? '添加章纲'
            : section === 'events'
              ? '添加故事事件'
              : '新建故事总纲'}
        </button>
        <button type="button" disabled={busy} onClick={() => onAiCreate(kind)}>
          <Sparkles size={15} aria-hidden="true" />
          {section === 'plans'
            ? 'AI 拆分章纲'
            : section === 'events'
              ? 'AI 规划事件'
              : 'AI 生成总纲'}
        </button>
      </div>
      <details className="outline-index-tools">
        <summary>大纲管理</summary>
        <button type="button" onClick={onManage}>
          大纲与时间线管理
        </button>
        <label className="outline-archive-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(change) => setShowArchived(change.target.checked)}
          />
          显示已归档总纲与事件
        </label>
      </details>
    </aside>
  );
}
