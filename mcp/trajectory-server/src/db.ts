import { readFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export class TrajectoryDB {
  static readonly TARGET_VERSION = 4;

  private db: Database.Database;

  constructor(dbPath: string) {
    this.migrateOrBackup(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrateOrBackup(dbPath: string): void {
    if (dbPath === ':memory:' || !existsSync(dbPath)) return;

    let existingVersion = 0;
    let probeDb: Database.Database | null = null;

    try {
      probeDb = new Database(dbPath, { readonly: true });
      const row = probeDb
        .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
        .get() as { schema_version: unknown } | undefined;
      const raw = row?.schema_version;
      const coerced = Number(raw);
      existingVersion = Number.isNaN(coerced) ? 0 : coerced;
    } catch {
      existingVersion = 0;
    } finally {
      try {
        probeDb?.close();
      } catch {
        // ignore close errors on probe
      }
    }

    if (existingVersion === TrajectoryDB.TARGET_VERSION) return;

    if (existingVersion > TrajectoryDB.TARGET_VERSION) {
      throw new Error(
        `TrajectoryDB: ${dbPath} has schema_version=${existingVersion} but this binary supports up to ${TrajectoryDB.TARGET_VERSION}. Upgrade the plugin or restore from backup.`,
      );
    }

    if (existingVersion === 3) {
      return;
    }

    if (existingVersion > 0) {
      const backupPath = `${dbPath}.v${existingVersion}.bak.${Date.now()}`;
      renameSync(dbPath, backupPath);

      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        if (existsSync(sidecar)) {
          try {
            renameSync(sidecar, `${backupPath}${suffix}`);
          } catch {
            // sidecars may have been auto-cleaned; swallow
          }
        }
      }

      console.error(
        `[TrajectoryDB] HARD-BREAK MIGRATION: schema_version=${existingVersion} backed up to ${backupPath}; initializing fresh at v${TrajectoryDB.TARGET_VERSION}`,
      );
    }
  }

  private applyV3ToV4(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(tasks)')
      .all() as Array<{ name: string }>;
    const hasSpecPath = columns.some((c) => c.name === 'task_spec_path');
    if (!hasSpecPath) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN task_spec_path TEXT NOT NULL DEFAULT ''",
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discussions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id    INTEGER NOT NULL REFERENCES issues(id),
        author      TEXT    NOT NULL,
        kind        TEXT    NOT NULL DEFAULT 'note',
        body_md     TEXT    NOT NULL,
        created_at  TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discussions_issue_created
        ON discussions(issue_id, created_at);
    `);

    this.db.exec(
      "DELETE FROM plugin_meta WHERE id > (SELECT MIN(id) FROM plugin_meta)",
    );
    this.db
      .prepare(
        "UPDATE plugin_meta SET schema_version = 4, plugin_version = '0.3.0-alpha', updated_at = datetime('now')",
      )
      .run();
  }

  migrate(): void {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      'schema.sql',
    );

    let sql: string;
    try {
      sql = readFileSync(schemaPath, 'utf8');
    } catch (err) {
      throw new Error(
        `TrajectoryDB: cannot read schema file at ${schemaPath}: ${(err as Error).message}`,
      );
    }

    this.db.exec(sql);

    const row = this.db
      .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
      .get() as { schema_version: number } | undefined;

    if (row === undefined) {
      throw new Error(
        'TrajectoryDB: migration applied but plugin_meta has no rows — verify schema.sql includes the seed INSERT.',
      );
    }

    const taskCols = this.db
      .prepare('PRAGMA table_info(tasks)')
      .all() as Array<{ name: string }>;
    const needsV4 = !taskCols.some((c) => c.name === 'task_spec_path');
    if (needsV4) {
      this.applyV3ToV4();
    }
  }

  run(
    sql: string,
    params?: unknown[],
  ): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...(params ?? []));
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  get<T>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(...(params ?? [])) as T | undefined;
  }

  all<T>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params ?? [])) as T[];
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}
