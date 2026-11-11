import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../src/api.js';

const schema = { parse: (value: unknown) => value };
const unavailable = (status = 502) => new Response('proxy internal details', { status });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('recovers reads through network, proxy and structured maintenance failures', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(unavailable())
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'MAINTENANCE_MODE', message: '服务尚未就绪', requestId: 'test' } },
        { status: 503 },
      ),
    )
    .mockResolvedValueOnce(unavailable(504))
    .mockResolvedValueOnce(Response.json({ data: ['recovered'] }));
  const pending = request('/projects', schema);
  await vi.advanceTimersByTimeAsync(499);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toEqual({ data: ['recovered'] });
  expect(fetch).toHaveBeenCalledTimes(5);
});

it('bounds read retries and preserves the final error', async () => {
  vi.useFakeTimers();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => unavailable());
  const pending = expect(request('/projects', schema)).rejects.toMatchObject({
    code: 'HTTP_ERROR',
    message: expect.stringContaining('HTTP 502'),
    details: { status: 502 },
  });
  await vi.runAllTimersAsync();
  await pending;
  expect(fetch).toHaveBeenCalledTimes(8);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
  'does not replay %s on an ambiguous network or proxy failure',
  async (method) => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(unavailable());
    await expect(request('/projects', schema, { method })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(request('/projects', schema, { method })).rejects.toMatchObject({
      code: 'HTTP_ERROR',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it.each([400, 401, 403, 404, 409, 422, 500])('does not retry HTTP %s errors', async (status) => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(unavailable(status));
  await expect(request('/projects', schema)).rejects.toMatchObject({ details: { status } });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not retry invalid success bodies or schema mismatches', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('not JSON'))
    .mockResolvedValueOnce(Response.json({ data: 'unexpected' }));
  await expect(request('/projects', schema)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  const parse = vi.fn(() => {
    throw new Error('Schema mismatch');
  });
  await expect(request('/projects', { parse })).rejects.toThrow('Schema mismatch');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('cancels a scheduled retry immediately when aborted', async () => {
  vi.useFakeTimers();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => unavailable());
  const controller = new AbortController();
  const pending = expect(
    request('/projects', schema, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not start an already aborted request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const controller = new AbortController();
  controller.abort();
  await expect(request('/projects', schema, { signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(fetch).not.toHaveBeenCalled();
});
