import { readFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export class TrajectoryDB {
  static readonly TARGET_VERSION = 3;

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
