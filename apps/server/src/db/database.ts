import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { MaintenanceGate } from '../storage/maintenance.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  rebuildTables?: boolean;
}
export function loadMigrations(
  directory = fileURLToPath(new URL('./migrations/', import.meta.url)),
): Migration[] {
  return readdirSync(directory)
    .filter((name) => /^\d{4}-.+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      version: Number(name.slice(0, 4)),
      name,
      sql: readFileSync(`${directory}/${name}`, 'utf8'),
      rebuildTables: readFileSync(`${directory}/${name}`, 'utf8').startsWith(
        '-- migration: rebuild-tables',
      ),
    }));
}
export function migrate(db: Database.Database, migrations: readonly Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
  ) STRICT`);
  const applied = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string; checksum: string }[];
  const checksums = migrations.map((item) => createHash('sha256').update(item.sql).digest('hex'));
  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index];
    if (!migration || migration.version !== index + 1) throw new Error('迁移编号必须从 1 连续递增');
  }
  for (const [index, previous] of applied.entries()) {
    const migration = migrations[index];
    if (
      !migration ||
      previous.version !== migration.version ||
      previous.name !== migration.name ||
      previous.checksum !== checksums[index]
    ) {
      throw new Error(`数据库迁移 ${previous.version} 与当前应用不兼容或文件已修改`);
    }
  }
  for (let index = applied.length; index < migrations.length; index++) {
    const migration = migrations[index];
    if (!migration) throw new Error('缺少迁移');
    // SQLite table rebuilds must disable FK enforcement outside the transaction;
    // validate all references before committing and always restore enforcement.
    if (migration.rebuildTables) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        if ((db.pragma('foreign_key_check') as unknown[]).length > 0)
          throw new Error('迁移后的数据库外键完整性检查失败');
        db.prepare(
          'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(migration.version, migration.name, checksums[index], new Date().toISOString());
      }).immediate();
    } finally {
      if (migration.rebuildTables) db.pragma('foreign_keys = ON');
    }
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length > 0)
    throw new Error('数据库外键完整性检查失败');
}

export class WorkbenchDatabase {
  readonly connection: Database.Database;
  readonly schemaVersion: number;
  constructor(
    path: string,
    private readonly gate: MaintenanceGate,
    migrations = loadMigrations(),
  ) {
    this.connection = new Database(path);
    try {
      this.connection.pragma('foreign_keys = ON');
      this.connection.pragma('journal_mode = WAL');
      this.connection.pragma('busy_timeout = 5000');
      this.connection.pragma('synchronous = FULL');
      migrate(this.connection, migrations);
      this.schemaVersion = migrations.at(-1)?.version ?? 0;
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }
  transaction<T>(
    action: (connection: Database.Database) => T extends PromiseLike<unknown> ? never : T,
  ): T {
    return this.gate.writeSync(() =>
      this.connection
        .transaction(() => {
          const result = action(this.connection);
          if (result !== null && typeof result === 'object' && 'then' in result) {
            throw new Error('数据库事务不允许异步操作');
          }
          return result;
        })
        .immediate(),
    );
  }
  ready(): boolean {
    try {
      return this.connection.open && this.connection.prepare('SELECT 1 AS ok').get() !== undefined;
    } catch {
      return false;
    }
  }
  close(): void {
    if (this.connection.open) this.connection.close();
  }
}
