import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { gitImportSchema, skillLimits } from '@lingma/shared';
import git from 'isomorphic-git';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { openRuntime, type Runtime } from '../src/runtime.js';
import { SkillService } from '../src/services/skills.js';
import type { GitReader } from '../src/skills/git.js';
import { gitReader } from '../src/skills/git.js';
import { createGitHttp, isPublicAddress, readSelectedTree } from '../src/skills/git-worker.js';
import { decodeSkillText, parseSkill, safeSkillPath, validateFiles } from '../src/skills/parse.js';

const roots: string[] = [];
const runtimes: Runtime[] = [];
const services: SkillService[] = [];
const bytes = (text: string) => new TextEncoder().encode(text);
const entry =
  '---\nname: 雾港 Skill\nx-custom: { enabled: true, list: [1, "二"] }\n---\n# 一致性审查\n\n[约束](references/style.md)\n[缺失][missing]\n\n[missing]: absent.md\n';
const files = () => [
  { path: 'SKILL.md', bytes: bytes(entry) },
  { path: 'references/style.md', bytes: bytes('文风一') },
  { path: 'examples/demo.md', bytes: bytes('示例一') },
  { path: 'script.sh', bytes: bytes('touch /tmp/never-run-this') },
];
async function fixture(
  reader: GitReader = async () => ({ commit: 'a'.repeat(40), files: files() }),
) {
  const root = await mkdtemp(resolve(tmpdir(), 'lingma-skill-'));
  roots.push(root);
  const config = loadConfig({ DATA_DIR: 'data' }, root);
  const runtime = await openRuntime(config);
  runtimes.push(runtime);
  const skills = new SkillService(runtime.db, runtime.blobs, runtime.gate, reader);
  services.push(skills);
  const app = createApp({
    ready: runtime.ready,
    webDistDir: config.webDistDir,
    logger: createLogger(() => {}),
    skills,
  });
  return { root, config, runtime, skills, app };
}
async function imported(skills: SkillService, input = files()) {
  const task = skills.importLocal(input, 'continuity');
  await skills.idle();
  const completed = skills.job(task.id);
  expect(completed.status).toBe('completed');
  return skills.detail(completed.skillId ?? '');
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Skill parsing and bounded manifests', () => {
  it('parses optional YAML, preserves unknown metadata and discovers missing reference links and examples', () => {
    const result = parseSkill(
      entry,
      files().map((file) => file.path),
    );
    expect(result.metadata['x-custom']).toEqual({ enabled: true, list: [1, '二'] });
    expect(result.body).toContain('# 一致性');
    expect(result.body).not.toContain('x-custom');
    expect(result.missingFiles).toEqual(['absent.md']);
    expect(result.examples).toEqual(['examples/demo.md']);
    expect(parseSkill('# 无元数据', ['SKILL.md']).name).toBe('无元数据');
    expect(parseSkill('正文', ['SKILL.md']).metadata).toEqual({});
    expect(parseSkill('---\n---\n正文', ['SKILL.md']).body).toBe('正文');
    expect(parseSkill('---\r\nname: 名称\r\n---\r\n正文', ['SKILL.md']).name).toBe('名称');
    expect(parseSkill('---\nwhen: 2026-11-03\n---\n正文', ['SKILL.md']).metadata.when).toBe(
      '2026-11-03',
    );
  });
  it('rejects malformed, tagged, alias, non-object, duplicate and non-JSON front matter', () => {
    for (const text of [
      '---\nname: x',
      '---\n- a\n---\n',
      '---\na: 1\na: 2\n---\n',
      '---\na: !!js/function x\n---\n',
      '---\na: &x [1]\nb: *x\n---\n',
      '---\na: .inf\n---\n',
    ])
      expect(() => parseSkill(text, ['SKILL.md'])).toThrow();
    expect(() => decodeSkillText(new Uint8Array([0xff]))).toThrow('UTF-8');
    expect(() => decodeSkillText(bytes('a\0b'))).toThrow();
    expect(decodeSkillText(bytes('\uFEFF# 正文'))).toBe('\uFEFF# 正文');
    expect(() => parseSkill('a\0b', ['SKILL.md'])).toThrow();
    expect(() => parseSkill('\uD800', ['SKILL.md'])).toThrow();
  });
  it('rejects traversal, dangerous names, duplicate normalized paths and file/size/depth limits', () => {
    for (const path of [
      '../escape',
      '/etc/passwd',
      'a/../b',
      'C:foo',
      'a\\b',
      'a//b',
      '.git/config',
      'a/CON.txt',
      'foo.',
      'a\n.md',
      `${'x/'.repeat(17)}a`,
    ])
      expect(() => safeSkillPath(path)).toThrow();
    expect(() => validateFiles([{ path: 'x.md', bytes: bytes('x') }])).toThrow('SKILL.md');
    expect(() => validateFiles([...files(), { path: 'skill.MD', bytes: bytes('x') }])).toThrow(
      '重复',
    );
    expect(() =>
      validateFiles([
        ...files(),
        { path: 'é.md', bytes: bytes('x') },
        { path: 'e\u0301.md', bytes: bytes('x') },
      ]),
    ).toThrow('重复');
    expect(() => validateFiles([...files(), { path: 'examples', bytes: bytes('x') }])).toThrow(
      '冲突',
    );
    expect(() =>
      validateFiles([
        ...files(),
        { path: 'large.bin', bytes: new Uint8Array(skillLimits.fileBytes + 1) },
      ]),
    ).toThrow('2 MiB');
    expect(() =>
      validateFiles(
        Array.from({ length: 201 }, (_, i) => ({ path: `${i}.txt`, bytes: bytes('') })),
      ),
    ).toThrow('200');
    expect(() =>
      validateFiles([{ path: 'SKILL.md', bytes: new Uint8Array(skillLimits.entryBytes + 1) }]),
    ).toThrow('256 KiB');
    expect(() =>
      validateFiles([
        ...files(),
        ...Array.from({ length: 9 }, (_, i) => ({
          path: `${i}.bin`,
          bytes: new Uint8Array(skillLimits.fileBytes),
        })),
      ]),
    ).toThrow('16 MiB');
  });
});

