import { randomUUID } from 'node:crypto';
import type { SkillImportJob } from '@lingma/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, request } from '../src/api.js';
import { skillApi } from '../src/skill-api.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function job(status: SkillImportJob['status']): SkillImportJob {
  return {
    id: randomUUID(),
    type: 'local',
    skillId: null,
    baseVersionId: null,
    status,
    source: { type: 'local', ref: 'test', commit: null, subdir: null },
    versionId: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
function file(path: string) {
  const value = new File(['test'], path.split('/').at(-1) as string);
  Object.defineProperty(value, 'webkitRelativePath', { value: path });
  return value;
}

it('waits for each import to finish, retries explicit busy rejections and polls through a transient proxy failure', async () => {
  vi.useFakeTimers();
  const first = job('queued');
  const second = job('queued');
  let uploads = 0;
  let reads = 0;
  let finished = false;
  const upload = vi.spyOn(skillApi, 'local').mockImplementation(async () => {
    uploads++;
    if (uploads === 1) throw new ApiError('PROJECT_BUSY', 'busy');
    if (uploads === 2) return first;
    expect(finished).toBe(true);
    return second;
  });
  vi.spyOn(skillApi, 'job').mockImplementation(async (id) => {
    if (id === second.id) return { ...second, status: 'failed', error: 'entry invalid' };
    reads++;
    if (reads === 1) throw new ApiError('HTTP_ERROR', 'proxy unavailable', { status: 502 });
    if (reads === 2) return { ...first, status: 'publishing' };
    finished = true;
    return { ...first, status: 'completed' };
  });
  const events = vi.fn();
  const pending = skillApi.localDirectory(
    [file('skills/a/SKILL.md'), file('skills/b/SKILL.md'), file('skills/README.md')],
    events,
  );
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(upload).toHaveBeenCalledTimes(3);
  expect(result.jobs.map((item) => item.status)).toEqual(['completed', 'failed']);
  expect(result.failures).toEqual([{ directory: 'skills/b/', message: 'entry invalid' }]);
  expect(result.ignored).toEqual(['skills/README.md']);
  expect(events).toHaveBeenCalledWith(
    expect.objectContaining({ id: first.id, status: 'completed' }),
  );
});

it('does not resubmit an upload with an ambiguous response', async () => {
  const upload = vi
    .spyOn(skillApi, 'local')
    .mockRejectedValue(new ApiError('INVALID_RESPONSE', 'unreadable'));
  const result = await skillApi.localDirectory([file('skills/a/SKILL.md')], vi.fn());
  expect(upload).toHaveBeenCalledTimes(1);
  expect(result.failures).toHaveLength(1);
});

it('reports the HTTP status of a non-JSON response without exposing its raw contents', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('proxy internal details', {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    }),
  );
  await expect(request('/skills', { parse: (value) => value })).rejects.toMatchObject({
    code: 'HTTP_ERROR',
    message: expect.stringContaining('HTTP 502'),
    details: { status: 502 },
  });
});
