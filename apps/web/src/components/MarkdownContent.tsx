import { normalizeOutlineMarkdown } from '@lingma/shared';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

export function MarkdownContent({ text, outline = false }: { text: string; outline?: boolean }) {
  return (
    <div className="markdown-content">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          table: ({ children }) => (
            <div
              className="markdown-table-scroll"
              role="region"
              aria-label="表格，可横向滚动"
              tabIndex={0}
            >
              <table>{children}</table>
            </div>
          ),
          img: ({ alt }) => <span className="muted">[图片：{alt || '未命名'}]</span>,
          a: ({ href, children }) =>
            href && /^(https?:|mailto:)/i.test(href) ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {outline ? normalizeOutlineMarkdown(text) : text}
      </Markdown>
    </div>
  );
}
