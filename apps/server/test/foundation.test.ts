import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { loadMigrations } from '../src/db/database.js';
import { AppError } from '../src/errors.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { openRuntime, type Runtime } from '../src/runtime.js';
import { SkillService } from '../src/services/skills.js';
import { MaintenanceGate } from '../src/storage/maintenance.js';
import { AgentPromptService } from '../src/writing/prompt.js';

const roots: string[] = [];
const runtimes: Runtime[] = [];
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'lingma-test-'));
  roots.push(root);
  return loadConfig({ DATA_DIR: 'data' }, root);
}
async function runtime() {
  const config = await fixture();
  const instance = await openRuntime(config);
  runtimes.push(instance);
  return { config, instance };
}
afterEach(async () => {
  for (const instance of runtimes.splice(0)) await instance.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('configuration and lifecycle', () => {
  it('normalizes paths and rejects invalid settings without exposing values', () => {
    expect(loadConfig({ DATA_DIR: 'private' }, '/workspace').dataDir).toBe('/workspace/private');
    for (const env of [
      { PORT: 'no-secret-value' },
      { HOST: '0.0.0.0' },
      { SHUTDOWN_TIMEOUT_MS: '0' },
      { DATA_DIR: ' ' },
    ]) {
      expect(() => loadConfig(env)).toThrow('配置无效');
      try {
        loadConfig(env);
      } catch (error) {
        expect(String(error)).not.toContain('no-secret-value');
      }
    }
  });
  it('starts in an empty directory, persists the schema, closes hooks, and releases the lock', async () => {
    const { instance, config } = await runtime();
    expect(instance.ready()).toBe(true);
    expect(instance.db.schemaVersion).toBe(loadMigrations().length);
    let closed = false;
    instance.onClose(() => {
      closed = true;
    });
    await instance.close();
    expect(closed).toBe(true);
    expect(instance.ready()).toBe(false);
    const reopened = await openRuntime(config);
    runtimes.push(reopened);
    expect(
      reopened.db.connection.prepare('SELECT count(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: loadMigrations().length });
  });
  it('refuses a second instance without disturbing the first', async () => {
    const { config, instance } = await runtime();
    await expect(openRuntime(config)).rejects.toThrow('已有实例占用');
    expect(instance.ready()).toBe(true);
    expect(instance.db.connection.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });
  });
  it('rejects unwritable directories and overlapping public/temp storage', async () => {
    const config = await fixture();
    const denied = resolve(config.dataDir, '..', 'read-only');
    await mkdir(denied, { mode: 0o500 });
    try {
      await expect(openRuntime({ ...config, dataDir: denied })).rejects.toThrow();
    } finally {
      await chmod(denied, 0o700);
    }
    await expect(openRuntime({ ...config, webDistDir: config.dataDir })).rejects.toThrow('重叠');
    await expect(openRuntime({ ...config, tempDir: config.dataDir })).rejects.toThrow('临时目录');
    const valid = await openRuntime(config);
    runtimes.push(valid);
    expect(valid.ready()).toBe(true);
  });
  it('rolls back a failed migration, never exposes ready, and releases startup resources', async () => {
    const config = await fixture();
    await expect(
      openRuntime(config, {
        migrations: [
          {
            version: 1,
            name: '0001-broken.sql',
            sql: 'CREATE TABLE unfinished (id TEXT); INVALID SQL;',
          },
        ],
      }),
    ).rejects.toThrow();
    const instance = await openRuntime(config);
    runtimes.push(instance);
    expect(
      instance.db.connection
        .prepare("SELECT name FROM sqlite_master WHERE name = 'unfinished'")
        .get(),
    ).toBeUndefined();
    expect(instance.ready()).toBe(true);
  });
  it('refuses incompatible migration history', async () => {
    const { instance, config } = await runtime();
    await instance.close();
    await expect(
      openRuntime(config, {
        migrations: [{ version: 1, name: '0001-foundation.sql', sql: 'SELECT 1;' }],
      }),
    ).rejects.toThrow('不兼容');
  });
  it('rejects a static directory that reaches private data through a symlink', async () => {
    const config = await fixture();
    await mkdir(config.dataDir);
    const link = resolve(config.dataDir, '..', 'public-link');
    await symlink(config.dataDir, link);
    await expect(openRuntime({ ...config, webDistDir: resolve(link, 'dist') })).rejects.toThrow(
      '静态目录',
    );
  });
  it('drains and releases storage even if a cancellation hook fails', async () => {
    const config = await fixture();
    const instance = await openRuntime(config);
    instance.onClose(() => {
      throw new Error('scheduler stop failed');
    });
    await expect(instance.close()).rejects.toThrow('scheduler stop failed');
    expect(instance.db.connection.open).toBe(false);
    const reopened = await openRuntime(config);
    runtimes.push(reopened);
    expect(reopened.ready()).toBe(true);
  });
});

describe('database ownership and atomicity', () => {
  it('recovers only visible thinking from historical SDK responses when upgrading', async () => {
    const config = await fixture();
    const old = await openRuntime(config, { migrations: loadMigrations().slice(0, 6) });
    runtimes.push(old);
    const runId = randomUUID();
    old.db.transaction((db) => {
      db.prepare(
        "INSERT INTO runs(id,purpose,status,input_json,snapshot_json,context_hash,usage_json,created_at) VALUES(?,'skill_test','completed','{}','{}',?,'{}',?)",
      ).run(runId, 'a'.repeat(64), new Date().toISOString());
      const response = {
        transcriptMessage: {
          protocol: {
            message: {
              content: [
                { type: 'thinking', thinking: '核对', thinkingSignature: 'opaque' },
                { type: 'text', text: '正文' },
                { type: 'thinking', thinking: '不可显示', redacted: true },
                { type: 'thinking', thinking: '资料' },
              ],
            },
          },
        },
      };
      db.prepare(
        "INSERT INTO run_turns(run_id,turn_index,status,response_json,partial_text) VALUES(?,0,'complete',?,'正文')",
      ).run(runId, JSON.stringify(response));
      db.prepare("INSERT INTO run_turns(run_id,turn_index,status) VALUES(?,1,'interrupted')").run(
        runId,
      );
    });
    await old.close();
    const upgraded = await openRuntime(config);
    runtimes.push(upgraded);
    expect(
      upgraded.db.connection
        .prepare('SELECT thinking,partial_text FROM run_turns WHERE run_id=? ORDER BY turn_index')
        .all(runId),
    ).toEqual([
      { thinking: '核对资料', partial_text: '正文' },
      { thinking: '', partial_text: '' },
    ]);
  });

  it('upgrades a P05 database and preserves a saved Agent prompt across restart', async () => {
    const config = await fixture();
    const old = await openRuntime(config, { migrations: loadMigrations().slice(0, 5) });
    runtimes.push(old);
    const projectId = randomUUID();
    old.db.transaction((db) =>
      db
        .prepare(
          'INSERT INTO projects(id,title,structure_version,created_at,updated_at) VALUES(?,?,1,?,?)',
        )
        .run(projectId, '保留的作品', new Date().toISOString(), new Date().toISOString()),
    );
    await old.close();
    const upgraded = await openRuntime(config);
    runtimes.push(upgraded);
    const prompts = new AgentPromptService(upgraded.db);
    const custom = prompts.save({ prompt: '自定义系统提示词\n保留换行', revision: 0 });
    await upgraded.close();
    const reopened = await openRuntime(config);
    runtimes.push(reopened);
    expect(new AgentPromptService(reopened.db).get()).toEqual(custom);
    expect(
      reopened.db.connection.prepare('SELECT title FROM projects WHERE id=?').get(projectId),
    ).toEqual({ title: '保留的作品' });
    expect(reopened.db.connection.pragma('foreign_key_check')).toEqual([]);
  });

  it('migrates existing skills into the general library without altering their versions', async () => {
    const config = await fixture();
    const old = await openRuntime(config, { migrations: loadMigrations().slice(0, 18) });
    runtimes.push(old);
    const skillId = randomUUID();
    const versionId = randomUUID();
    old.db.transaction((db) => {
      db.prepare(
        "INSERT INTO skills(id,name,source_type,current_version_id) VALUES(?,?,'local',?)",
      ).run(skillId, '旧规则', versionId);
      db.prepare(
        'INSERT INTO skill_versions(id,skill_id,version_no,entry_content,metadata_json,source_snapshot_json,manifest_hash,created_at) VALUES(?,?,1,?,?,?,?,?)',
      ).run(
        versionId,
        skillId,
        '# 旧规则',
        '{}',
        JSON.stringify({ type: 'local', ref: null, commit: null, subdir: null }),
        'a'.repeat(64),
        new Date().toISOString(),
      );
    });
    const original = old.db.connection
      .prepare('SELECT * FROM skill_versions WHERE id=?')
      .get(versionId);
    await old.close();
    const upgraded = await openRuntime(config);
    runtimes.push(upgraded);
    const skills = new SkillService(upgraded.db, upgraded.blobs, upgraded.gate, async () => {
      throw new Error('unused');
    });
    expect(skills.list(200).data).toMatchObject([
      { id: skillId, projectId: null, currentVersionId: versionId },
    ]);
    expect(
      upgraded.db.connection.prepare('SELECT * FROM skill_versions WHERE id=?').get(versionId),
    ).toEqual(original);
    expect(upgraded.db.connection.pragma('foreign_key_check')).toEqual([]);
    await skills.close();
  });

  it('upgrades the original P05 migration without changing its checksum or losing citations', async () => {
    const config = await fixture();
    const original = await openRuntime(config, { migrations: loadMigrations().slice(0, 4) });
    runtimes.push(original);
    const run = randomUUID();
    original.db.transaction((db) => {
      db.prepare(
        "INSERT INTO runs(id,purpose,status,input_json,snapshot_json,context_hash,usage_json,created_at) VALUES(?,'skill_test','completed','{}','{}',?,'{}',?)",
      ).run(run, 'a'.repeat(64), new Date().toISOString());
      db.prepare(
        "INSERT INTO run_context_entries(run_id,turn_index,citation_id,entry_json) VALUES(?,-1,'same','{\"original\":true}')",
      ).run(run);
    });
    await original.close();
    const upgraded = await openRuntime(config);
    runtimes.push(upgraded);
    expect(upgraded.db.schemaVersion).toBe(loadMigrations().length);
    expect(
      upgraded.db.connection
        .prepare('SELECT entry_json FROM run_context_entries WHERE run_id=?')
        .get(run),
    ).toEqual({ entry_json: '{"original":true}' });
    upgraded.db.transaction((db) =>
      db
        .prepare(
          "INSERT INTO run_context_entries(run_id,turn_index,citation_id,entry_json) VALUES(?,0,'same','{}')",
        )
        .run(run),
    );
    expect(() =>
      upgraded.db.transaction((db) =>
        db
          .prepare(
            "INSERT INTO run_context_entries(run_id,turn_index,citation_id,entry_json) VALUES(?,0,'same','{}')",
          )
          .run(run),
      ),
    ).toThrow();
    expect(upgraded.db.connection.pragma('foreign_key_check')).toEqual([]);
  });
  it('enforces project/version ownership, immutable history, foreign keys and rollback', async () => {
    const { instance } = await runtime();
    const db = instance.db;
    const project = randomUUID();
    const otherProject = randomUUID();
    const document = randomUUID();
    const version = randomUUID();
    const otherDocument = randomUUID();
    const otherVersion = randomUUID();
    const now = new Date().toISOString();
    db.transaction((connection) => {
      const insertProject = connection.prepare(
        'INSERT INTO projects(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      );
      insertProject.run(project, '雾港来信', now, now);
      insertProject.run(otherProject, '另一作品', now, now);
      for (const [docId, verId, projectId] of [
        [document, version, project],
        [otherDocument, otherVersion, otherProject],
      ]) {
        connection
          .prepare(
            "INSERT INTO documents(id, project_id, kind, title, current_version_id) VALUES (?, ?, 'chapter', '第一章', ?)",
          )
          .run(docId, projectId, verId);
        connection
          .prepare(
            "INSERT INTO document_versions(id, document_id, version_no, content, content_hash, source, created_at) VALUES (?, ?, 1, '铜铃响了', ?, 'manual', ?)",
          )
          .run(verId, docId, 'a'.repeat(64), now);
      }
    });
    expect(db.connection.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db.transaction((connection) =>
        connection
          .prepare('UPDATE documents SET current_version_id = ? WHERE id = ?')
          .run(otherVersion, document),
      ),
    ).toThrow();
    expect(
      db.connection.prepare('SELECT current_version_id FROM documents WHERE id = ?').get(document),
    ).toEqual({ current_version_id: version });
    expect(() =>
      db.transaction((connection) =>
        connection.prepare("UPDATE document_versions SET content = '篡改'").run(),
      ),
    ).toThrow('immutable');
    expect(() =>
      db.transaction((connection) => connection.prepare('DELETE FROM document_versions').run()),
    ).toThrow('immutable');
    expect(() =>
      db.transaction((connection) => {
        connection
          .prepare(
            "INSERT INTO documents(id, project_id, kind, chapter_id, title, current_version_id) VALUES (?, ?, 'chapter_outline', ?, '错误章纲', ?)",
          )
          .run(randomUUID(), project, otherDocument, randomUUID());
      }),
    ).toThrow();
    expect(() =>
      db.transaction((connection) => {
        connection.prepare("UPDATE projects SET title = '应回滚' WHERE id = ?").run(project);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(db.connection.prepare('SELECT title FROM projects WHERE id = ?').get(project)).toEqual({
      title: '雾港来信',
    });
  });

  it('enforces skill version ownership and immutable attachments', async () => {
    const { instance } = await runtime();
    const ids = [randomUUID(), randomUUID()];
    const versions = [randomUUID(), randomUUID()];
    instance.db.transaction((db) => {
      for (const index of [0, 1]) {
        db.prepare(
          "INSERT INTO skills(id, name, source_type, current_version_id) VALUES (?, '一致性审查', 'local', ?)",
        ).run(ids[index], versions[index]);
        db.prepare(
          "INSERT INTO skill_versions(id, skill_id, version_no, entry_content, source_snapshot_json, manifest_hash, created_at) VALUES (?, ?, 1, '# 审查', '{}', ?, ?)",
        ).run(versions[index], ids[index], 'b'.repeat(64), new Date().toISOString());
      }
      db.prepare(
        "INSERT INTO skill_files VALUES (?, 'references/style.md', ?, 'text/markdown', 10)",
      ).run(versions[0], 'c'.repeat(64));
    });
    expect(() =>
      instance.db.transaction((db) =>
        db
          .prepare('UPDATE skills SET current_version_id = ? WHERE id = ?')
          .run(versions[1], ids[0]),
      ),
    ).toThrow();
    expect(() =>
      instance.db.transaction((db) => db.prepare('UPDATE skill_files SET size_bytes = 0').run()),
    ).toThrow('immutable');
    expect(() =>
      instance.db.transaction((db) =>
        db
          .prepare("INSERT INTO skill_files VALUES (?, '../secret', ?, 'text/plain', 0)")
          .run(versions[0], 'd'.repeat(64)),
      ),
    ).toThrow();
  });
});

describe('storage and maintenance', () => {
  it('deduplicates atomic blob writes, verifies hashes and rejects path injection', async () => {
    const { instance } = await runtime();
    const content = new TextEncoder().encode('合成的中文附件');
    const [first, second] = await Promise.all([
      instance.blobs.put(content),
      instance.blobs.put(content),
    ]);
    expect(first).toEqual(second);
    expect(new TextDecoder().decode(await instance.blobs.get(first.hash))).toBe('合成的中文附件');
    await expect(instance.blobs.get('../credentials.enc')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await writeFile(
      resolve(instance.directories.blobs, first.hash.slice(0, 2), first.hash),
      'corrupt',
    );
    await expect(instance.blobs.get(first.hash)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });
  it('blocks new writes, drains active writers and restores readiness after maintenance', async () => {
    const { instance } = await runtime();
    let release: () => void = () => {};
    const active = instance.gate.withWrite(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let entered = false;
    const maintenance = instance.gate.withMaintenance(() => {
      entered = true;
      expect(instance.ready()).toBe(false);
    });
    expect(entered).toBe(false);
    await expect(instance.blobs.put(new Uint8Array())).rejects.toMatchObject({
      code: 'MAINTENANCE_MODE',
    });
    expect(() => instance.db.transaction((db) => db.prepare('SELECT 1').get())).toThrow('维护');
    release();
    await Promise.all([active, maintenance]);
    expect(entered).toBe(true);
    expect(instance.ready()).toBe(true);
  });
  it('releases maintenance even if its operation fails, and rejects writes after stop', async () => {
    const gate = new MaintenanceGate();
    await expect(
      gate.withMaintenance(() => {
        throw new Error('backup failed');
      }),
    ).rejects.toThrow('backup failed');
    expect(gate.available).toBe(true);
    await gate.stop();
    await expect(gate.withWrite(() => 1)).rejects.toMatchObject({ code: 'MAINTENANCE_MODE' });
  });
  it('waits for an active maintenance operation before closing the database', async () => {
    const { instance } = await runtime();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const maintenance = instance.gate.withMaintenance(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      expect(instance.db.connection.open).toBe(true);
    });
    await entered;
    const closing = instance.close();
    expect(instance.db.connection.open).toBe(true);
    release();
    await Promise.all([maintenance, closing]);
    expect(instance.db.connection.open).toBe(false);
  });
});

describe('HTTP and redaction', () => {
  it('checks readiness, serves real static files, maps errors and generates request ids', async () => {
    const { instance, config } = await runtime();
    const lines: string[] = [];
    // The temporary root already exists; use it as an isolated static directory for this test.
    const web = resolve(config.dataDir, '..');
    await writeFile(resolve(web, 'index.html'), '<html lang="zh-CN">灵码测试</html>');
    const app = createApp({
      ready: instance.ready,
      webDistDir: web,
      logger: createLogger((line) => lines.push(line)),
    });
    app.get('/validation-test', (context) => {
      return context.json(z.string().parse(123));
    });
    app.get('/conflict-test', () => {
      throw new AppError('VERSION_CONFLICT', '版本不符', 409, { currentVersionId: 'v2' });
    });
    app.get('/internal-test', () => {
      throw new Error('secret-body-test');
    });
    const ready = await app.request('http://localhost/api/v1/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ data: { status: 'ready' } });
    expect(ready.headers.get('X-Request-ID')).toMatch(/^[a-f0-9-]{36}$/);
    expect(await (await app.request('http://localhost/')).text()).toContain('灵码测试');
    expect(
      (
        await app.request('http://localhost/api/v1/no-such-route', {
          headers: { accept: 'text/html' },
        })
      ).status,
    ).toBe(404);
    expect((await app.request('http://localhost/validation-test')).status).toBe(400);
    expect((await app.request('http://localhost/conflict-test')).status).toBe(409);
    const internal = await app.request('http://localhost/internal-test');
    expect(internal.status).toBe(500);
    expect(await internal.text()).not.toContain('secret-body-test');
    expect(lines.join('\n')).not.toContain('secret-body-test');
    await instance.gate.withMaintenance(async () => {
      expect((await app.request('http://localhost/ready')).status).toBe(503);
      expect((await app.request('http://localhost/health')).status).toBe(200);
      expect(
        (await app.request('http://localhost/api/v1/projects', { method: 'POST' })).status,
      ).toBe(503);
    });
    expect(await readFile(resolve(web, 'index.html'), 'utf8')).toContain('灵码测试');
  });
  it('rejects cross-site origins and DNS rebinding hosts', async () => {
    const config = await fixture();
    const app = createApp({
      ready: () => true,
      webDistDir: config.webDistDir,
      logger: createLogger(() => {}),
    });
    expect((await app.request('http://evil.example/api/v1/health')).status).toBe(403);
    expect(
      (
        await app.request('http://localhost/api/v1/health', {
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('http://localhost/api/v1/health', {
          headers: { Origin: 'http://localhost:5173' },
        })
      ).status,
    ).toBe(200);
  });
  it('logs only the allowlist even when an object has secret properties', () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).info({
      event: 'test',
      ...{ authorization: 'secret', body: 'private manuscript', apiKey: 'secret' },
    });
    expect(lines.join('')).not.toMatch(/secret|private manuscript|authorization|apiKey/);
  });
});
