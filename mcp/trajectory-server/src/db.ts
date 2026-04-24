import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Resolve the trajectory DB path.
 *
 * 1. Explicit `TRAJECTORY_DB_PATH` env override wins. Power-user / CI use.
 * 2. Default: `<cwd>/.claude/tmb/trajectory.db` — project-local, per-user,
 *    auto-gitignored via the plugin-root `.gitignore` exclusion of `.claude/`.
 */
export function resolveDbPath(opts?: { env?: NodeJS.ProcessEnv; cwd?: string }): string {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const override = env['TRAJECTORY_DB_PATH'];
  if (override && override.trim().length > 0) return override;
  return join(cwd, '.claude', 'tmb', 'trajectory.db');
}

export class TrajectoryDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.applySchema();
  }

  private applySchema(): void {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      'schema.sql',
    );
    const sql = readFileSync(schemaPath, 'utf8');
    this.db.exec(sql);

    const row = this.db
      .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
      .get() as { schema_version: number } | undefined;

    if (row === undefined) {
      throw new Error(
        'TrajectoryDB: schema applied but plugin_meta has no rows — verify schema.sql seeds it.',
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
