import type { ReviewIssue } from './workflow-artifacts.js';

const heading = /^#{2,4}\s*\[\s*(P[012])\s*\]\s*(.*)$/i;
const clean = /^\s*(无(重要)?问题|没有(发现)?(重要)?问题|通过)/;

/**
 * Reviewers answer in Markdown. Each issue starts with `### [P1] summary`, followed by an
 * optional `> quoted sentence` block and free-form explanation. Parsing is deliberately lenient:
 * nothing is rejected and nothing triggers a retry.
 */
export function parseReviewMarkdown(
  content: string,
  draftText: string,
  idPrefix: string,
): ReviewIssue[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const issues: ReviewIssue[] = [];
  let current: { severity: ReviewIssue['severity']; summary: string; lines: string[] } | null =
    null;
  const flush = () => {
    if (!current) return;
    const quoteLines: string[] = [];
    const bodyLines: string[] = [];
    for (const line of current.lines) {
      if (/^\s*>/.test(line) && bodyLines.every((item) => !item.trim()))
        quoteLines.push(line.replace(/^\s*>\s?/, ''));
      else bodyLines.push(line);
    }
    const quote = quoteLines.join('\n').trim();
    issues.push({
      id: `${idPrefix}:${issues.length + 1}`,
      severity: current.severity,
      summary: current.summary.trim() || '（未命名问题）',
      quote,
      body: bodyLines.join('\n').trim(),
      located: Boolean(quote) && draftText.includes(quote),
      structured: true,
      sources: [],
    });
    current = null;
  };
  for (const line of lines) {
    const match = heading.exec(line);
    if (match) {
      flush();
      current = {
        severity: (match[1] ?? 'P1').toUpperCase() as ReviewIssue['severity'],
        summary: match[2] ?? '',
        lines: [],
      };
    } else current?.lines.push(line);
  }
  flush();
  if (issues.length) return issues;
  const text = content.trim();
  if (!text || clean.test(text)) return [];
  // Unstructured prose is shown to the author as a suggestion; it never drives automatic revision.
  return [
    {
      id: `${idPrefix}:1`,
      severity: 'P2',
      summary: '未结构化意见',
      quote: '',
      body: text.slice(0, 20000),
      located: false,
      structured: false,
      sources: [],
    },
  ];
}

export const reviewMarkdownFormat = [
  '审校输出使用 Markdown。没有需要处理的问题时，只写“无重要问题”。',
  '每个问题以三级标题开头：`### [P0|P1|P2] 一句话概括`，',
  'P0 必须修改，P1 建议修改，P2 仅供参考；',
  '紧接着用 `> ` 原样引用稿件中的原句，再写说明与修改建议。',
].join('');

export type IssueAdoption = Record<string, { decision: 'adopt' | 'ignore'; reason: string }>;
/** P0 and P1 default to adopted, P2 to ignored; an explicit author decision always wins. */
export function effectiveAdoption(
  issue: Pick<ReviewIssue, 'id' | 'severity'>,
  adoption: IssueAdoption,
): 'adopt' | 'ignore' {
  return adoption[issue.id]?.decision ?? (issue.severity === 'P2' ? 'ignore' : 'adopt');
}
export function renderIssuesMarkdown(issues: ReviewIssue[]): string {
  if (!issues.length) return '无重要问题';
  return issues
    .map((issue) =>
      [
        `### [${issue.severity}] ${issue.summary}`,
        issue.quote
          ? issue.quote
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n')
          : '',
        issue.body,
        issue.sources.length ? `来源：${issue.sources.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
    .join('\n\n');
}
