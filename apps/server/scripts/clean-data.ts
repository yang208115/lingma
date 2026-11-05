import { existsSync } from 'node:fs';
import { chmod, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { type Config, loadConfig, loadEnvironment } from '../src/config.js';
import { openDirectories } from '../src/storage/directories.js';

const keptTables = new Set(['provider_configs', 'schema_migrations']);
const databaseFiles = new Set(['workbench.sqlite', 'workbench.sqlite-wal', 'workbench.sqlite-shm']);
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Preview by default; execute only against a stopped instance, after a complete backup. */
export async function cleanData(
  config: Config,
  execute = false,
  log: (message: string) => void = console.log,
): Promise<string | undefined> {
  const path = join(config.dataDir, 'workbench.sqlite');
  if (!existsSync(path)) throw new Error(`数据库不存在，未执行清理：${path}`);
  const directories = execute
    ? await openDirectories(config, (error) => {
        throw error;
      })
    : undefined;
  let db: Database.Database | undefined;
  let backup: string | undefined;
  try {
    db = new Database(path, { readonly: !execute, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    if (![...keptTables].every((name) => tables.some((table) => table.name === name)))
      throw new Error('不是可识别的灵码数据库，未执行清理');
    const targets = tables.filter(({ name }) => !keptTables.has(name));
    log(`数据目录：${config.dataDir}`);
    log('保留：模型配置、加密 API 密钥、迁移记录；.env 保持原样。');
    for (const { name } of targets) {
      const row = db.prepare(`SELECT count(*) AS count FROM ${quote(name)}`).get() as {
        count: number;
      };
      log(`清空 ${name}：${row.count} 条`);
    }
    // Only remove application-owned paths, including import remnants in a custom TEMP_DIR.
    const temp = directories?.temp ?? config.tempDir;
    const tempNames = existsSync(temp) ? await readdir(temp) : [];
    const files = [
      join(config.dataDir, 'blobs'),
      join(config.dataDir, 'backups'),
      ...tempNames
        .filter((name) => name === 'novel-imports' || name.startsWith('skill-git-'))
        .map((name) => join(temp, name)),
    ].filter(existsSync);
    for (const file of files) log(`移除：${file}`);
    if (!execute) {
      log('当前仅预览。停止服务后运行 pnpm data:clean --execute 执行清理。');
      return;
    }

    backup = await mkdtemp(join(dirname(config.dataDir), `${basename(config.dataDir)}.backup-`));
    await chmod(backup, 0o700);
    log(`备份目录：${backup}`);
    await db.backup(join(backup, 'workbench.sqlite'));
    await chmod(join(backup, 'workbench.sqlite'), 0o600);
    for (const name of await readdir(config.dataDir)) {
      if (name === '.instance.lock' || databaseFiles.has(name)) continue;
      await cp(join(config.dataDir, name), join(backup, name), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    // Store custom temporary files separately so they cannot collide with the data backup.
    const externalTemp = join(backup, '__external_temp__');
    for (const file of files.filter(
      (file) =>
        dirname(file) === temp &&
        temp !== directories?.data &&
        !file.startsWith(`${config.dataDir}/`),
    )) {
      await cp(file, join(externalTemp, basename(file)), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }

    const providers = db.prepare('SELECT * FROM provider_configs ORDER BY id').all();
    const triggers = db
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'")
      .all() as { name: string; sql: string }[];
    db.pragma('foreign_keys = OFF');
    try {
      const connection = db;
      connection
        .transaction(() => {
          // Immutable history triggers prohibit DELETE; restore them within the same transaction.
          for (const trigger of triggers) connection.exec(`DROP TRIGGER ${quote(trigger.name)}`);
          for (const { name } of targets) connection.exec(`DELETE FROM ${quote(name)}`);
          for (const trigger of triggers) connection.exec(trigger.sql);
          if ((connection.pragma('foreign_key_check') as unknown[]).length)
            throw new Error('清理后的外键校验失败，已回滚');
          if (
            JSON.stringify(
              connection.prepare('SELECT * FROM provider_configs ORDER BY id').all(),
            ) !== JSON.stringify(providers)
          )
            throw new Error('模型配置发生变化，已回滚');
        })
        .exclusive();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    for (const file of files) await rm(file, { recursive: true, force: true });
    log(`清理完成，模型配置和密钥已保留。原数据备份：${backup}`);
    return backup;
  } catch (error) {
    if (backup) log(`清理未完成，请检查错误；备份目录：${backup}`);
    throw error;
  } finally {
    db?.close();
    await directories?.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !['--execute', '--dry-run', '--help'].includes(arg)))
      throw new Error('不支持的参数；使用 --help 查看用法');
    if (args.includes('--execute') && args.includes('--dry-run'))
      throw new Error('--execute 与 --dry-run 不能同时使用');
    if (args.includes('--help')) {
      console.log(
        'pnpm data:clean [--dry-run | --execute]\n默认只预览；执行前停止服务，自动备份并保留模型配置和密钥。\n读取根目录 .env，支持 DATA_DIR / TEMP_DIR 环境变量覆盖。',
      );
    } else {
      loadEnvironment();
      await cleanData(loadConfig(), args.includes('--execute'));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : '清理失败');
    process.exitCode = 1;
  }
}
