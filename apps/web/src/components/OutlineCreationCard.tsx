import type { OutlineCreationProposal } from '@lingma/shared';
import { ListTree } from 'lucide-react';
import { useState } from 'react';
import { MarkdownContent } from './MarkdownContent.js';

export function OutlineCreationCard({
  proposal,
  volumes = [],
  busy,
  generating,
  onAccept,
  onReject,
  onOpen,
}: {
  proposal: OutlineCreationProposal;
  volumes?: { id: string; title: string }[];
  busy: boolean;
  generating: boolean;
  onAccept(): void;
  onReject(): void;
  onOpen(id: string): void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const pending = proposal.status === 'pending';
  const master = proposal.payload.kind === 'master_outline';
  const chapter = proposal.payload.kind === 'chapter';
  const chapterItem = proposal.payload.kind === 'chapter' ? proposal.payload.items[0] : null;
  const volumeTitle =
    chapterItem?.newVolumeTitle ||
    (chapterItem?.volumeId
      ? (volumes.find((volume) => volume.id === chapterItem.volumeId)?.title ?? '目标卷已不可用')
      : '未分卷');
  const first = proposal.acceptedDocuments[0];
  return (
    <article className="proposal-card outline-creation-card">
      <h3>
        <ListTree size={16} aria-hidden="true" />
        {chapter ? '新建章节候选' : master ? '故事总纲候选' : '新增故事事件'}
      </h3>
      {chapterItem && (
        <>
          <p className="proposal-target">新建到：{volumeTitle}</p>
          <p className="proposal-target">章节标题：{chapterItem.title}</p>
        </>
      )}
      <p>{proposal.payload.reason}</p>
      <p className="muted">
        {chapter ? '1 个章节' : master ? '1 份总纲' : `${proposal.payload.items.length} 个事件`} ·{' '}
        {pending
          ? '待确认创建'
          : proposal.status === 'accepted'
            ? chapter
              ? '已创建章节'
              : master
                ? '已保存为故事总纲'
                : '已加入故事时间线'
            : '已拒绝'}
      </p>
      <div className="outline-creation-items">
        {proposal.payload.items.map((item, index) => (
          <details
            // biome-ignore lint/suspicious/noArrayIndexKey: Proposal items are an immutable ordered snapshot.
            key={`${proposal.id}:${index}`}
            open={expanded === index}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setExpanded((previous) => (open ? index : previous === index ? null : previous));
            }}
          >
            <summary>
              {index + 1}. {item.title}
            </summary>
            {expanded === index && (
              <>
                {'volumeId' in item && (
                  <p className="muted">
                    所属卷：
                    {item.newVolumeTitle
                      ? `${item.newVolumeTitle}（同名卷复用）`
                      : item.volumeId
                        ? (volumes.find((volume) => volume.id === item.volumeId)?.title ??
                          '所属卷已不可用')
                        : '未分卷'}
                  </p>
                )}
                {'outlineIds' in item && item.outlineIds.length > 0 && (
                  <p className="muted">关联 {item.outlineIds.length} 个故事事件</p>
                )}
                {'storyTime' in item && item.storyTime && (
                  <p className="muted">故事时间：{item.storyTime}</p>
                )}
                {'summary' in item && item.summary && <p>{item.summary}</p>}
                {item.content ? (
                  <MarkdownContent text={item.content} outline={!chapter} />
                ) : (
                  <p className="muted">空白章节，确认创建后可开始写作。</p>
                )}
              </>
            )}
          </details>
        ))}
      </div>
      {pending && (
        <>
          {generating && <p className="muted">生成结束后即可确认创建。</p>}
          <div className="outline-creation-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || generating}
              onClick={onAccept}
            >
              {chapter
                ? '创建章节'
                : master
                  ? '保存故事总纲'
                  : proposal.payload.items.length === 1
                    ? '添加事件'
                    : `添加这 ${proposal.payload.items.length} 个事件`}
            </button>
            <button type="button" disabled={busy || generating} onClick={onReject}>
              拒绝
            </button>
          </div>
        </>
      )}
      {proposal.status === 'accepted' && first && (
        <button type="button" disabled={busy} onClick={() => onOpen(first.documentId)}>
          {chapter ? '打开章节' : master ? '打开总纲' : '打开事件'}
        </button>
      )}
    </article>
  );
}
