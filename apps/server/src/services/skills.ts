import { createHash, randomUUID } from 'node:crypto';
import {
  type GitImport,
  type Skill,
  type SkillCatalogEntry,
  type SkillDetail,
  type SkillImportJob,
  type SkillListFilter,
  type SkillSource,
  type SkillVersion,
  skillDetailSchema,
  skillFileSchema,
  skillImportJobSchema,
  skillSchema,
  skillVersionSchema,
} from '@lingma/shared';
import type { WorkbenchDatabase } from '../db/database.js';
import { AppError } from '../errors.js';
import type { GitReader } from '../skills/git.js';
import {
  decodeSkillText,
  mediaType,
  parseSkill,
  type SkillInputFile,
  safeSkillPath,
  validateFiles,
} from '../skills/parse.js';
import type { BlobStore } from '../storage/blobs.js';
import type { MaintenanceGate } from '../storage/maintenance.js';

type Row = Record<string, unknown>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const localSource = (ref: string): SkillSource => ({
  type: 'local',
  ref,
  commit: null,
  subdir: null,
});
function skill(row: Row): Skill {
  return skillSchema.parse({
    id: row.id,
    name: row.name,
    currentVersionId: row.current_version_id,
    projectId: row.project_id,
    source: {
      type: row.source_type,
      ref: row.source_ref,
      commit: row.source_commit,
      subdir: row.source_subdir,
    },
  });
}
function job(row: Row): SkillImportJob {
  return skillImportJobSchema.parse({
    id: row.id,
    type: row.type,
    skillId: row.skill_id,
    projectId: row.project_id,
    baseVersionId: row.base_version_id,
    status: row.status,
    source: JSON.parse(String(row.source_json)),
    versionId: row.version_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
export class SkillService {
  private readonly tasks = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private stopped = false;
  constructor(
    readonly database: WorkbenchDatabase,
    private readonly blobs: BlobStore,
    private readonly gate: MaintenanceGate,
    private readonly readGit: GitReader,
  ) {
    database.transaction((db) =>
      db
        .prepare(
          "UPDATE skill_import_jobs SET status='interrupted', error='服务已重启，请重新导入', updated_at=? WHERE status IN ('queued','fetching','publishing')",
        )
        .run(new Date().toISOString()),
    );
  }
  private get db() {
    return this.database.connection;
  }
  private assertProject(projectId: string) {
    if (
      !this.db.prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL').get(projectId)
    )
      throw new AppError('NOT_FOUND', '项目不存在或已移入回收站', 404);
  }
  private filter(filter: SkillListFilter = {}) {
    if (filter.projectId) this.assertProject(filter.projectId);
    if (filter.scope === 'project') {
      if (!filter.projectId) throw new AppError('VALIDATION_ERROR', '项目 Skill 必须指定项目', 400);
      return { sql: 'project_id = ?', params: [filter.projectId] };
    }
    if (filter.scope === 'general' || !filter.projectId)
      return { sql: 'project_id IS NULL', params: [] };
    return { sql: '(project_id IS NULL OR project_id = ?)', params: [filter.projectId] };
  }
  list(limit: number, cursor?: string, filter: SkillListFilter = {}) {
    const where = this.filter(filter);
    const rows = this.db
      .prepare(`SELECT * FROM skills WHERE ${where.sql} AND id > ? ORDER BY id LIMIT ?`)
      .all(...where.params, cursor ?? '', limit + 1) as Row[];
    return {
      data: rows.slice(0, limit).map(skill),
      nextCursor: rows.length > limit ? String(rows[limit - 1]?.id) : null,
    };
  }
  get(id: string): Skill {
    const row = this.db.prepare('SELECT * FROM skills WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Skill 不存在', 404);
    return skill(row);
  }
  assertVersion(id: string, baseVersionId: string) {
    const current = this.get(id);
    if (current.currentVersionId !== baseVersionId)
      throw new AppError('VERSION_CONFLICT', 'Skill 已更新，请比较最新版本后合并', 409, {
        currentVersionId: current.currentVersionId,
      });
    return current;
  }
  version(id: string, versionId: string): SkillVersion {
    const row = this.db
      .prepare('SELECT * FROM skill_versions WHERE skill_id=? AND id=?')
      .get(id, versionId) as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND', '该 Skill 的版本不存在', 404);
    const files = (
      this.db
        .prepare('SELECT * FROM skill_files WHERE skill_version_id=? ORDER BY relative_path')
        .all(versionId) as Row[]
    ).map((file) => ({
      relativePath: file.relative_path,
      blobHash: file.blob_hash,
      mediaType: file.media_type,
      sizeBytes: file.size_bytes,
    }));
    return skillVersionSchema.parse({
      id: row.id,
      skillId: row.skill_id,
      versionNo: row.version_no,
      entryContent: row.entry_content,
      metadata: JSON.parse(String(row.metadata_json)),
      sourceSnapshot: JSON.parse(String(row.source_snapshot_json)),
      manifestHash: row.manifest_hash,
      createdAt: row.created_at,
      files,
    });
  }
  snapshot(versionId: string): SkillVersion {
    const row = this.db.prepare('SELECT skill_id FROM skill_versions WHERE id=?').get(versionId) as
      | { skill_id: string }
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Skill 版本不存在', 404);
    return this.version(row.skill_id, versionId);
  }
  catalog(preferredVersionId?: string, projectId?: string): SkillCatalogEntry[] {
    return this.db.transaction(() => {
      const where = this.filter({ projectId });
      const preferred = preferredVersionId ? this.snapshot(preferredVersionId) : null;
      if (preferred) {
        const owner = this.get(preferred.skillId).projectId;
        if (owner && owner !== projectId)
          throw new AppError('FORBIDDEN', '此 Skill 不属于当前项目', 403);
      }
      const rows = this.db
        .prepare(
          `SELECT s.id,s.name,v.id AS version_id,v.metadata_json FROM skills s JOIN skill_versions v ON v.id=s.current_version_id WHERE ${where.sql} ORDER BY s.id`,
        )
        .all(...where.params) as Row[];
      return rows.map((row) => {
        const pinned = preferred?.skillId === row.id ? preferred : null;
        const metadata = pinned?.metadata ?? JSON.parse(String(row.metadata_json));
        return {
          skillId: String(row.id),
          versionId: pinned?.id ?? String(row.version_id),
          name: pinned
            ? parseSkill(
                pinned.entryContent,
                pinned.files.map((file) => file.relativePath),
              ).name
            : String(row.name),
          description:
            typeof metadata.description === 'string' && metadata.description.trim()
              ? metadata.description.trim()
              : '未提供描述；请根据名称判断，需要时加载 SKILL.md 了解适用范围。',
        };
      });
    })();
  }
  detail(id: string, versionId?: string): SkillDetail {
    return this.db.transaction(() => {
      const current = this.get(id);
      const version = this.version(id, versionId ?? current.currentVersionId);
      const { body, missingFiles, warnings, examples } = parseSkill(
        version.entryContent,
        version.files.map((file) => file.relativePath),
      );
      return skillDetailSchema.parse({
        skill: current,
        version,
        parsed: { body, missingFiles, warnings, examples },
      });
    })();
  }
  changeScope(id: string, baseVersionId: string, projectId: string | null) {
    return this.gate.writeSync(() =>
      this.database.transaction((db) => {
        this.assertVersion(id, baseVersionId);
        if (projectId) this.assertProject(projectId);
        if (
          db
            .prepare(
              "SELECT id FROM skill_import_jobs WHERE skill_id=? AND status IN ('queued','fetching','publishing')",
            )
            .get(id)
        )
          throw new AppError('PROJECT_BUSY', '此 Skill 正在更新，请完成后修改归属', 409);
        db.prepare('UPDATE skills SET project_id=? WHERE id=?').run(projectId, id);
        db.prepare('UPDATE skill_import_jobs SET project_id=? WHERE skill_id=?').run(projectId, id);
        return this.detail(id);
      }),
    );
  }
  versions(id: string, limit: number, cursor?: number) {
    this.get(id);
    const rows = this.db
      .prepare(
        'SELECT id, version_no, created_at FROM skill_versions WHERE skill_id=? AND version_no < ? ORDER BY version_no DESC LIMIT ?',
      )
      .all(id, cursor ?? Number.MAX_SAFE_INTEGER, limit + 1) as Row[];
    return {
      data: rows.slice(0, limit).map((row) => ({
        id: String(row.id),
        versionNo: Number(row.version_no),
        createdAt: String(row.created_at),
      })),
      nextCursor: rows.length > limit ? String(rows[limit - 1]?.version_no) : null,
    };
  }
  async file(id: string, versionId: string, path: string) {
    path = safeSkillPath(path);
    const file = this.version(id, versionId).files.find((file) => file.relativePath === path);
    if (!file) throw new AppError('NOT_FOUND', '文件不在此版本的 manifest 中', 404);
    try {
      return { file, bytes: await this.blobs.get(file.blobHash) };
    } catch {
      throw new AppError('STORAGE_ERROR', 'Skill 附件缺失或完整性校验失败', 503);
    }
  }
  async save(id: string, baseVersionId: string, entryContent: string) {
    return this.gate.withWrite(async () => {
      this.assertVersion(id, baseVersionId);
      const previous = this.version(id, baseVersionId);
      const parsed = parseSkill(
        entryContent,
        previous.files.map((file) => file.relativePath),
      );
      const files = previous.files.filter((file) => file.relativePath !== 'SKILL.md');
      try {
        for (const file of files) {
          if ((await this.blobs.get(file.blobHash)).byteLength !== file.sizeBytes)
            throw new Error('size mismatch');
        }
      } catch {
        throw new AppError('STORAGE_ERROR', '继承附件缺失或损坏，不能发布新版本', 503);
      }
      const ref = await this.blobs.put(new TextEncoder().encode(entryContent));
      files.push({
        relativePath: 'SKILL.md',
        blobHash: ref.hash,
        sizeBytes: ref.sizeBytes,
        mediaType: mediaType('SKILL.md'),
      });
      return this.publish(id, baseVersionId, entryContent, parsed, files, previous.sourceSnapshot);
    });
  }
  private publish(
    id: string | null,
    baseVersionId: string | null,
    entryContent: string,
    parsed: ReturnType<typeof parseSkill>,
    files: SkillVersion['files'],
    source: SkillSource,
    jobId?: string,
    projectId: string | null = null,
  ): SkillDetail {
    files = files.map((file) => skillFileSchema.parse(file));
    files.sort((a, b) => Buffer.compare(Buffer.from(a.relativePath), Buffer.from(b.relativePath)));
    return this.database.transaction((db) => {
      if (id && baseVersionId) this.assertVersion(id, baseVersionId);
      const owner = id ? this.get(id).projectId : projectId;
      if (owner) this.assertProject(owner);
      const skillId = id ?? randomUUID();
      const versionId = randomUUID();
      const versionNo = id
        ? Number(
            (
              db
                .prepare('SELECT MAX(version_no) AS n FROM skill_versions WHERE skill_id=?')
                .get(id) as { n: number }
            ).n,
          ) + 1
        : 1;
      const now = new Date().toISOString();
      if (!id)
        db.prepare(
          'INSERT INTO skills(id,name,source_type,source_ref,source_commit,source_subdir,current_version_id,project_id) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          skillId,
          parsed.name,
          source.type,
          source.ref,
          source.commit,
          source.subdir,
          versionId,
          projectId,
        );
      db.prepare(
        'INSERT INTO skill_versions(id,skill_id,version_no,entry_content,metadata_json,source_snapshot_json,manifest_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        versionId,
        skillId,
        versionNo,
        entryContent,
        JSON.stringify(parsed.metadata),
        JSON.stringify(source),
        hash(JSON.stringify(files)),
        now,
      );
      const insert = db.prepare(
        'INSERT INTO skill_files(skill_version_id,relative_path,blob_hash,media_type,size_bytes) VALUES(?,?,?,?,?)',
      );
      for (const file of files)
        insert.run(versionId, file.relativePath, file.blobHash, file.mediaType, file.sizeBytes);
      db.prepare(
        'UPDATE skills SET name=?,source_type=?,source_ref=?,source_commit=?,source_subdir=?,current_version_id=? WHERE id=?',
      ).run(parsed.name, source.type, source.ref, source.commit, source.subdir, versionId, skillId);
      if (jobId)
        db.prepare(
          "UPDATE skill_import_jobs SET status='completed',skill_id=?,version_id=?,source_json=?,updated_at=? WHERE id=?",
        ).run(skillId, versionId, JSON.stringify(source), now, jobId);
      return this.detail(skillId, versionId);
    });
  }
  private createJob(
    source: SkillSource,
    target?: { skillId: string; baseVersionId: string },
    projectId: string | null = null,
  ): SkillImportJob {
    if (this.stopped) throw new AppError('MAINTENANCE_MODE', '服务正在关闭', 503);
    if (target) projectId = this.assertVersion(target.skillId, target.baseVersionId).projectId;
    if (projectId) this.assertProject(projectId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.transaction((db) =>
      db
        .prepare(
          'INSERT INTO skill_import_jobs(id,type,skill_id,base_version_id,status,source_json,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          source.type,
          target?.skillId ?? null,
          target?.baseVersionId ?? null,
          'queued',
          JSON.stringify(source),
          now,
          now,
          projectId,
        ),
    );
    return this.job(id);
  }
  job(id: string): SkillImportJob {
    const row = this.db.prepare('SELECT * FROM skill_import_jobs WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', '导入任务不存在', 404);
    return job(row);
  }
  jobs(filter: SkillListFilter = {}) {
    const where = this.filter(filter);
    return (
      this.db
        .prepare(
          `SELECT * FROM skill_import_jobs WHERE ${where.sql} ORDER BY created_at DESC, id DESC LIMIT 50`,
        )
        .all(...where.params) as Row[]
    ).map(job);
  }
  private state(id: string, status: SkillImportJob['status'], error: string | null = null) {
    this.database.transaction((db) =>
      db
        .prepare('UPDATE skill_import_jobs SET status=?,error=?,updated_at=? WHERE id=?')
        .run(status, error, new Date().toISOString(), id),
    );
  }
  private launch(
    job: SkillImportJob,
    read: (signal: AbortSignal) => Promise<{ files: SkillInputFile[]; source: SkillSource }>,
  ) {
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const input = await read(controller.signal);
        controller.signal.throwIfAborted();
        await this.gate.withWrite(async () => {
          this.state(job.id, 'publishing');
          const files = validateFiles(input.files);
          const entryContent = decodeSkillText(
            files.find((file) => file.path === 'SKILL.md')?.bytes ?? new Uint8Array(),
          );
          const parsed = parseSkill(
            entryContent,
            files.map((file) => file.path),
          );
          const manifest: SkillVersion['files'] = [];
          for (const file of files) {
            controller.signal.throwIfAborted();
            const ref = await this.blobs.put(file.bytes);
            manifest.push({
              relativePath: file.path,
              blobHash: ref.hash,
              mediaType: mediaType(file.path),
              sizeBytes: ref.sizeBytes,
            });
          }
          controller.signal.throwIfAborted();
          this.publish(
            job.skillId,
            job.baseVersionId,
            entryContent,
            parsed,
            manifest,
            input.source,
            job.id,
            job.projectId,
          );
        });
      } catch (error) {
        try {
          this.state(
            job.id,
            controller.signal.aborted ? 'interrupted' : 'failed',
            controller.signal.aborted
              ? '导入已中断，请重新导入'
              : error instanceof AppError
                ? error.message
                : '导入失败：存储暂时不可用，请检查后重试',
          );
        } catch {
          // A compromised lock or failed disk must not trigger an unhandled task rejection.
          // The persisted active state becomes interrupted on the next healthy startup.
        }
      }
    })().finally(() => this.tasks.delete(job.id));
    this.tasks.set(job.id, { controller, promise });
    return job;
  }
  importLocal(
    files: SkillInputFile[],
    label: string,
    target?: { skillId: string; baseVersionId: string },
    projectId: string | null = null,
  ) {
    files = validateFiles(files);
    if (this.tasks.size >= 2)
      throw new AppError('PROJECT_BUSY', '最多同时导入两个 Skill，请稍后重试', 409);
    const source = localSource(label.slice(0, 200));
    const job = this.createJob(source, target, projectId);
    return this.launch(job, async () => ({ files, source }));
  }
  importGit(
    input: GitImport,
    target?: { skillId: string; baseVersionId: string },
    projectId: string | null = null,
  ) {
    if (input.subdir) safeSkillPath(input.subdir);
    if (this.tasks.size >= 2)
      throw new AppError('PROJECT_BUSY', '最多同时导入两个 Skill，请稍后重试', 409);
    const source: SkillSource = {
      type: 'git',
      ref: input.repository,
      commit: null,
      subdir: input.subdir,
    };
    const job = this.createJob(source, target, projectId);
    return this.launch(job, async (signal) => {
      this.state(job.id, 'fetching');
      const result = await this.readGit(input, signal);
      return { files: result.files, source: { ...source, commit: result.commit } };
    });
  }
  updateGit(id: string, baseVersionId: string) {
    const current = this.assertVersion(id, baseVersionId);
    if (current.source.type !== 'git' || !current.source.ref)
      throw new AppError('VALIDATION_ERROR', '此 Skill 没有 Git 来源，请上传目录更新', 400);
    return this.importGit(
      { repository: current.source.ref, subdir: current.source.subdir ?? '' },
      { skillId: id, baseVersionId },
    );
  }
  async idle() {
    await Promise.all([...this.tasks.values()].map((task) => task.promise));
  }
  async close() {
    this.stopped = true;
    for (const task of this.tasks.values()) task.controller.abort();
    await this.idle();
  }
}
