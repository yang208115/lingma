import type { Proposal } from '@lingma/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { DiffView } from './DiffView.js';

export function ProposalDiff({
  proposal,
  revealRequest = 0,
  contentLabel = '正文',
}: {
  proposal: Proposal;
  revealRequest?: number;
  contentLabel?: string;
}) {
  const section = useRef<HTMLElement>(null);
  const lastReveal = useRef<{ request: number; before: string; after: string } | null>(null);
  const { targetDocumentId, baseVersionId, scope, content } = proposal;
  const [result, setResult] = useState<{
    requestId: string;
    content: string | null;
    error: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestId = `${targetDocumentId}:${baseVersionId}:${attempt}`;
  useEffect(() => {
    let alive = true;
    void api.version(targetDocumentId, baseVersionId).then(
      (version) => {
        if (alive) setResult({ requestId, content: version.content, error: '' });
      },
      (cause: unknown) => {
        if (alive)
          setResult({
            requestId,
            content: null,
            error: cause instanceof Error ? cause.message : '无法读取原文',
          });
      },
    );
    return () => {
      alive = false;
    };
  }, [targetDocumentId, baseVersionId, requestId]);

  const original = result?.requestId === requestId ? result.content : null;
  const error = result?.requestId === requestId ? result.error : '';
  const after =
    original !== null && scope.kind === 'selection'
      ? original.slice(0, scope.selection.from) + content + original.slice(scope.selection.to)
      : content;
  const before = original;
  useLayoutEffect(() => {
    const root = section.current;
    if (!root || before === null || error) return;
    if (
      lastReveal.current?.request === revealRequest &&
      lastReveal.current.before === before &&
      lastReveal.current.after === after
    )
      return;
    const target =
      root.querySelector<HTMLElement>('.prose-diff-block.is-added, .prose-diff-block.is-removed') ??
      root;
    const scroller = root.closest<HTMLElement>('.writing-area');
    if (!scroller) return;
    lastReveal.current = { request: revealRequest, before, after };
    // Wait for the baseline and rendered changes; a fixed offset would point at the chapter title.
    const toolbarHeight =
      scroller.querySelector('.editor-toolbar')?.getBoundingClientRect().height ?? 0;
    if (['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) {
      scroller.scrollTo({
        top: Math.max(
          0,
          scroller.scrollTop +
            target.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            toolbarHeight -
            24,
        ),
        behavior: 'auto',
      });
    } else {
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [before, after, error, revealRequest]);
  return (
    <section
      ref={section}
      className="proposal-comparison"
      aria-label={`${contentLabel}修改差异`}
      aria-busy={before === null && !error}
    >
      <h4 className="sr-only">与原文的差异</h4>
      <div className="prose-diff-toolbar">
        <span className="prose-diff-caption" title={`对比生成时保存的${contentLabel}`}>
          {before === ''
            ? `新写${contentLabel} · 全部为新增内容`
            : scope.kind === 'selection'
              ? `选区修改 · 其余${contentLabel}保持不变`
              : '全文修改对比'}
        </span>
        <div className="diff-legend" aria-label="差异图例">
          <span className="legend-add">新增</span>
          <span className="legend-remove">删除</span>
        </div>
      </div>
      {proposal.status === 'stale' && <p className="warning">原文已变更，请重新生成提议。</p>}
      {error ? (
        <div role="alert">
          <p className="error">原文加载失败：{error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            重新加载原文
          </button>
        </div>
      ) : before === null ? (
        <p role="status">正在读取原文并比较…</p>
      ) : before === after ? (
        <p>与原文一致，没有{contentLabel}改动。</p>
      ) : (
        <DiffView before={before} after={after} variant="prose" />
      )}
    </section>
  );
}
