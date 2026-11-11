import {
  type Document,
  isStoryEventKind,
  linkedChapterIds,
  orderedChapters,
  readElementData,
  type Structure,
} from '@lingma/shared';
import { Clock3, History, Pencil, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { MarkdownContent } from './MarkdownContent.js';

export function OutlineReaderToolbar({
  projectTitle,
  label,
  assistantOpen,
  onAssistant,
}: {
  projectTitle: string;
  label: string;
  assistantOpen: boolean;
  onAssistant(): void;
}) {
  return (
    <header className="outline-reader-toolbar">
      <div className="outline-breadcrumb">
        <span>{projectTitle}</span>
        <span aria-hidden="true">/</span>
        <span>故事大纲</span>
        <span className="outline-kind-label">{label}</span>
      </div>
      <button
        id="outline-assistant-toggle"
        type="button"
        onClick={onAssistant}
        aria-controls="workspace-ai-assistant"
        aria-expanded={assistantOpen}
      >
        <Sparkles size={15} aria-hidden="true" /> 大纲助手
      </button>
    </header>
  );
}

export function OutlinePlanView({
  document,
  structure,
  content,
  metadataText,
  busy,
  onEdit,
  onDraft,
  onHistory,
  onPlan,
  children,
}: {
  document: Document;
  structure: Structure;
  content: string;
  metadataText: string;
  busy: boolean;
  onEdit(): void;
  onDraft(): void;
  onHistory(): void;
  onPlan(): void;
  children?: ReactNode;
}) {
  const view = useRef<HTMLElement>(null);
  useEffect(() => {
    if (document.id) view.current?.closest('.writing-area')?.scrollTo({ top: 0 });
  }, [document.id]);
  const event = isStoryEventKind(document.kind);
  const ids = new Set(linkedChapterIds(document));
  const linked = orderedChapters(structure).filter((chapter) => ids.has(chapter.id));
  let summary = document.summary ?? '';
  try {
    summary ||= readElementData(JSON.parse(metadataText)).summary;
  } catch {
    // Invalid metadata remains editable through the existing document editor.
  }
  return (
    <section ref={view} className="outline-plan-view" aria-label="当前故事规划">
      <article className="outline-reading-column">
        <div className="outline-reader-heading">
          <h1>{document.title}</h1>
          <p className="outline-reader-meta">
            <span>
              {document.kind === 'chapter_plan' ? '单章章纲' : event ? '故事规划' : '故事总纲'}
            </span>
            {document.storyTime && (
              <span>
                <Clock3 size={14} aria-hidden="true" />
                {document.storyTime}
              </span>
            )}
            {event && (
              <span>{linked.length ? `已关联正文 ${linked.length} 章` : '尚未关联正文'}</span>
            )}
          </p>
          <div className="outline-reader-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || document.archived}
              onClick={event ? onPlan : onDraft}
            >
              <Sparkles size={16} aria-hidden="true" />
              {document.kind === 'chapter_plan'
                ? linked.length
                  ? '打开关联正文'
                  : '按章纲写正文'
                : event
                  ? '拆分为多章章纲'
                  : '按总纲规划故事事件'}
            </button>
            {event && (
              <button type="button" disabled={busy || document.archived} onClick={onDraft}>
                按此规划起草正文
              </button>
            )}
            <button type="button" disabled={busy} onClick={onEdit}>
              <Pencil size={15} aria-hidden="true" /> 编辑规划
            </button>
            <button type="button" className="outline-reader-history" onClick={onHistory}>
              <History size={15} aria-hidden="true" /> 版本历史
            </button>
          </div>
        </div>
        {summary && (
          <section className="outline-reader-section" aria-labelledby="outline-summary-title">
            <h2 id="outline-summary-title">内容摘要</h2>
            <p className="outline-reader-summary">{summary}</p>
          </section>
        )}
        <section className="outline-reader-section" aria-labelledby="outline-content-title">
          <h2 id="outline-content-title">
            {document.kind === 'chapter_plan' ? '本章情节安排' : event ? '剧情安排' : '故事走向'}
          </h2>
          {content.trim() ? (
            <MarkdownContent text={content} outline />
          ) : (
            <p className="muted">还没有规划内容，点击“编辑规划”写下故事走向。</p>
          )}
        </section>
        {children}
      </article>
    </section>
  );
}
