import type { RunDetail } from '@lingma/shared';
import { describe, expect, it } from 'vitest';
import {
  workflowDuration,
  workflowLiveText,
  workflowProgress,
  workflowToolActivity,
} from '../src/components/workflow-presentation.js';

type ProgressInput = Parameters<typeof workflowProgress>[0];
const base: ProgressInput = {
  status: 'running',
  pauseRequested: false,
  outcome: null,
  acceptedResults: [],
  proposal: null,
  snapshot: { input: { taskType: 'chapter_write' } },
  nodes: [{ name: '正文初稿', templateKey: 'draft', stage: 'draft', status: 'running', round: 0 }],
};

describe('workflow progress for authors', () => {
  it('keeps generated text across tool turns and falls back to a retained final output', () => {
    const turns = [
      { partialText: '先核对人物设定。' },
      { partialText: '' },
      { partialText: '雨声落在窗沿。' },
    ] as RunDetail['turns'];
    expect(workflowLiveText({ turns, output: null })).toBe('先核对人物设定。\n\n雨声落在窗沿。');
    expect(
      workflowLiveText({ turns: [], output: { text: '保留的完整候选' } } as unknown as Pick<
        RunDetail,
        'turns' | 'output'
      >),
    ).toBe('保留的完整候选');
  });

  it('reports the current tool and thinking activity without requiring diagnostics to be opened', () => {
    const detail = {
      status: 'running',
      turns: [{ thinking: '正在组织情节', partialText: '' }],
      tools: [
        { name: 'read_document', result: { ok: true } },
        { name: 'search_documents', result: null },
      ],
    } as RunDetail;
    expect(workflowToolActivity(detail)).toBe('正在搜索资料…');
    expect(workflowToolActivity({ ...detail, tools: [] })).toBe('正在思考与组织内容…');
    expect(workflowToolActivity({ ...detail, status: 'completed', tools: [] })).toBe(
      '本步骤已完成',
    );
  });

  it.each([
    [0, '0 秒'],
    [59_999, '59 秒'],
    [60_000, '1 分 0 秒'],
    [112_000, '1 分 52 秒'],
    [3_661_000, '1 小时 1 分 1 秒'],
  ])('formats %i ms as %s', (milliseconds, expected) => {
    expect(workflowDuration(milliseconds)).toBe(expected);
  });

  it('distinguishes waiting for the executor from generating text', () => {
    expect(workflowProgress(base).title).toBe('正在撰写正文');
    const waiting = workflowProgress({
      ...base,
      nodes: base.nodes.map((node) => ({ ...node, status: 'queued' })),
    });
    expect(waiting.title).toBe('等待开始：正文初稿');
    expect(waiting.detail).toContain('本地一次处理一个任务');
  });

  it('reports the actual review and revision number without claiming a saved chapter', () => {
    const review = workflowProgress({
      ...base,
      nodes: [
        {
          name: '一致性审校',
          templateKey: 'continuity',
          stage: 'review',
          status: 'running',
          round: 9,
        },
      ],
    });
    expect(review.title).toBe('正在检查人物设定与时间线');
    expect(review.detail).toContain('第 9 次修订后复审');
    expect(review.detail).toContain('尚未保存');
  });

  it('distinguishes generated candidates, accepted documents and rejected outputs', () => {
    expect(workflowProgress({ ...base, status: 'awaiting_acceptance' }).title).toBe(
      '正文已生成，等待你确认',
    );
    expect(
      workflowProgress({ ...base, status: 'completed', outcome: 'accepted', acceptedResults: [{}] })
        .title,
    ).toBe('正文已保存');
    expect(
      workflowProgress({
        ...base,
        status: 'completed',
        outcome: 'accepted',
        proposal: { status: 'accepted' },
      }).title,
    ).toBe('正文已保存');
    expect(workflowProgress({ ...base, status: 'completed', outcome: 'rejected' }).title).toBe(
      '结果未采用',
    );
  });

  it('explains deferred pause and exposes manual confirmation separately', () => {
    expect(workflowProgress({ ...base, pauseRequested: true }).title).toBe(
      '正在完成当前步骤，随后暂停',
    );
    const gate = workflowProgress({
      ...base,
      status: 'awaiting_input',
      nodes: base.nodes.map((node) => ({ ...node, status: 'awaiting_gate' })),
    });
    expect(gate.title).toBe('请确认「正文初稿」的内容');
  });

  it('does not describe confirming a discussion as saving a document', () => {
    const discussion: ProgressInput = {
      ...base,
      status: 'completed',
      outcome: 'accepted',
      snapshot: { input: { taskType: 'discussion' } },
    };
    expect(workflowProgress(discussion).title).toBe('讨论结论已确认');
  });
});
