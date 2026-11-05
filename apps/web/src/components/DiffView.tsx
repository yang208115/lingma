import { diffLines } from 'diff';
import { useMemo } from 'react';

export function DiffView({
  before,
  after,
  variant = 'standard',
}: {
  before: string;
  after: string;
  variant?: 'standard' | 'prose';
}) {
  const changes = useMemo(
    () =>
      diffLines(before, after, { maxEditLength: 2000, timeout: 100 })?.map((change) => ({
        ...change,
        key: crypto.randomUUID(),
      })),
    [before, after],
  );
  if (!changes)
    return (
      <div className={`comparison${variant === 'prose' ? ' prose-diff-fallback' : ''}`}>
        <pre>{before}</pre>
        <pre>{after}</pre>
      </div>
    );
  if (variant === 'prose')
    return (
      <section className="prose-diff" aria-label="文本差异">
        {changes.map((change) => (
          <div
            key={change.key}
            className={`prose-diff-block${change.added ? ' is-added' : change.removed ? ' is-removed' : ''}`}
          >
            {(change.added || change.removed) && (
              <span className="prose-diff-marker" aria-label={change.added ? '新增' : '删除'}>
                {change.added ? '+' : '−'}
              </span>
            )}
            <span className="prose-diff-text">{change.value}</span>
          </div>
        ))}
      </section>
    );
  return (
    <section aria-label="文本差异">
      <pre className="diff">
        {changes.map((change) => (
          <span
            key={change.key}
            className={change.added ? 'added' : change.removed ? 'removed' : ''}
          >
            {change.added ? '＋ ' : change.removed ? '－ ' : '  '}
            {change.value}
          </span>
        ))}
      </pre>
    </section>
  );
}
