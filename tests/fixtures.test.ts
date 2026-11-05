import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { FakeModelAdapter, type ModelEvent } from '../packages/agent/src/index.js';
import { actionCallSchema } from '../packages/shared/src/index.js';

it('keeps the synthetic corpus readable and the two-turn fake model compatible with action contracts', async () => {
  const root = resolve(import.meta.dirname, '../fixtures');
  const testCase = JSON.parse(await readFile(resolve(root, 'cases/continuity.json'), 'utf8')) as {
    candidate: string;
    selectedSources: string[];
    excludedFutureSources: string[];
    skill: string;
  };
  for (const path of [
    testCase.candidate,
    ...testCase.selectedSources,
    ...testCase.excludedFutureSources,
    testCase.skill,
  ]) {
    expect((await readFile(resolve(root, path), 'utf8')).length).toBeGreaterThan(0);
  }
  const script = JSON.parse(
    await readFile(resolve(root, 'model/continuity.json'), 'utf8'),
  ) as ModelEvent[][];
  const model = new FakeModelAdapter(script);
  for (let turn = 0; turn < 2; turn++) {
    let responses = 0;
    for await (const event of model.stream(
      {
        connectionSnapshot: {},
        modelId: 'fake',
        systemPrompt: '',
        messages: [],
        toolDefinitions: [],
        parameters: {},
      },
      new AbortController().signal,
    )) {
      if (event.type === 'response') {
        responses++;
        for (const call of event.response.calls)
          expect(
            actionCallSchema.safeParse({ callId: call.id, name: call.name, args: call.arguments })
              .success,
          ).toBe(true);
      }
    }
    expect(responses).toBe(1);
  }
  expect(model.requests).toHaveLength(2);
});
