import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * Resolve the plugin name from CLAUDE_PLUGIN_ROOT's manifest.
 *
 * CC sets CLAUDE_PLUGIN_ROOT to the installed plugin's source root, which
 * always contains `.claude-plugin/plugin.json` with the canonical `name`
 * field. Reading it lets the rc and stable channels write to different
 * filesystem paths despite running the same code (#87 channel isolation).
 *
 * Fallback to "tmb" only when CLAUDE_PLUGIN_ROOT is unset (local --plugin-dir
 * dev outside CC) or when the manifest is unreadable. Both fallbacks are
 * safe because no tmb-rc install can hit them — those paths only exist when
 * CC is invoking the server with a real plugin context.
 */
export function resolvePluginName(env: NodeJS.ProcessEnv = process.env): string {
  const root = env['CLAUDE_PLUGIN_ROOT'];
  if (!root) return 'tmb';
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    if (typeof manifest.name === 'string' && manifest.name.length > 0) {
      return manifest.name;
    }
  } catch {
    // Fall through to the default below.
  }
  return 'tmb';
}

/**
 * Resolve the trajectory DB path.
 *
 * 1. Explicit `TRAJECTORY_DB_PATH` env override wins. Power-user / CI use.
 * 2. Default: `<cwd>/.claude/<plugin-name>/trajectory.db` — project-local,
 *    per-user, per-channel. Stable installs write to `.claude/tmb/`,
 *    rc installs write to `.claude/tmb-rc/`. Auto-gitignored via the
 *    plugin-root `.gitignore` exclusion of `.claude/` (issue #87).
 */
export function resolveDbPath(opts?: { env?: NodeJS.ProcessEnv; cwd?: string }): string {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const override = env['TRAJECTORY_DB_PATH'];
  if (override && override.trim().length > 0) return override;
  const pluginName = resolvePluginName(env);
  return join(cwd, '.claude', pluginName, 'trajectory.db');
}

export class TrajectoryDB {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    // node:sqlite is part of Node's stdlib (>=22). Behind --experimental-sqlite
    // on 22.x, stable on 24+. The plugin's .mcp.json passes --experimental-sqlite
    // unconditionally — it's required on 22 and a no-op on 24+.
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.applySchema();
  }

  private applySchema(): void {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      'schema.sql',
    );
    const sql = readFileSync(schemaPath, 'utf8');
    this.db.exec(sql);

    // Migrate older DBs that pre-date the codebase-memory columns (#45)
    // and the A/B columns (#131). CREATE TABLE IF NOT EXISTS doesn't add
    // new columns to existing tables, so we explicitly ALTER any missing
    // ones. Idempotent — checks PRAGMA table_info first.
    this.migrateFileRegistryCodebaseMemory();
    this.migrateEvalResultsAbColumns();

    const row = this.db
      .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
      .get() as { schema_version: number } | undefined;

    if (row === undefined) {
      throw new Error(
        'TrajectoryDB: schema applied but plugin_meta has no rows — verify schema.sql seeds it.',
      );
    }
  }

  private migrateEvalResultsAbColumns(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(eval_results)')
      .all() as Array<{ name: string }>;
    const present = new Set(cols.map((c) => c.name));
    // 'arm' is NOT NULL DEFAULT 'control' on fresh installs; on existing DBs
    // we ALTER with the same default so old rows get backfilled. SQLite's
    // ALTER ADD COLUMN with a literal DEFAULT applies the default to existing
    // rows automatically.
    if (!present.has('arm')) {
      this.db.exec(
        `ALTER TABLE eval_results ADD COLUMN arm TEXT NOT NULL DEFAULT 'control'`,
      );
    }
    if (!present.has('scenario')) {
      this.db.exec(`ALTER TABLE eval_results ADD COLUMN scenario TEXT`);
    }
  }

  private migrateFileRegistryCodebaseMemory(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(file_registry)')
      .all() as Array<{ name: string }>;
    const present = new Set(cols.map((c) => c.name));
    const additions: Array<{ name: string; type: string }> = [
      { name: 'content_md5', type: 'TEXT' },
      { name: 'summary', type: 'TEXT' },
      { name: 'summary_updated_at', type: 'TEXT' },
    ];
    for (const { name, type } of additions) {
      if (!present.has(name)) {
        this.db.exec(`ALTER TABLE file_registry ADD COLUMN ${name} ${type}`);
      }
    }
  }

  run(
    sql: string,
    params?: unknown[],
  ): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...((params ?? []) as never[]));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get<T>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(...((params ?? []) as never[])) as T | undefined;
  }

  all<T>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...((params ?? []) as never[])) as T[];
  }

  /**
   * Wraps `fn` in a SQLite transaction. better-sqlite3 had a built-in
   * `db.transaction(fn)` helper; node:sqlite does not, so we issue
   * BEGIN/COMMIT/ROLLBACK explicitly.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ROLLBACK can fail if the txn was already broken; surface the
        // original error, not the rollback error.
      }
      throw err;
    }
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
