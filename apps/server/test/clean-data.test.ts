import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { cleanData } from '../scripts/clean-data.js';
import { loadConfig } from '../src/config.js';
import { openRuntime, type Runtime } from '../src/runtime.js';
import { NovelService } from '../src/services/novels.js';
import { LocalCredentials } from '../src/writing/credentials.js';

const roots: string[] = [];
const runtimes: Runtime[] = [];
const quiet = () => {};
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(externalTemp = false) {
  const root = await mkdtemp(join(tmpdir(), 'lingma-clean-test-'));
  roots.push(root);
  const config = loadConfig(
    { DATA_DIR: 'data', ...(externalTemp ? { TEMP_DIR: 'temp' } : {}) },
    root,
  );
  const runtime = await openRuntime(config);
  runtimes.push(runtime);
  new NovelService(runtime.db).createProject('需要清理的作品', 'short');
  runtime.db.connection
    .prepare('INSERT INTO provider_configs VALUES (?, ?, ?, ?)')
    .run(
      'model-id',
      3,
      JSON.stringify({ model: 'saved-model', credentialRef: 'local:test' }),
      'now',
    );
  runtime.db.connection
    .prepare('INSERT INTO provider_checks VALUES (?, ?, ?, ?)')
    .run('check-id', 'model-id', '{}', 'now');
  new LocalCredentials(config.dataDir).set('local:test', 'test-api-key');
  await runtime.blobs.put(new TextEncoder().encode('测试附件'));
  await mkdir(join(config.tempDir, 'novel-imports'), { recursive: true });
  await writeFile(join(config.tempDir, 'novel-imports', 'source'), '导入内容');
  await writeFile(join(config.dataDir, 'backups', 'old.txt'), '旧备份');
  await writeFile(join(root, '.env'), 'TEST=keep');
  return { root, config, runtime };
}

it('previews without changing database, credentials or files', async () => {
  const { root, config, runtime } = await fixture();
  await runtime.close();
  const before = await readFile(join(config.dataDir, 'workbench.sqlite'));
  await cleanData(config, false, quiet);
  expect(await readFile(join(config.dataDir, 'workbench.sqlite'))).toEqual(before);
  expect(await readdir(root)).toEqual(expect.arrayContaining(['data', '.env']));
  expect((await readdir(root)).length).toBe(2);
  expect(new LocalCredentials(config.dataDir).get('local:test')).toBe('test-api-key');
  expect(existsSync(join(config.tempDir, 'novel-imports', 'source'))).toBe(true);
});

it.each([false, true])(
  'cleans business data with a restorable backup (external temp: %s)',
  async (externalTemp) => {
    const { root, config, runtime } = await fixture(externalTemp);
    const original = runtime.db.connection.prepare('SELECT * FROM provider_configs').all();
    const migrations = runtime.db.connection.prepare('SELECT * FROM schema_migrations').all();
    const triggers = runtime.db.connection
      .prepare("SELECT * FROM sqlite_schema WHERE type='trigger' ORDER BY name")
      .all();
    const key = await readFile(join(config.dataDir, 'credentials.key'));
    const encrypted = await readFile(join(config.dataDir, 'credentials.enc'));
    await runtime.close();
    const backup = await cleanData(config, true, quiet);
    expect(backup).toBeTruthy();
    expect(await readFile(join(config.dataDir, 'credentials.key'))).toEqual(key);
    expect(await readFile(join(config.dataDir, 'credentials.enc'))).toEqual(encrypted);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('TEST=keep');
    expect(existsSync(join(config.dataDir, 'blobs'))).toBe(false);
    expect(existsSync(join(config.tempDir, 'novel-imports'))).toBe(false);
    expect(existsSync(join(config.dataDir, 'backups'))).toBe(false);
    const reopened = await openRuntime(config);
    runtimes.push(reopened);
    expect(reopened.db.connection.prepare('SELECT * FROM provider_configs').all()).toEqual(
      original,
    );
    expect(reopened.db.connection.prepare('SELECT * FROM schema_migrations').all()).toEqual(
      migrations,
    );
    expect(
      reopened.db.connection
        .prepare("SELECT * FROM sqlite_schema WHERE type='trigger' ORDER BY name")
        .all(),
    ).toEqual(triggers);
    const tables = reopened.db.connection
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables.filter(
      ({ name }) => !['provider_configs', 'schema_migrations'].includes(name),
    )) {
      expect(
        reopened.db.connection.prepare(`SELECT count(*) AS count FROM "${name}"`).get(),
      ).toEqual({ count: 0 });
    }
    // Fresh content can still be created with all schema constraints and triggers present.
    new NovelService(reopened.db).createProject('清理后的新作品', 'short');
    expect(() => reopened.db.connection.exec('DELETE FROM document_versions')).toThrow('immutable');
    const saved = new Database(join(backup as string, 'workbench.sqlite'), { readonly: true });
    try {
      expect(saved.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 1 });
      expect(saved.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      saved.close();
    }
    expect(new LocalCredentials(backup as string).get('local:test')).toBe('test-api-key');
    expect(await readFile(join(backup as string, 'backups', 'old.txt'), 'utf8')).toBe('旧备份');
    const source = externalTemp ? '__external_temp__' : 'tmp';
    expect(await readFile(join(backup as string, source, 'novel-imports', 'source'), 'utf8')).toBe(
      '导入内容',
    );
  },
);

it('rejects an active instance and a missing database without clearing anything', async () => {
  const { root, config, runtime } = await fixture();
  await expect(cleanData(config, true, quiet)).rejects.toThrow('已有实例占用');
  expect(new NovelService(runtime.db).listProjects(10).data.length).toBe(1);
  await expect(cleanData(loadConfig({ DATA_DIR: 'missing' }, root), true, quiet)).rejects.toThrow(
    '数据库不存在',
  );
  expect(existsSync(join(root, 'missing'))).toBe(false);
});
