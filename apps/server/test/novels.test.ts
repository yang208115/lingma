import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createDocumentSchema, putStructureSchema } from '@lingma/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadMigrations } from '../src/db/database.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { openRuntime, type Runtime } from '../src/runtime.js';
import { ImportService, splitChapters } from '../src/services/imports.js';
import { NovelService } from '../src/services/novels.js';

const roots: string[] = [];
const runtimes: Runtime[] = [];
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'lingma-novel-'));
  roots.push(root);
  const config = loadConfig({ DATA_DIR: 'data' }, root);
  const runtime = await openRuntime(config);
  runtimes.push(runtime);
  const novels = new NovelService(runtime.db);
  const imports = new ImportService(novels, runtime.directories.temp, runtime.gate);
  const app = createApp({
    ready: runtime.ready,
    webDistDir: config.webDistDir,
    logger: createLogger(() => {}),
    novels,
    imports,
  });
  const project = novels.createProject('雾港来信');
  const create = (
    kind: 'chapter' | 'master_outline' | 'chapter_outline' | 'character',
    title: string,
    extra = {},
  ) =>
    novels.createDocument(
      project.id,
      createDocumentSchema.parse({
        baseStructureVersion: novels.getProject(project.id).structureVersion,
        kind,
        title,
        ...extra,
      }),
    );
  return { config, runtime, novels, imports, app, project, create };
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('novel structure and immutable versions', () => {
  it('persists project formats, starts short works with a body and completes long-work setup', async () => {
    const { novels, project, app } = await fixture();
    expect(project.format).toBe('long');
    expect(project.setupCompleted).toBe(false);
    expect(novels.getStructure(project.id).documents).toEqual([]);
    const response = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '一场短梦', format: 'short' }),
    });
    expect(response.status).toBe(201);
    const short = (await response.json()).data;
    expect(short.format).toBe('short');
    expect(short.setupCompleted).toBe(true);
    const docs = novels.getStructure(short.id).documents;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: 'chapter', title: '正文' });
    if (!docs[0]) throw new Error('短篇未创建正文');
    expect(novels.getDocument(docs[0].id).version.content).toBe('');
    const setup = (baseStructureVersion: number) =>
      app.request(`/api/v1/projects/${project.id}/setup-completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseStructureVersion }),
      });
    expect((await setup(project.structureVersion + 1)).status).toBe(409);
    expect((await setup(project.structureVersion)).status).toBe(200);
    expect(novels.getProject(project.id).setupCompleted).toBe(true);
    const listed = (await (await app.request('/api/v1/projects')).json()).data;
    expect(listed.find((item: { id: string }) => item.id === short.id).format).toBe('short');
    expect(listed.find((item: { id: string }) => item.id === project.id).setupCompleted).toBe(true);
  });
  it('moves projects into trash, rejects active tasks and restores all documents and history', async () => {
    const { novels, project, create, app, runtime } = await fixture();
    const chapter = create('chapter', '保留的章节', { content: '初稿' });
    const saved = novels.saveDocument(chapter.document.id, {
      baseVersionId: chapter.version.id,
      content: '修订稿',
      metadata: {},
    });
    const current = novels.getProject(project.id);
    const remove = (baseStructureVersion: number) =>
      app.request(`/api/v1/projects/${project.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseStructureVersion }),
      });
    expect((await remove(project.structureVersion)).status).toBe(409);
    const runId = randomUUID();
    runtime.db.connection
      .prepare(`INSERT INTO runs(id,project_id,purpose,status,input_json,snapshot_json,context_hash,usage_json,created_at)
      VALUES(?,?,'review','queued','{}','{}','test','{}',?)`)
      .run(runId, project.id, new Date().toISOString());
    expect((await remove(current.structureVersion)).status).toBe(409);
    expect(novels.getProject(project.id).id).toBe(project.id);
    runtime.db.connection.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(runId);
    expect((await remove(current.structureVersion)).status).toBe(200);
    expect((await app.request('/api/v1/projects')).status).toBe(200);
    expect((await (await app.request('/api/v1/projects')).json()).data).toEqual([]);
    const trash = await (await app.request('/api/v1/projects?deleted=true')).json();
    expect(trash.data.map((item: { id: string }) => item.id)).toEqual([project.id]);
    expect((await app.request(`/api/v1/projects/${project.id}/structure`)).status).toBe(404);
    expect(() =>
      novels.saveDocument(chapter.document.id, {
        baseVersionId: saved.version.id,
        content: '旧标签页的修改',
        metadata: {},
      }),
    ).toThrow('回收站');
    expect(
      (await app.request(`/api/v1/projects/${project.id}/restore`, { method: 'POST' })).status,
    ).toBe(200);
    expect(novels.listProjects(10).data.map((item) => item.id)).toEqual([project.id]);
    expect(novels.listProjects(10, undefined, true).data).toEqual([]);
    expect(novels.getDocument(chapter.document.id).version.id).toBe(saved.version.id);
    expect(novels.getVersion(chapter.document.id, chapter.version.id).content).toBe('初稿');
    expect(novels.getStructure(project.id).documents).toHaveLength(1);
  });
  it('creates each document kind, versions metadata, detects stale writes and restores as a new version', async () => {
    const { novels, project, create } = await fixture();
    const chapter = create('chapter', '第一章', { content: '左手拨开窗栓' });
    create('master_outline', '总纲');
    create('chapter_outline', '第一章章纲', { chapterId: chapter.document.id });
    const character = create('character', '林舟', {
      metadata: { aliases: ['阿舟'], dominantHand: '左手' },
    });
    expect(
      novels
        .getStructure(project.id)
        .documents.map((item) => item.kind)
        .sort(),
    ).toEqual(['chapter', 'chapter_outline', 'character', 'master_outline']);
    const saved = novels.saveDocument(character.document.id, {
      baseVersionId: character.version.id,
      content: '修改人物资料',
      metadata: { aliases: ['阿舟', '船客'] },
    });
    expect(() =>
      novels.saveDocument(character.document.id, {
        baseVersionId: character.version.id,
        content: '旧标签页',
        metadata: {},
      }),
    ).toThrow('文档已更新');
    expect(novels.getVersion(character.document.id, character.version.id).metadata.aliases).toEqual(
      ['阿舟'],
    );
    const restored = novels.restoreDocument(
      character.document.id,
      saved.version.id,
      character.version.id,
    );
    expect(restored.version.versionNo).toBe(3);
    expect(restored.version.source).toBe('restore');
    expect(novels.getVersion(character.document.id, saved.version.id).content).toBe('修改人物资料');
    expect(restored.version.metadata.dominantHand).toBe('左手');
    expect(() => novels.getVersion(chapter.document.id, character.version.id)).toThrow(
      '版本不存在',
    );
    expect(() => novels.getVersion(chapter.document.id, chapter.version.id, randomUUID())).toThrow(
      '指定作品',
    );
    expect(() => novels.assertVersion(character.document.id, character.version.id)).toThrow(
      '已更新',
    );
    const renamed = novels.renameProject(
      project.id,
      '雾港来信·修订',
      novels.getProject(project.id).structureVersion,
    );
    expect(renamed.title).toBe('雾港来信·修订');
  });
  it('rejects foreign chapters/volumes, incomplete structure and structure conflicts', async () => {
    const { novels, project, create } = await fixture();
    const other = novels.createProject('其他作品');
    const chapter = novels.createDocument(
      other.id,
      createDocumentSchema.parse({ baseStructureVersion: 1, kind: 'chapter', title: '外部章节' }),
    );
    expect(() => create('chapter_outline', '错误章纲', { chapterId: chapter.document.id })).toThrow(
      '当前作品',
    );
    const current = create('chapter', '自己的正文');
    const structure = novels.getStructure(project.id);
    expect(() =>
      novels.putStructure(project.id, {
        baseStructureVersion: structure.project.structureVersion,
        volumes: [],
        documents: [],
      }),
    ).toThrow('完整包含');
    expect(() => create('chapter', '错误卷', { volumeId: randomUUID() })).toThrow('不存在该卷');
    expect(() => novels.renameProject(project.id, '旧版本改名', 1)).toThrow('目录已变化');
    const foreignVolume = randomUUID();
    novels.putStructure(other.id, {
      baseStructureVersion: novels.getProject(other.id).structureVersion,
      volumes: [{ id: foreignVolume, title: '他人的卷', sortOrder: 0 }],
      documents: [{ ...chapter.document }],
    });
    expect(() =>
      novels.putStructure(project.id, {
        baseStructureVersion: structure.project.structureVersion,
        volumes: [{ id: foreignVolume, title: '越界', sortOrder: 0 }],
        documents: [{ ...current.document }],
      }),
    ).toThrow('不属于');
  });
  it.each([
    '第一章 灯亮之后\n\n正文',
    '# 第一章 灯亮之后\r\n\r\n正文',
    '  第一章 灯亮之后  \n\n正文',
  ])(
    'exports a repeated leading chapter heading once without changing the manuscript: %s',
    async (content) => {
      const { novels, project, create } = await fixture();
      const chapter = create('chapter', '第一章 灯亮之后', { content });
      for (const chapterId of [undefined, chapter.document.id]) {
        const exported = novels.exportText(project.id, chapterId);
        expect(exported).toBe('雾港来信\n\n第一章 灯亮之后\n\n正文\n');
      }
      expect(novels.getDocument(chapter.document.id).version.content).toBe(content);
    },
  );

  it('preserves different headings and later chapter-title mentions in exports', async () => {
    const { novels, project, create } = await fixture();
    create('chapter', '第一章 灯亮之后', {
      content: '灯亮之后\n\n她在笔记上写下第一章 灯亮之后。',
    });
    expect(novels.exportText(project.id)).toContain(
      '第一章 灯亮之后\n\n灯亮之后\n\n她在笔记上写下第一章 灯亮之后。',
    );
  });

  it('sorts volumes/chapters in export, excludes materials and unlinks story events when a chapter is deleted', async () => {
    const { novels, project, create } = await fixture();
    const first = create('chapter', '第一章', { content: '一号正文\r\n下一行' });
    const second = create('chapter', '第二章', { content: '二号正文' });
    const outline = create('chapter_outline', '秘密章纲', {
      chapterId: first.document.id,
      content: '不可导出资料',
    });
    create('character', '林舟', { content: '人物不导出' });
    let structure = novels.getStructure(project.id);
    const v1 = randomUUID();
    const v2 = randomUUID();
    structure = novels.putStructure(
      project.id,
      putStructureSchema.parse({
        baseStructureVersion: structure.project.structureVersion,
        volumes: [
          { id: v1, title: '卷一', sortOrder: 1 },
          { id: v2, title: '卷二', sortOrder: 0 },
        ],
        documents: structure.documents.map((item) => ({
          id: item.id,
          title: item.title,
          sortOrder: item.sortOrder,
          volumeId: item.id === first.document.id ? v1 : item.id === second.document.id ? v2 : null,
        })),
      }),
    );
    const text = novels.exportText(project.id);
    expect(text.indexOf('卷二')).toBeLessThan(text.indexOf('卷一'));
    expect(text).not.toContain('不可导出');
    expect(text).not.toContain('人物不导出');
    expect(text).not.toContain('\r');
    const chapterText = novels.exportText(project.id, first.document.id);
    expect(chapterText).toContain('一号正文');
    expect(chapterText).not.toContain('二号正文');
    novels.deleteDocument(first.document.id, first.version.id, structure.project.structureVersion);
    // Story events are independent documents: deleting a chapter only unlinks them.
    const remaining = novels
      .getStructure(project.id)
      .documents.find((item) => item.id === outline.document.id);
    expect(remaining?.chapterId).toBeNull();
    expect(remaining?.chapterIds).toEqual([]);
    expect(novels.getVersion(outline.document.id, outline.version.id).content).toBe('不可导出资料');
    expect(() => novels.getDocument(first.document.id)).toThrow('已删除');
    const afterDelete = novels.getStructure(project.id);
    const withoutEmptyVolume = novels.putStructure(project.id, {
      baseStructureVersion: afterDelete.project.structureVersion,
      volumes: afterDelete.volumes.filter((volume) => volume.id !== v1),
      documents: afterDelete.documents.map(({ id, title, volumeId, sortOrder }) => ({
        id,
        title,
        volumeId,
        sortOrder,
      })),
    });
    expect(withoutEmptyVolume.volumes.map((volume) => volume.id)).not.toContain(v1);
  });
  it('paginates projects and versions without duplicates', async () => {
    const { novels, create } = await fixture();
    novels.createProject('B');
    novels.createProject('C');
    const first = novels.listProjects(2);
    expect(first.data).toHaveLength(2);
    const second = novels.listProjects(2, first.nextCursor ?? undefined);
    expect(second.data).toHaveLength(1);
    expect(new Set([...first.data, ...second.data].map((item) => item.id)).size).toBe(3);
    const doc = create('chapter', '版本测试');
    let latest = doc;
    for (let index = 0; index < 3; index++)
      latest = novels.saveDocument(doc.document.id, {
        baseVersionId: latest.version.id,
        content: String(index),
        metadata: {},
      });
    const page = novels.listVersions(doc.document.id, 2);
    expect(page.data.map((item) => item.versionNo)).toEqual([4, 3]);
    expect(
      novels
        .listVersions(doc.document.id, 2, Number(page.nextCursor))
        .data.map((item) => item.versionNo),
    ).toEqual([2, 1]);
  });
  it('upgrades a P01 database while preserving existing content across restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'lingma-upgrade-'));
    roots.push(root);
    const config = loadConfig({ DATA_DIR: 'data' }, root);
    const old = await openRuntime(config, { migrations: loadMigrations().slice(0, 1) });
    const projectId = randomUUID();
    const chapterId = randomUUID();
    const versionId = randomUUID();
    const stamp = new Date().toISOString();
    // Seed through raw SQL: the service targets the current schema, not migration 1.
    old.db.transaction((db) => {
      db.prepare('INSERT INTO projects(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(
        projectId,
        '原作品',
        stamp,
        stamp,
      );
      db.prepare(
        "INSERT INTO documents(id,project_id,kind,title,current_version_id) VALUES(?,?,'chapter','旧章节',?)",
      ).run(chapterId, projectId, versionId);
      db.prepare(
        "INSERT INTO document_versions(id,document_id,version_no,content,metadata_json,content_hash,source,created_at) VALUES(?,?,1,'原始内容','{}',?,'manual',?)",
      ).run(versionId, chapterId, 'c'.repeat(64), stamp);
    });
    const chapter = { document: { id: chapterId } };
    await old.close();
    const upgraded = await openRuntime(config);
    runtimes.push(upgraded);
    expect(upgraded.db.schemaVersion).toBe(loadMigrations().length);
    expect(new NovelService(upgraded.db).getProject(projectId)).toMatchObject({
      format: 'long',
      setupCompleted: true,
    });
    expect(new NovelService(upgraded.db).getDocument(chapter.document.id).version.content).toBe(
      '原始内容',
    );
  });
});

