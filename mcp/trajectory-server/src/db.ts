import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { sqlLog } from './logger.js';

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
 * 2. Walk up from cwd to find an existing `.claude/<plugin>/trajectory.db`.
 *    Workspace-pattern projects keep the live DB at the workspace root above
 *    the inner repos; without this walk-up, the hook (PWD = inner repo) and
 *    the MCP server (PWD = workspace root) would resolve different DBs and
 *    bro would see false 'first contact' on every turn (#2872).
 * 3. Fallback: `<cwd>/.claude/<plugin-name>/trajectory.db` — fresh-init.
 */
export function resolveDbPath(opts?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}): string {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const override = env['TRAJECTORY_DB_PATH'];
  if (override && override.trim().length > 0) return override;
  const pluginName = resolvePluginName(env);
  const found = findExistingDbUp(cwd, pluginName, { home });
  if (found) return found;
  return join(cwd, '.claude', pluginName, 'trajectory.db');
}

function findExistingDbUp(
  startDir: string,
  pluginName: string,
  opts?: { home?: string },
): string | null {
  const home = opts?.home ?? homedir();
  let dir = startDir;
  // Walk up at most 8 levels — enough for any reasonable workspace nesting,
  // and bounds the cost when nothing exists.
  for (let i = 0; i < 8; i++) {
    // P0 guard: never traverse into the user's HOME via walk-up. Project
    // state belongs to a project, not the user's profile. If the user
    // launched from HOME itself (degenerate), the walk-up still checks
    // the starting dir but never traverses upward into HOME from a
    // descendant — that's how a stale ~/.claude/<plugin>/trajectory.db
    // (left over from a prior buggy session or a test artifact) would
    // otherwise be silently adopted as the live DB on every launch.
    if (dir === home && startDir !== home) return null;
    const candidate = join(dir, '.claude', pluginName, 'trajectory.db');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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
    this.syncPluginVersion();
  }

  private applySchema(): void {
    const schemaDir = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(schemaDir, 'schema.sql'), 'utf8');
    this.db.exec(sql);

    if (process.env['TMB_EVAL_MODE'] === '1') {
      const evalSql = readFileSync(join(schemaDir, 'schema-eval.sql'), 'utf8');
      this.db.exec(evalSql);
    }

    const row = this.db
      .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
      .get() as { schema_version: number } | undefined;

    if (row === undefined) {
      throw new Error(
        'TrajectoryDB: schema applied but plugin_meta has no rows — verify schema.sql seeds it.',
      );
    }
  }

  private syncPluginVersion(env: NodeJS.ProcessEnv = process.env): void {
    const root = env['CLAUDE_PLUGIN_ROOT'];
    if (!root) return;
    try {
      const manifest = JSON.parse(
        readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
      );
      if (typeof manifest.version !== 'string' || manifest.version.length === 0) return;
      this.db
        .prepare(`UPDATE plugin_meta SET plugin_version = ? WHERE id = 1`)
        .run(manifest.version);
    } catch {
      // Silent skip — leave existing value unchanged.
    }
  }

  run(
    sql: string,
    params?: unknown[],
  ): { changes: number; lastInsertRowid: number | bigint } {
    const start = performance.now();
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...((params ?? []) as never[]));
      const out = { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      sqlLog({
        kind: 'run',
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        rows_affected: out.changes,
        ok: true,
      });
      return out;
    } catch (err) {
      sqlLog({
        kind: 'run',
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        ok: false,
        error_message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  get<T>(sql: string, params?: unknown[]): T | undefined {
    const start = performance.now();
    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(...((params ?? []) as never[])) as T | undefined;
      sqlLog({
        kind: 'get',
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        row_count: row === undefined ? 0 : 1,
        ok: true,
      });
      return row;
    } catch (err) {
      sqlLog({
        kind: 'get',
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        ok: false,
        error_message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  all<T>(sql: string, params?: unknown[]): T[] {
    const start = performance.now();
    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...((params ?? []) as never[])) as T[];
      sqlLog({
        kind: 'all',
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        row_count: rows.length,
        ok: true,
      });
      return rows;
    } catch (err) {
      sqlLog({
        kind: 'all',
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        ok: false,
        error_message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
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
