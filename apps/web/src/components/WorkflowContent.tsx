import type { Json } from '@lingma/shared';
import {
  parseWorkflowContent,
  workflowContentLabel,
  workflowContentMetadata,
} from '../workflow-content.js';
import { MarkdownContent } from './MarkdownContent.js';

function StructuredValue({ value, depth = 0 }: { value: Json; depth?: number }) {
  if (value === null) return <span className="muted">未填写</span>;
  if (typeof value === 'string') return <WorkflowContent text={value} depth={depth + 1} />;
  if (typeof value !== 'object')
    return <span>{typeof value === 'boolean' ? (value ? '是' : '否') : value}</span>;
  if (depth > 16) return <MarkdownContent text={JSON.stringify(value)} />;
  if (Array.isArray(value))
    return value.length ? (
      <ol className="workflow-content-list">
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 结构化内容只读，无稳定 id
          <li key={`${index}:${JSON.stringify(item)}`}>
            <StructuredValue value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    ) : (
      <span className="muted">无</span>
    );
  return (
    <dl className="workflow-content-fields">
      {Object.entries(value)
        .filter(([key]) => !workflowContentMetadata.has(key))
        .map(([key, item]) => (
          <div key={key}>
            <dt>{workflowContentLabel(key)}</dt>
            <dd>
              <StructuredValue value={item} depth={depth + 1} />
            </dd>
          </div>
        ))}
    </dl>
  );
}

export function WorkflowContent({ text, depth = 0 }: { text: string; depth?: number }) {
  const structured = depth <= 16 ? parseWorkflowContent(text) : undefined;
  return structured === undefined ? (
    <MarkdownContent text={text} />
  ) : (
    <StructuredValue value={structured} depth={depth} />
  );
}
