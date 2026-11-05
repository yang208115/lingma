import { describe, expect, it } from 'vitest';
import {
  actionCallSchema,
  actionSchemas,
  agentProfileConfigSchema,
  canTransitionRun,
  createRunSchema,
  documentSchema,
  errorResponseSchema,
  idempotencyKeySchema,
  outlineCreationPayloadSchema,
  paginationSchema,
  relativePathSchema,
  runEventSchema,
  selectionSchema,
  usageSchema,
  workflowTemplateConfigSchema,
} from '../src/index.js';

const id = '11111111-1111-4111-8111-111111111111';
describe('shared contracts', () => {
  it('validates envelopes and retains unknown usage as null', () => {
    expect(
      usageSchema.parse({ inputTokens: null, outputTokens: null, cost: null }).inputTokens,
    ).toBeNull();
    expect(
      errorResponseSchema.safeParse({
        error: {
          code: 'VERSION_CONFLICT',
          message: '已更新',
          requestId: 'req',
          details: { currentVersionId: id },
        },
      }).success,
    ).toBe(true);
    expect(usageSchema.safeParse({ inputTokens: -1, outputTokens: 0, cost: null }).success).toBe(
      false,
    );
  });
  it('uses bounded cursor pagination and keys', () => {
    expect(paginationSchema.parse({}).limit).toBe(50);
    expect(paginationSchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(idempotencyKeySchema.safeParse('with space').success).toBe(false);
    expect(idempotencyKeySchema.parse('run_create-123')).toBe('run_create-123');
  });
  it('rejects invalid selections, attachment traversal and incorrect chapter relations', () => {
    expect(selectionSchema.safeParse({ from: 20, to: 10, textHash: 'a'.repeat(64) }).success).toBe(
      false,
    );
    for (const path of [
      '../private',
      '/etc/passwd',
      'a/../b',
      'a\\b',
      'C:/x',
      'a//b',
      'a/./b',
      'a\0b',
    ]) {
      expect(relativePathSchema.safeParse(path).success, path).toBe(false);
    }
    expect(relativePathSchema.parse('references/人物.md')).toBe('references/人物.md');
    expect(
      documentSchema.safeParse({
        id,
        projectId: id,
        volumeId: null,
        kind: 'chapter_outline',
        chapterId: null,
        title: '章纲',
        sortOrder: 0,
        currentVersionId: id,
        deletedAt: null,
      }).success,
    ).toBe(false);
  });
  it('checks purpose and disallows credential fields in task creation', () => {
    const run = {
      projectId: null,
      sessionId: null,
      purpose: 'skill_test',
      input: '检查矛盾',
      skillVersionId: id,
      providerConfigId: id,
      modelId: 'fake',
      context: { selectedVersionIds: [], allowSearch: false, allowFutureOutline: false },
      limits: {},
    };
    expect(createRunSchema.parse(run).limits).toEqual({});
    expect(createRunSchema.parse({ ...run, limits: undefined }).limits).toBeUndefined();
    expect(
      createRunSchema.parse({
        ...run,
        limits: { maxTurns: 1, maxToolCallsPerTurn: 1, deadlineMs: 1000 },
      }).limits,
    ).toEqual({});
    expect(createRunSchema.safeParse({ ...run, purpose: 'write' }).success).toBe(false);
    expect(createRunSchema.safeParse({ ...run, apiKey: 'not-a-real-secret' }).success).toBe(false);
    expect(
      createRunSchema.safeParse({ ...run, target: { documentId: id, baseVersionId: id } }).success,
    ).toBe(false);
  });
  it('discards retired execution limits from stored role and template configurations', () => {
    const role = agentProfileConfigSchema.parse({
      name: '作者',
      capability: 'draft',
      prompt: '创作正文',
      maxTurns: 3,
      timeoutMs: 300000,
      maxOutputTokens: 4096,
    });
    expect(role).not.toHaveProperty('maxTurns');
    expect(role).not.toHaveProperty('timeoutMs');
    expect(role).not.toHaveProperty('maxOutputTokens');
    const template = workflowTemplateConfigSchema.parse({
      name: '流程',
      maxModelCalls: 24,
      deadlineMs: 1800000,
      steps: [
        { key: 'draft', name: '写作', stage: 'draft', agentVersionId: id },
        { key: 'review', name: '审校', stage: 'review', agentVersionId: id, dependsOn: ['draft'] },
      ],
    });
    expect(template).not.toHaveProperty('maxModelCalls');
    expect(template).not.toHaveProperty('deadlineMs');
  });
  it('validates discriminated action calls and bounded results', () => {
    expect(
      actionCallSchema.parse({ callId: 'c1', name: 'search_documents', args: { query: '铜铃' } })
        .args,
    ).toEqual({ query: '铜铃', limit: 5 });
    expect(actionCallSchema.safeParse({ callId: 'c2', name: 'shell', args: {} }).success).toBe(
      false,
    );
    expect(
      actionCallSchema.safeParse({
        callId: 'c3',
        name: 'read_document',
        args: { documentId: id, versionId: id, path: '/private' },
      }).success,
    ).toBe(false);
    expect(actionSchemas.read_document.result.safeParse({}).success).toBe(false);
  });
  it('separates total-outline creation from events and reads legacy event candidates', () => {
    const args = {
      title: '故事总纲',
      content: '起点、转折与结局。',
      reason: '作者要求',
      citations: [],
    };
    expect(
      actionCallSchema.parse({ callId: 'master', name: 'propose_master_outline', args }).args,
    ).toEqual(args);
    expect(
      actionSchemas.propose_master_outline.args.safeParse({ ...args, content: ' ' }).success,
    ).toBe(false);
    expect(
      actionSchemas.propose_master_outline.args.safeParse({ items: [args], reason: args.reason })
        .success,
    ).toBe(false);
    const events = {
      items: [{ title: '事件', content: '完整事件纲要' }],
      reason: '拆分',
      citations: [],
    };
    expect(outlineCreationPayloadSchema.parse(events).kind).toBe('chapter_outline');
    expect(
      outlineCreationPayloadSchema.safeParse({ ...events, kind: 'master_outline' }).success,
    ).toBe(true);
    expect(
      outlineCreationPayloadSchema.safeParse({
        ...events,
        kind: 'master_outline',
        items: [...events.items, ...events.items],
      }).success,
    ).toBe(false);
  });
  it('rejects incompatible event versions and nonterminal finished states', () => {
    const event = {
      schemaVersion: 1,
      runId: id,
      seq: 1,
      type: 'text.delta',
      turnIndex: 0,
      messageId: id,
      text: '他停在门前。',
    };
    expect(runEventSchema.parse(event).type).toBe('text.delta');
    expect(runEventSchema.safeParse({ ...event, schemaVersion: 2 }).success).toBe(false);
    expect(runEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false);
    expect(
      runEventSchema.safeParse({ ...event, type: 'run.finished', status: 'running' }).success,
    ).toBe(false);
    expect(canTransitionRun('running', 'completed')).toBe(true);
    expect(canTransitionRun('completed', 'running')).toBe(false);
    expect(canTransitionRun('cancelling', 'completed')).toBe(false);
  });
});
