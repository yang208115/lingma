import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const data = await mkdtemp(resolve(tmpdir(), 'lingma-smoke-'));
const children = new Set();
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const number = address.port;
  await new Promise((done) => server.close(done));
  return number;
}
function start(args, overrides = {}, cwd = root) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, HOST: '127.0.0.1', DATA_DIR: data, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = once(child, 'exit');
  return { child, exited, output: () => output };
}
async function waitFor(url, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.child.exitCode !== null) throw new Error(child.output());
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch {
      /* server is not listening yet */
    }
    await delay(50);
  }
  throw new Error(`Service did not become ready: ${child.output()}`);
}
async function exitWithin(instance) {
  return Promise.race([
    instance.exited,
    delay(10000, null, { ref: false }).then(() => {
      throw new Error(`Process did not exit: ${instance.output()}`);
    }),
  ]);
}
try {
  const number = await port();
  const base = `http://127.0.0.1:${number}`;
  const server = start(['apps/server/dist/main.js'], { PORT: String(number) });
  assert.deepEqual(await (await waitFor(`${base}/api/v1/ready`, server)).json(), {
    data: { status: 'ready' },
  });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('灵码') && html.includes('/assets/'));
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await fetch(`${base}${asset}`)).status, 200);

  const second = start(['apps/server/dist/main.js'], { PORT: String(await port()) });
  assert.equal((await exitWithin(second))[0], 1);
  assert.ok(second.output().includes('已有实例占用'));
  assert.equal((await fetch(`${base}/ready`)).status, 200);

  const invalid = start(['apps/server/dist/main.js'], {
    HOST: '0.0.0.0',
    PORT: 'secret-invalid-value',
  });
  assert.equal((await exitWithin(invalid))[0], 1);
  assert.ok(invalid.output().includes('配置无效'));
  assert.ok(!invalid.output().includes('secret-invalid-value'));

  const webPort = await port();
  const dev = start(
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    { PORT: String(number) },
    resolve(root, 'apps/web'),
  );
  assert.ok(
    (await (await waitFor(`http://127.0.0.1:${webPort}/`, dev)).text()).includes('/src/main.tsx'),
  );
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${webPort}/api/v1/ready`)).json(), {
    data: { status: 'ready' },
  });
  dev.child.kill('SIGTERM');
  await exitWithin(dev);

  server.child.kill('SIGTERM');
  assert.equal((await exitWithin(server))[0], 0);
  const restarted = start(['apps/server/dist/main.js'], { PORT: String(number) });
  await waitFor(`${base}/ready`, restarted);
  restarted.child.kill('SIGTERM');
  assert.equal((await exitWithin(restarted))[0], 0);
  console.log(
    'Smoke passed: production assets/API, dev proxy, duplicate lock, invalid config, SIGTERM and restart.',
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await rm(data, { recursive: true, force: true });
}
