import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const assets = new URL('../apps/web/dist/assets/', import.meta.url);
const scripts = (await readdir(assets)).filter((name) => name.endsWith('.js'));
assert.ok(scripts.length > 0, 'Browser build missing');
for (const name of scripts) {
  const content = await readFile(new URL(name, assets), 'utf8');
  for (const forbidden of [
    'better-sqlite3',
    'proper-lockfile',
    'node:fs',
    'node:crypto',
    'pi-ai',
    'FakeModelAdapter',
    'WorkbenchDatabase',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'credentials.enc',
  ]) {
    assert.ok(!content.includes(forbidden), `Browser bundle contains ${forbidden}`);
  }
}
console.log('Browser build contains no server, agent, database or credential markers.');
