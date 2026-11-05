import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startModelFixture } from '../scripts/model-fixture.mjs';
import { startSseTestProxy } from '../scripts/sse-test-proxy.mjs';

const directory = await mkdtemp(resolve(tmpdir(), 'lingma-e2e-'));
const model = await startModelFixture();
const proxy = await startSseTestProxy();
const child = spawn(process.execPath, ['apps/server/dist/main.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: '4177', DATA_DIR: directory },
  stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
child.once('exit', async (code) => {
  model.closeAllConnections();
  model.close();
  proxy.closeAllConnections();
  proxy.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(code ?? 0);
});