describe('immutable Skill publication and imports', () => {
  it('imports single entries, saves exact entry/file hashes, and preserves old metadata and attachments', async () => {
    const { skills } = await fixture();
    const single = await imported(skills, [{ path: 'SKILL.md', bytes: bytes(entry) }]);
    expect(single.parsed.missingFiles).toContain('references/style.md');
    const original = await imported(skills);
    const saved = await skills.save(
      original.skill.id,
      original.version.id,
      entry.replace('一致性审查', '新版检查'),
    );
    expect(saved.version.versionNo).toBe(2);
    expect(skills.version(original.skill.id, original.version.id)).toEqual(original.version);
    expect(saved.version.sourceSnapshot).toEqual(original.version.sourceSnapshot);
    expect(
      Buffer.from(
        (await skills.file(saved.skill.id, original.version.id, 'references/style.md')).bytes,
      ).toString(),
    ).toBe('文风一');
    expect(saved.version.files.find((file) => file.relativePath === 'SKILL.md')?.blobHash).toBe(
      createHash('sha256').update(saved.version.entryContent).digest('hex'),
    );
    expect(saved.version.manifestHash).toBe(
      createHash('sha256').update(JSON.stringify(saved.version.files)).digest('hex'),
    );
    await expect(skills.save(saved.skill.id, original.version.id, 'stale')).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(() => skills.version(single.skill.id, saved.version.id)).toThrow('版本不存在');
    await expect(
      skills.file(saved.skill.id, saved.version.id, 'not-in-manifest.md'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(skills.file(saved.skill.id, saved.version.id, '../escape')).rejects.toThrow();
    expect(skills.versions(saved.skill.id, 1).data[0]?.versionNo).toBe(2);
    expect(skills.versions(saved.skill.id, 1, 2).data[0]?.id).toBe(original.version.id);
  });
  it('rolls back a failed database publication after files are written, without publishing missing blobs', async () => {
    const { skills, runtime } = await fixture();
    const original = await imported(skills);
    runtime.db.connection.exec(
      "CREATE TRIGGER fail_skill BEFORE INSERT ON skill_versions WHEN NEW.version_no=2 BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END",
    );
    await expect(skills.save(original.skill.id, original.version.id, '# 新正文')).rejects.toThrow();
    expect(skills.get(original.skill.id).currentVersionId).toBe(original.version.id);
    expect(skills.versions(original.skill.id, 50).data).toHaveLength(1);
    const before = skills.list(50).data.length;
    runtime.db.connection.exec(
      "CREATE TRIGGER fail_import_skill BEFORE INSERT ON skill_files BEGIN SELECT RAISE(ABORT, 'fail reference'); END",
    );
    const task = skills.importLocal([{ path: 'SKILL.md', bytes: bytes('# 不发布') }], 'x');
    await skills.idle();
    expect(skills.job(task.id).status).toBe('failed');
    expect(skills.list(50).data.length).toBe(before);
    for (const file of original.version.files)
      expect((await runtime.blobs.get(file.blobHash)).byteLength).toBe(file.sizeBytes);
    expect((await readdir(runtime.directories.blobs)).length).toBeGreaterThan(0);
  });
  it('updates Git source as a new immutable version and keeps historical source snapshots', async () => {
    let commit = 'a'.repeat(40);
    const reader: GitReader = async () => ({
      commit,
      files: files().map((file) => ({
        ...file,
        bytes: file.path.endsWith('style.md') ? bytes(commit) : file.bytes,
      })),
    });
    const { skills } = await fixture(reader);
    const firstJob = skills.importGit({
      repository: 'https://example.com/skills.git',
      subdir: 'skills/continuity',
    });
    await skills.idle();
    const first = skills.detail(skills.job(firstJob.id).skillId ?? '');
    expect(first.version.sourceSnapshot.commit).toBe(commit);
    const edited = await skills.save(first.skill.id, first.version.id, '# 本地编辑');
    commit = 'b'.repeat(40);
    const update = skills.updateGit(first.skill.id, edited.version.id);
    await skills.idle();
    const latest = skills.detail(first.skill.id);
    expect(latest.version.versionNo).toBe(3);
    expect(skills.job(update.id).versionId).toBe(latest.version.id);
    expect(latest.version.sourceSnapshot.commit).toBe(commit);
    expect(skills.version(first.skill.id, first.version.id)).toEqual(first.version);
    expect(
      Buffer.from(
        (await skills.file(first.skill.id, first.version.id, 'references/style.md')).bytes,
      ).toString(),
    ).toBe('a'.repeat(40));
    expect(
      latest.version.files.find((file) => file.relativePath.endsWith('style.md'))?.blobHash,
    ).not.toBe(
      first.version.files.find((file) => file.relativePath.endsWith('style.md'))?.blobHash,
    );
    expect(skills.version(first.skill.id, edited.version.id).entryContent).toBe('# 本地编辑');
  });
  it('rejects a stale source update after download instead of replacing a newer edit, and limits concurrent tasks', async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { skills } = await fixture(async () => {
      await blocked;
      return { commit: 'b'.repeat(40), files: files() };
    });
    const original = await imported(skills);
    const task = skills.importGit(
      { repository: 'https://example.com/x.git', subdir: '' },
      { skillId: original.skill.id, baseVersionId: original.version.id },
    );
    const second = skills.importGit({ repository: 'https://example.com/x.git', subdir: '' });
    expect(() => skills.importGit({ repository: 'https://example.com/x.git', subdir: '' })).toThrow(
      '最多同时',
    );
    const saved = await skills.save(original.skill.id, original.version.id, '# 新编辑');
    release();
    await skills.idle();
    expect(skills.job(task.id).status).toBe('failed');
    expect(skills.job(task.id).error).toContain('已更新');
    expect(skills.get(original.skill.id).currentVersionId).toBe(saved.version.id);
    expect(skills.job(second.id).status).toBe('completed');
  });
  it('persists import states across restart and marks abandoned active imports interrupted', async () => {
    const { skills, runtime, config } = await fixture();
    const original = await imported(skills);
    runtime.db.connection
      .prepare(
        'INSERT INTO skill_import_jobs(id,type,status,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        'git',
        'fetching',
        JSON.stringify({ type: 'git', ref: 'https://example.com/x.git', commit: null, subdir: '' }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    await skills.close();
    await runtime.close();
    const restarted = await openRuntime(config);
    runtimes.push(restarted);
    const service = new SkillService(restarted.db, restarted.blobs, restarted.gate, async () => {
      throw new Error();
    });
    services.push(service);
    expect(service.jobs().some((job) => job.status === 'interrupted')).toBe(true);
    expect(service.detail(original.skill.id).version).toEqual(original.version);
    expect(
      Buffer.from(
        (await service.file(original.skill.id, original.version.id, 'SKILL.md')).bytes,
      ).toString(),
    ).toBe(entry);
  });
  it('validates real multipart paths and serves manifest-scoped files as inert downloads', async () => {
    const { app, skills } = await fixture();
    const form = new FormData();
    form.append('files', new File([entry], 'SKILL.md'));
    form.append('files', new File(['<script>unsafe()</script>'], 'evil.html'));
    form.set('paths', JSON.stringify(['continuity/SKILL.md', 'continuity/evil.html']));
    const response = await app.request('http://localhost/api/v1/skills/import/local', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(202);
    const task = (await response.json()).data;
    await skills.idle();
    const completed = skills.job(task.id);
    const detail = skills.detail(completed.skillId ?? '');
    const base = `http://localhost/api/v1/skills/${detail.skill.id}`;
    const file = await app.request(`${base}/versions/${detail.version.id}/file?path=evil.html`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(file.headers.get('content-disposition')).toContain('attachment');
    expect(file.headers.get('content-security-policy')).toContain('sandbox');
    expect(await file.text()).toBe('<script>unsafe()</script>');
    expect(
      (await app.request(`${base}/versions/${detail.version.id}/file?path=..%2Fescape`)).status,
    ).toBe(400);
    expect(
      (await app.request(`${base}/versions/${detail.version.id}/file?path=unknown`)).status,
    ).toBe(404);
    expect((await app.request(`${base}/versions?cursor=9007199254740992`)).status).toBe(400);
    const bad = new FormData();
    bad.append('files', new File(['x'], 'SKILL.md'));
    bad.set('paths', JSON.stringify(['../SKILL.md']));
    expect(
      (
        await app.request('http://localhost/api/v1/skills/import/local', {
          method: 'POST',
          body: bad,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(base, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseVersionId: randomUUID(), entryContent: '# stale' }),
        })
      ).status,
    ).toBe(409);
  });
});

describe('public Git isolation', () => {
  it('rejects private/special networks, unsupported URLs, credentials and ports', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.2',
      '169.254.169.254',
      '168.63.129.16',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPublicAddress(address), address).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    for (const repository of [
      'file:///tmp/x',
      'http://example.com/a',
      'ssh://example.com/a',
      'https://u:p@example.com/a',
      'https://example.com:8443/a',
      'https://example.com/a?token=secret',
      'https://example.com/a#x',
    ])
      expect(gitImportSchema.safeParse({ repository }).success).toBe(false);
    const http = createGitHttp(
      'https://example.com/a.git',
      AbortSignal.timeout(1000),
      undefined,
      async () => [{ address: '127.0.0.1', family: 4 }],
    );
    await expect(http.request({ url: 'https://example.com/a.git/info/refs' })).rejects.toThrow(
      '公网',
    );
    await expect(http.request({ url: 'https://evil.com/a.git/info/refs' })).rejects.toThrow('越出');
    await expect(http.request({ url: 'https://example.com/other/info/refs' })).rejects.toThrow(
      '越出',
    );
  });
  it('pins public DNS and rejects redirects, oversized headers and oversized streamed responses', async () => {
    let statusCode = 200;
    let length = '2';
    let chunks = [Buffer.from('ok')];
    const resolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const send = ((
      _url: URL,
      options: {
        lookup: (
          host: string,
          opts: { all: boolean },
          cb: (error: unknown, result: unknown) => void,
        ) => void;
      },
      callback: (res: unknown) => void,
    ) => {
      options.lookup('example.com', { all: true }, (_error, addresses) =>
        expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]),
      );
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      req.end = () => {
        const response = Object.assign(Readable.from(chunks), {
          statusCode,
          headers: { 'content-length': length },
        });
        callback(response);
      };
      req.destroy = () => {};
      return req;
    }) as unknown as typeof httpsRequest;
    const http = createGitHttp(
      'https://example.com/a.git',
      AbortSignal.timeout(1000),
      8,
      resolver,
      send,
    );
    const result = await http.request({ url: 'https://example.com/a.git/info/refs' });
    for await (const chunk of result.body) expect(Buffer.from(chunk).toString()).toBe('ok');
    statusCode = 302;
    await expect(http.request({ url: 'https://example.com/a.git/info/refs' })).rejects.toThrow(
      '重定向',
    );
    statusCode = 200;
    length = '50';
    await expect(http.request({ url: 'https://example.com/a.git/info/refs' })).rejects.toThrow(
      '32 MiB',
    );
    length = '0';
    chunks = [Buffer.from('1234567')];
    const streamed = await http.request({ url: 'https://example.com/a.git/git-upload-pack' });
    await expect(
      (async () => {
        for await (const _ of streamed.body) {
          /* consume bounded body */
        }
      })(),
    ).rejects.toThrow('32 MiB');
    expect(resolver).toHaveBeenCalledTimes(1);
  });
  it('reads only the requested Git subtree and rejects symlinks without checkout or script execution', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'lingma-git-tree-'));
    roots.push(root);
    await git.init({ fs, dir: root, defaultBranch: 'main' });
    await mkdir(resolve(root, 'skills/one'), { recursive: true });
    await mkdir(resolve(root, 'skills/two'), { recursive: true });
    await writeFile(resolve(root, 'skills/one/SKILL.md'), '# one');
    await writeFile(resolve(root, 'skills/two/SKILL.md'), '# two');
    await git.add({ fs, dir: root, filepath: '.' });
    const commit = await git.commit({
      fs,
      dir: root,
      message: 'synthetic',
      author: { name: 'Fixture', email: 'fixture@example.invalid' },
    });
    const selected = await readSelectedTree(root, commit, 'skills/one');
    expect(selected.map((file) => file.path)).toEqual(['SKILL.md']);
    expect(Buffer.from(selected[0]?.bytes ?? []).toString()).toBe('# one');
    await expect(readSelectedTree(root, commit, 'absent')).rejects.toThrow('子目录');
    const blob = await git.writeBlob({ fs, dir: root, blob: bytes('/etc/passwd') });
    const tree = await git.writeTree({
      fs,
      dir: root,
      tree: [{ mode: '120000', path: 'SKILL.md', oid: blob, type: 'blob' }],
    });
    const bad = await git.writeCommit({
      fs,
      dir: root,
      commit: {
        tree,
        parent: [],
        author: {
          name: 'Fixture',
          email: 'fixture@example.invalid',
          timestamp: 1,
          timezoneOffset: 0,
        },
        committer: {
          name: 'Fixture',
          email: 'fixture@example.invalid',
          timestamp: 1,
          timezoneOffset: 0,
        },
        message: 'symlink',
      },
    });
    await expect(readSelectedTree(root, bad, '')).rejects.toThrow('符号链接');
  });
  it('rejects a real worker import resolving to loopback and cleans its staging directory', async () => {
    const { runtime } = await fixture();
    await expect(
      gitReader(runtime.directories.temp)(
        { repository: 'https://127.0.0.1/x.git', subdir: '' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('公网');
    expect(
      (await readdir(runtime.directories.temp)).filter((name) => name.startsWith('skill-git-')),
    ).toEqual([]);
  });
});

describe('Skill failure and lifecycle regression', () => {
  it('replaces a local directory with a complete new manifest while retaining the previous snapshot', async () => {
    const { skills, app } = await fixture();
    const first = await imported(skills);
    const update = skills.importLocal(
      [
        { path: 'SKILL.md', bytes: bytes('# 修订副本') },
        { path: 'examples/new.txt', bytes: bytes('新示例') },
      ],
      'revised',
      { skillId: first.skill.id, baseVersionId: first.version.id },
    );
    await skills.idle();
    const latest = skills.detail(first.skill.id);
    expect(skills.job(update.id).versionId).toBe(latest.version.id);
    expect(latest.version.versionNo).toBe(2);
    expect(latest.version.files.map((file) => file.relativePath)).toEqual([
      'SKILL.md',
      'examples/new.txt',
    ]);
    expect(skills.snapshot(first.version.id)).toEqual(first.version);
    expect(skills.detail(first.skill.id, first.version.id).parsed.examples).toEqual([
      'examples/demo.md',
    ]);
    const exact = await app.request(`http://localhost/api/v1/skill-versions/${first.version.id}`);
    expect(exact.status).toBe(200);
    expect((await exact.json()).data).toEqual(first.version);
    expect(() => skills.updateGit(first.skill.id, latest.version.id)).toThrow('没有 Git 来源');
  });
  it('reports a corrupt/missing attachment instead of serving unverified bytes', async () => {
    const { skills, runtime } = await fixture();
    const detail = await imported(skills);
    const file = detail.version.files.find((file) => file.relativePath === 'references/style.md');
    expect(file).toBeDefined();
    const path = resolve(
      runtime.directories.blobs,
      file?.blobHash.slice(0, 2) ?? '',
      file?.blobHash ?? '',
    );
    await writeFile(path, '损坏内容');
    await expect(
      skills.file(detail.skill.id, detail.version.id, 'references/style.md'),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(
      skills.save(detail.skill.id, detail.version.id, '# 不发布缺失附件'),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(skills.get(detail.skill.id).currentVersionId).toBe(detail.version.id);
    await rm(path);
    await expect(
      skills.file(detail.skill.id, detail.version.id, 'references/style.md'),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });
  it('cancels active downloads before closing storage and leaves a durable interrupted status', async () => {
    const { skills } = await fixture(
      async (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
        }),
    );
    const task = skills.importGit({ repository: 'https://example.com/x.git', subdir: '' });
    expect(skills.job(task.id).status).toBe('fetching');
    await skills.close();
    expect(skills.job(task.id).status).toBe('interrupted');
    expect(skills.list(50).data).toHaveLength(0);
    expect(() => skills.importGit({ repository: 'https://example.com/x.git', subdir: '' })).toThrow(
      '正在关闭',
    );
  });
  it('terminates an already-aborted real Git worker and removes its staging directory', async () => {
    const { runtime } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      gitReader(runtime.directories.temp)(
        { repository: 'https://example.com/x.git', subdir: '' },
        controller.signal,
      ),
    ).rejects.toThrow('取消');
    expect(
      (await readdir(runtime.directories.temp)).filter((name) => name.startsWith('skill-git-')),
    ).toEqual([]);
  });
});
