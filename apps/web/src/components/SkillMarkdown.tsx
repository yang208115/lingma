import Markdown from 'react-markdown';

export function SkillMarkdown({ text, onFile }: { text: string; onFile(path: string): void }) {
  return (
    <div className="skill-markdown">
      <Markdown
        skipHtml
        components={{
          img: ({ alt }) => (
            <span className="muted">[图片：{alt || '未命名'}，请在附件中查看或下载]</span>
          ),
          a: ({ href, children }) => {
            if (href && /^https?:\/\//i.test(href))
              return (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {children}
                </a>
              );
            if (href?.startsWith('#')) return <span>{children}</span>;
            let path = '';
            try {
              path = decodeURIComponent((href ?? '').split(/[?#]/)[0] ?? '').replace(/^\.\//, '');
            } catch {
              /* Invalid links remain inert. */
            }
            if (
              !path ||
              path.startsWith('/') ||
              path.includes('\\') ||
              path.split('/').includes('..') ||
              /^[a-z][a-z0-9+.-]*:/i.test(path)
            )
              return <span>{children}</span>;
            return (
              <button type="button" className="inline-link" onClick={() => onFile(path)}>
                {children}
              </button>
            );
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
