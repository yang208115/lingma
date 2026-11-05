import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ActionRegistry,
  FakeModelAdapter,
  MemoryLoopRecorder,
  runLoop,
} from '../packages/agent/dist/index.js';
import { modelEventSchema } from '../packages/shared/dist/index.js';

const turns = JSON.parse(
  await readFile(new URL('../fixtures/model/continuity.json', import.meta.url), 'utf8'),
).map((turn) => turn.map((event) => modelEventSchema.parse(event)));
const adapter = new FakeModelAdapter(turns);
const recorder = new MemoryLoopRecorder();
let reads = 0;
// An explicitly authorized synthetic read action; production document/version authorization belongs to P05.
const registry = new ActionRegistry({
  read_document: ({ documentId, versionId }) => {
    assert.equal(documentId, '11111111-1111-4111-8111-111111111111');
    assert.equal(versionId, '22222222-2222-4222-8222-222222222222');
    reads++;
    return {
      documentId,
      versionId,
      citationId: `doc:${documentId}@${versionId}#1`,
      contentHash: 'a'.repeat(64),
      excerpt: '林舟惯用左手，铜铃已交给苏禾。',
      from: 0,
      to: 18,
      truncated: false,
    };
  },
});
const result = await runLoop({
  runId: crypto.randomUUID(),
  adapter,
  registry,
  recorder,
  signal: new AbortController().signal,
  request: {
    connectionSnapshot: {},
    modelId: 'synthetic',
    systemPrompt: '仅使用本次授权的合成资料，给出一致性审查结论。',
    messages: [{ role: 'user', content: '检查雾港候选中的惯用手与铜铃保管人。', timestamp: 1 }],
    toolDefinitions: [],
    parameters: {},
  },
});
assert.equal(result.status, 'completed');
assert.equal(result.turns, 2);
assert.equal(reads, 1);
assert.equal(recorder.turns.length, 2);
assert.equal(adapter.requests[1].messages.at(-1).role, 'toolResult');
assert.equal(result.usage.known.inputTokens, null);
console.log(
  JSON.stringify(
    {
      status: result.status,
      turns: result.turns,
      reads,
      checkpointNextTurn: result.checkpoint.nextTurnIndex,
      events: recorder.events.map((event) => event.type),
      usage: result.usage.known,
      result: 'Offline Agent loop verified; no network or model credentials used.',
    },
    null,
    2,
  ),
);