describe('preview import and HTTP', () => {
  it('preserves preamble, empty chapters and duplicate headings and rejects undecodable text', async () => {
    const { imports, project } = await fixture();
    const text = '# 书名\r\n\r\n第一章 重复\r\n\r\n第一章 重复\r\n正文';
    const preview = await imports.create(
      project.id,
      'novel.md',
      new TextEncoder().encode(text),
      'utf-8',
    );
    expect(preview.chapters).toHaveLength(3);
    expect(preview.chapters[0]?.content).toContain('# 书名');
    expect(preview.warnings.some((warning) => warning.includes('空章'))).toBe(true);
    expect(preview.warnings.some((warning) => warning.includes('重复'))).toBe(true);
    await expect(
      imports.create(project.id, 'bad.txt', new Uint8Array([0xff, 0xfe, 0]), 'utf-8'),
    ).rejects.toThrow('编码');
    const gb = await imports.create(
      project.id,
      'gb.txt',
      new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]),
      'gb18030',
    );
    expect(gb.chapters[0]?.content).toBe('中文');
    const utf16 = await imports.create(
      project.id,
      'unicode.txt',
      new Uint8Array(Buffer.from('中文', 'utf16le')),
      'utf-16le',
    );
    expect(utf16.chapters[0]?.content).toBe('中文');
    expect(splitChapters('没有标题\n仍保留').chapters[0]?.content).toBe('没有标题\n仍保留');
  });
  it('does not insert before confirmation, allows manual changes, and commits idempotently even after previews are lost', async () => {
    const { imports, novels, project, runtime, config } = await fixture();
    const bytes = await readFile(resolve(import.meta.dirname, '../../../fixtures/novel/存稿.md'));
    const preview = await imports.create(project.id, '存稿.md', bytes, 'utf-8');
    expect(novels.getStructure(project.id).documents).toHaveLength(0);
    const input = {
      baseStructureVersion: 1,
      volumeId: null,
      chapters: [{ title: '人工合并章', content: '人工修正后的内容' }],
    };
    const result = await imports.confirm(project.id, preview.id, input);
    expect(result.documentIds).toHaveLength(1);
    await rm(resolve(runtime.directories.temp, 'novel-imports', preview.id), { recursive: true });
    expect(await imports.confirm(project.id, preview.id, input)).toEqual(result);
    await expect(
      imports.confirm(project.id, preview.id, {
        ...input,
        chapters: [{ title: '不同内容', content: '' }],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(novels.getStructure(project.id).documents).toHaveLength(1);
    expect(novels.getDocument(result.documentIds[0] ?? '').version.source).toBe('import');
    await runtime.close();
    const restarted = await openRuntime(config);
    runtimes.push(restarted);
    const restartedImports = new ImportService(
      new NovelService(restarted.db),
      restarted.directories.temp,
      restarted.gate,
    );
    expect(await restartedImports.confirm(project.id, preview.id, input)).toEqual(result);
  });
  it('rejects cross-project previews and stale structure, rolls back all chapters if a batch fails', async () => {
    const { imports, novels, project, runtime, create } = await fixture();
    const preview = await imports.create(
      project.id,
      'n.txt',
      new TextEncoder().encode('第一章\n正文'),
      'utf-8',
    );
    const other = novels.createProject('其他');
    await expect(imports.get(other.id, preview.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    create('character', '新人物');
    const input = {
      baseStructureVersion: 1,
      volumeId: null,
      chapters: [
        { title: '一', content: '可写' },
        { title: '二', content: '触发故障' },
      ],
    };
    await expect(imports.confirm(project.id, preview.id, input)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    runtime.db.connection.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON document_versions WHEN NEW.content = '触发故障' BEGIN SELECT RAISE(ABORT, 'disk simulation'); END",
    );
    await expect(
      imports.confirm(project.id, preview.id, {
        ...input,
        baseStructureVersion: novels.getProject(project.id).structureVersion,
      }),
    ).rejects.toThrow('disk simulation');
    expect(novels.getStructure(project.id).documents.map((item) => item.kind)).toEqual([
      'character',
    ]);
    expect(novels.committedImport(project.id, preview.id)).toBeNull();
  });
  it('validates HTTP input, reports useful conflicts and serves UTF-8 export without materials', async () => {
    const { app, project, create, runtime } = await fixture();
    const doc = create('chapter', '第一章', { content: '铜铃' });
    const call = (path: string, method = 'GET', body?: unknown) =>
      app.request(`http://localhost/api/v1${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
    expect((await call('/projects', 'POST', { title: '' })).status).toBe(400);
    expect(
      (
        await app.request('http://localhost/api/v1/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
    const first = await call(`/documents/${doc.document.id}`, 'PUT', {
      baseVersionId: doc.version.id,
      content: '新稿',
      metadata: {},
    });
    expect(first.status).toBe(200);
    const conflict = await call(`/documents/${doc.document.id}`, 'PUT', {
      baseVersionId: doc.version.id,
      content: '旧稿',
      metadata: {},
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.details.currentVersionId).toBeDefined();
    const current = (await (await call(`/documents/${doc.document.id}`)).json()).data;
    runtime.db.connection.exec(
      "CREATE TRIGGER api_storage_fail BEFORE INSERT ON document_versions WHEN NEW.content='storage-error' BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END",
    );
    const failed = await call(`/documents/${doc.document.id}`, 'PUT', {
      baseVersionId: current.version.id,
      content: 'storage-error',
      metadata: {},
    });
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.code).toBe('STORAGE_ERROR');
    expect(
      (await call(`/documents/${doc.document.id}/versions?cursor=9007199254740992`)).status,
    ).toBe(400);
    const text = await call(`/projects/${project.id}/export.txt`);
    expect(text.headers.get('content-type')).toContain('utf-8');
    expect(text.headers.get('content-disposition')).toContain('attachment');
    expect(await text.text()).toContain('新稿');
    const form = new FormData();
    form.set('file', new File(['第一章\n正文'], 'sample.txt'));
    form.set('encoding', 'utf-8');
    const upload = await app.request(`http://localhost/api/v1/projects/${project.id}/imports`, {
      method: 'POST',
      body: form,
    });
    expect(upload.status).toBe(201);
  });
});
