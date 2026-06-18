import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { sqlLog, serverLog } from './logger.js';

const TARGET_SCHEMA_VERSION = 20;

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
 * Resolve the plugin version from CLAUDE_PLUGIN_ROOT's manifest. Returns null
 * when the env is unset or the manifest is unreadable / carries no version —
 * the builtin-version backfill (#111) then leaves the column unchanged.
 */
export function resolvePluginVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env['CLAUDE_PLUGIN_ROOT'];
  if (!root) return null;
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    if (typeof manifest.version === 'string' && manifest.version.length > 0) {
      return manifest.version;
    }
  } catch {
    // Fall through to null below.
  }
  return null;
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
  readonly dbPath: string;

  /**
   * True when the DB opened with user tables present but NO plugin_meta table
   * (a pre-stamp legacy shape that predates schema versioning). Such a DB is
   * adopted forward (its tables are kept; the schema is reapplied) rather than
   * treated as a clean fresh install — but the ambiguity is surfaced as a
   * degraded signal so the upgrade is not silent. Non-fatal.
   */
  readonly legacyNoPluginMeta: boolean = false;

  constructor(dbPath: string) {
    // node:sqlite is part of Node's stdlib (>=22). Behind --experimental-sqlite
    // on 22.x, stable on 24+. The plugin's .mcp.json passes --experimental-sqlite
    // unconditionally — it's required on 22 and a no-op on 24+.
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.legacyNoPluginMeta = this.applySchema();
    this.syncPluginVersion();
    this.syncBuiltinVersions();
  }

  private applySchema(): boolean {
    const schemaDir = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(schemaDir, 'schema.sql'), 'utf8');

    const applyEvalIfNeeded = (): void => {
      if (process.env['TMB_EVAL_MODE'] === '1') {
        const evalSql = readFileSync(join(schemaDir, 'schema-eval.sql'), 'utf8');
        this.db.exec(evalSql);
      }
    };

    const verifySeed = (): void => {
      const row = this.db
        .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
        .get() as { schema_version: number } | undefined;
      if (row === undefined) {
        throw new Error(
          'TrajectoryDB: schema applied but plugin_meta has no rows — verify schema.sql seeds it.',
        );
      }
    };

    const pluginMetaExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_meta'")
      .get() as { name: string } | undefined;

    if (pluginMetaExists === undefined) {
      // No plugin_meta table. Two shapes land here:
      //   - A genuinely fresh DB (no user tables at all).
      //   - A pre-stamp LEGACY DB that already holds workflow tables but
      //     predates schema versioning (#602). Adopting that silently as
      //     "fresh" hides an unverified upgrade, so detect it and surface a
      //     degraded signal. Either way we reapply schema (CREATE IF NOT
      //     EXISTS is idempotent; the seed lands) — the difference is only
      //     whether we warn.
      const userTableCount = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .get() as { n: number };
      const isLegacy = userTableCount.n > 0;
      if (isLegacy) {
        serverLog({
          kind: 'legacy_db_no_plugin_meta',
          level: 'warn',
          db_path: this.dbPath,
          existing_tables: userTableCount.n,
          message:
            'TrajectoryDB: opened a DB with tables but no plugin_meta row (pre-stamp legacy shape). ' +
            'Adopting it forward and stamping schema_version — verify the upgrade and back up if unsure.',
        });
      }
      this.db.exec(sql);
      applyEvalIfNeeded();
      verifySeed();
      return isLegacy;
    }

    const versionRow = this.db
      .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
      .get() as { schema_version: number } | undefined;

    if (versionRow === undefined) {
      // plugin_meta table exists but is unseeded — treat as fresh; INSERT OR
      // IGNORE in schema.sql seeds it at the current TARGET_SCHEMA_VERSION.
      this.db.exec(sql);
      applyEvalIfNeeded();
      verifySeed();
      return false;
    }

    const storedVersion = versionRow.schema_version;

    if (storedVersion > TARGET_SCHEMA_VERSION) {
      throw new Error(
        `TrajectoryDB: stored schema_version ${storedVersion} is newer than code's max ${TARGET_SCHEMA_VERSION}; downgrade not supported. Use a newer plugin version, or restore the .bak file from before the upgrade.`,
      );
    }

    if (storedVersion < TARGET_SCHEMA_VERSION) {
      backupDbBeforeMigration(this.db, this.dbPath, TARGET_SCHEMA_VERSION);
      runMigrations(this.db, storedVersion, TARGET_SCHEMA_VERSION);
      this.db.exec(sql);
      this.db
        .prepare('UPDATE plugin_meta SET schema_version = ? WHERE id = 1')
        .run(TARGET_SCHEMA_VERSION);
      applyEvalIfNeeded();
      verifySeed();
      return false;
    }

    // storedVersion === TARGET_SCHEMA_VERSION — idempotent reapply.
    this.db.exec(sql);
    applyEvalIfNeeded();
    verifySeed();
    return false;
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

  /**
   * Backfill the builtin cheatcodes' `version` to the plugin version (#111).
   * The schema-seed (schema.sql) and the v19→v20 migration both insert builtin
   * skill rows with version NULL — the SKILL.md body is the source of truth, but
   * the registry row should still record which plugin version shipped it so
   * cheatcode_list surfaces a version for every row. Runs every startup against
   * the resolved plugin version; a no-op when the version is unresolvable.
   */
  private syncBuiltinVersions(env: NodeJS.ProcessEnv = process.env): void {
    const version = resolvePluginVersion(env);
    if (!version) return;
    try {
      this.db
        .prepare(`UPDATE cheatcodes SET version = ? WHERE origin = 'builtin'`)
        .run(version);
    } catch {
      // Silent skip — a DB without the cheatcodes table leaves builtins untouched.
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

export type RepoRow = {
  name: string;
  path: string;
  file_count: number;
  last_scanned_at: string;
  target_branch: string | null;
  branching_model: string | null;
  protected_branches: string | null;
};

export type CheatcodeRow = {
  id: number;
  name: string;
  kind: 'skill' | 'mcp' | 'plugin';
  origin: 'builtin' | 'installed';
  description: string;
  source_url: string | null;
  file_path: string | null;
  version: string | null;
  trust_tier: string | null;
  scope: 'global' | 'template' | 'project-local';
  // Lifecycle (#112): 'installed' = recorded but not confirmed loaded;
  // 'active' = loaded/usable (builtins seed here); 'broken' = recorded but
  // failed (e.g. a teardown that left the artifact on disk). No CHECK on the
  // column — runtime reconciliation to active/broken is the health-check (#113).
  status: 'installed' | 'active' | 'broken';
  installed_at: string;
  created_at: string;
  updated_at: string;
};

export type CheatcodeAttachmentRow = {
  id: number;
  cheatcode_id: number;
  target: string;
  artifact: string;
  created_at: string;
};

/**
 * Resolve the repos row whose `path` matches the git toplevel of `gitRoot`.
 * Returns null when no registered repo matches (unregistered repo → guards no-op).
 */
export function resolveRepoByPath(db: TrajectoryDB, gitRoot: string): RepoRow | null {
  const row = db.get<RepoRow>(
    `SELECT * FROM repos WHERE path = ? LIMIT 1`,
    [gitRoot],
  );
  return row ?? null;
}


function backupDbBeforeMigration(
  db: DatabaseSync,
  dbPath: string,
  targetVersion: number,
): void {
  if (!dbPath || dbPath === ':memory:') return;
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  const prefix = `${base}.pre-v${targetVersion}.`;
  try {
    const existing = readdirSync(dir).some(
      (f) => f.startsWith(prefix) && f.endsWith('.bak'),
    );
    if (existing) return;
  } catch {
    // Directory not readable — fall through; copy will surface the real error.
  }

  // Flush WAL into the main DB file before copyFileSync. Without this the
  // backup captures only the main .db (pending WAL writes are excluded), so
  // a user restoring from .bak after a crashed migration would silently
  // lose any pre-migration writes that hadn't checkpointed yet.
  try {
    db.prepare('PRAGMA wal_checkpoint(FULL)').get();
  } catch {
    // Checkpoint can fail if another connection holds the lock. Proceed
    // with a best-effort backup rather than fail the boot.
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.pre-v${targetVersion}.${timestamp}.bak`;
  copyFileSync(dbPath, backupPath);
}

function runMigrations(
  db: DatabaseSync,
  fromVersion: number,
  toVersion: number,
): void {
  if (fromVersion < 2 && toVersion >= 2) {
    migrateV1toV2(db);
  }
  if (fromVersion < 3 && toVersion >= 3) {
    migrateV2toV3(db);
  }
  if (fromVersion < 4 && toVersion >= 4) {
    migrateV3toV4(db);
  }
  if (fromVersion < 5 && toVersion >= 5) {
    migrateV4toV5(db);
  }
  if (fromVersion < 6 && toVersion >= 6) {
    migrateV5toV6(db);
  }
  if (fromVersion < 7 && toVersion >= 7) {
    migrateV6toV7(db);
  }
  if (fromVersion < 8 && toVersion >= 8) {
    migrateV7toV8(db);
  }
  if (fromVersion < 9 && toVersion >= 9) {
    migrateV8toV9(db);
  }
  if (fromVersion < 10 && toVersion >= 10) {
    migrateV9toV10(db);
  }
  if (fromVersion < 11 && toVersion >= 11) {
    migrateV10toV11(db);
  }
  if (fromVersion < 12 && toVersion >= 12) {
    migrateV11toV12(db);
  }
  if (fromVersion < 13 && toVersion >= 13) {
    migrateV12toV13(db);
  }
  if (fromVersion < 14 && toVersion >= 14) {
    migrateV13toV14(db);
  }
  if (fromVersion < 15 && toVersion >= 15) {
    migrateV14toV15(db);
  }
  if (fromVersion < 16 && toVersion >= 16) {
    migrateV15toV16(db);
  }
  if (fromVersion < 17 && toVersion >= 17) {
    migrateV16toV17(db);
  }
  if (fromVersion < 18 && toVersion >= 18) {
    migrateV17toV18(db);
  }
  if (fromVersion < 19 && toVersion >= 19) {
    migrateV18toV19(db);
  }
  if (fromVersion < 20 && toVersion >= 20) {
    migrateV19toV20(db);
  }
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === column);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

function migrateV8toV9(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'agent_runs')) {
      if (!hasColumn(db, 'agent_runs', 'cache_read_tokens')) {
        db.exec('ALTER TABLE agent_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0');
      }
      if (!hasColumn(db, 'agent_runs', 'cache_creation_tokens')) {
        db.exec('ALTER TABLE agent_runs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0');
      }
    }
    if (tableExists(db, 'pr_review_runs')) {
      if (!hasColumn(db, 'pr_review_runs', 'task_id')) {
        db.exec('ALTER TABLE pr_review_runs ADD COLUMN task_id INTEGER REFERENCES tasks(id)');
      }
      if (!hasColumn(db, 'pr_review_runs', 'verdict')) {
        db.exec('ALTER TABLE pr_review_runs ADD COLUMN verdict TEXT');
      }
      if (!hasColumn(db, 'pr_review_runs', 'attempt_n')) {
        db.exec('ALTER TABLE pr_review_runs ADD COLUMN attempt_n INTEGER');
      }
      // Recreate the (pr_number, repo) unique index as a partial index so
      // that audit rows (pr_number = 0) can coexist for multiple attempts.
      // Drop the old unconditional index first, then create the new one.
      db.exec('DROP INDEX IF EXISTS idx_pr_review_runs_pr');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_runs_pr ON pr_review_runs(pr_number, repo) WHERE pr_number > 0',
      );
      const auditIdxExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pr_review_runs_audit'")
        .get() as { name: string } | undefined;
      if (!auditIdxExists) {
        db.exec(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_runs_audit ON pr_review_runs(task_id, attempt_n) WHERE task_id IS NOT NULL',
        );
      }
      const taskIdxExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pr_review_runs_task'")
        .get() as { name: string } | undefined;
      if (!taskIdxExists) {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_pr_review_runs_task ON pr_review_runs(task_id)',
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV9toV10(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'tasks')) {
      if (!hasColumn(db, 'tasks', 'prompt_bearing')) {
        db.exec('ALTER TABLE tasks ADD COLUMN prompt_bearing INTEGER NOT NULL DEFAULT 0');
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV10toV11(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'repos')) {
      if (!hasColumn(db, 'repos', 'target_branch')) {
        db.exec('ALTER TABLE repos ADD COLUMN target_branch TEXT');
      }
      if (!hasColumn(db, 'repos', 'branching_model')) {
        db.exec('ALTER TABLE repos ADD COLUMN branching_model TEXT');
      }
      if (!hasColumn(db, 'repos', 'protected_branches')) {
        db.exec('ALTER TABLE repos ADD COLUMN protected_branches TEXT');
      }

      // Backfill per-repo config from global plugin_config so existing
      // single-repo installs behave identically after the upgrade.
      if (tableExists(db, 'plugin_config')) {
        const prTargetRow = db
          .prepare("SELECT value_json FROM plugin_config WHERE key = 'pr_target'")
          .get() as { value_json: string } | undefined;
        const branchingModelRow = db
          .prepare("SELECT value_json FROM plugin_config WHERE key = 'branching_model'")
          .get() as { value_json: string } | undefined;
        const protectedBranchesRow = db
          .prepare("SELECT value_json FROM plugin_config WHERE key = 'protected_branches'")
          .get() as { value_json: string } | undefined;

        const prTarget = prTargetRow?.value_json
          ? (() => {
              try {
                const v = JSON.parse(prTargetRow.value_json) as unknown;
                return typeof v === 'string' && v.length > 0 ? v : null;
              } catch { return null; }
            })()
          : null;

        const branchingModel = branchingModelRow?.value_json
          ? (() => {
              try {
                const v = JSON.parse(branchingModelRow.value_json) as unknown;
                return typeof v === 'string' && v.length > 0 ? v : null;
              } catch { return null; }
            })()
          : null;

        const protectedBranches = protectedBranchesRow?.value_json ?? null;

        if (prTarget !== null || branchingModel !== null || protectedBranches !== null) {
          db.prepare(`
            UPDATE repos
               SET target_branch     = COALESCE(target_branch, ?),
                   branching_model   = COALESCE(branching_model, ?),
                   protected_branches = COALESCE(protected_branches, ?)
             WHERE target_branch IS NULL
               AND branching_model IS NULL
               AND protected_branches IS NULL
          `).run(prTarget, branchingModel, protectedBranches);
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV11toV12(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'agent_runs')) {
      if (!hasColumn(db, 'agent_runs', 'usage_baseline_json')) {
        db.exec('ALTER TABLE agent_runs ADD COLUMN usage_baseline_json TEXT');
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

// Typed Rails (#673): add typed files/verification task columns the enforcement
// hooks read directly. Both are JSON arrays defaulting to '[]'; existing task
// rows keep that empty default, so the hooks skip enforcement for pre-migration
// tasks. See docs/architecture/TYPED_RAILS.md.
function migrateV12toV13(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'tasks')) {
      if (!hasColumn(db, 'tasks', 'files')) {
        db.exec("ALTER TABLE tasks ADD COLUMN files TEXT NOT NULL DEFAULT '[]'");
      }
      if (!hasColumn(db, 'tasks', 'verification')) {
        db.exec("ALTER TABLE tasks ADD COLUMN verification TEXT NOT NULL DEFAULT '[]'");
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

// Cheatcode install stage (#659): the cheatcodes catalog + its attachment
// records. Both are net-new tables, so CREATE IF NOT EXISTS is enough — there is
// no existing data to reshape. applySchema re-runs schema.sql after migrations
// and would create them in the fresh-DB path too; creating them here keeps the
// migration self-contained and idempotent regardless of starting shape.
function migrateV13toV14(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cheatcodes (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          source_url   TEXT    NOT NULL,
          version      TEXT,
          trust_tier   TEXT,
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          UNIQUE(name, source_url)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cheatcode_attachments (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          cheatcode_id INTEGER NOT NULL REFERENCES cheatcodes(id) ON DELETE CASCADE,
          target       TEXT    NOT NULL,
          artifact     TEXT    NOT NULL,
          created_at   TEXT    NOT NULL
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_cheatcode_attachments_cheatcode ON cheatcode_attachments(cheatcode_id)',
    );
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

// Cheatcode install scope (#659): record where each install lands. Adds the
// cheatcodes.scope column (NOT NULL DEFAULT 'local') so existing rows adopt the
// project-scoped default. ALTER ADD COLUMN can't carry the CHECK constraint that
// schema.sql declares for fresh DBs, but applySchema re-runs schema.sql after
// migrations and the column already matching name+default keeps both paths in
// sync.
function migrateV14toV15(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'cheatcodes') && !hasColumn(db, 'cheatcodes', 'scope')) {
      db.exec("ALTER TABLE cheatcodes ADD COLUMN scope TEXT NOT NULL DEFAULT 'local'");
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV15toV16(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    // Drop the dead rules + rule_invocations registry (#97 schema audit):
    // honor-system-only, 0 rows everywhere, zero readers. Drop the child
    // junction table first so the FK to rules(name) is gone before rules.
    // LINT-ALLOW: v15→v16 migration retires the dead rules registry (#97 schema audit).
    db.exec('DROP TABLE IF EXISTS rule_invocations');
    // LINT-ALLOW: v15→v16 migration retires the dead rules registry (#97 schema audit).
    db.exec('DROP TABLE IF EXISTS rules');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV16toV17(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    // Drop the dead commands catalog (#97 schema audit): seed-only, read only
    // by command_list; nothing routes on it (CC discovers commands/*.md
    // directly), command_register was honor-system + unused. No junction/child
    // table references it.
    // LINT-ALLOW: v16→v17 migration retires the dead commands catalog (#97 schema audit).
    db.exec('DROP TABLE IF EXISTS commands');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV17toV18(db: DatabaseSync): void {
  if (
    !tableExists(db, 'skills') ||
    !(
      hasColumn(db, 'skills', 'uses') ||
      hasColumn(db, 'skills', 'successes') ||
      hasColumn(db, 'skills', 'effectiveness')
    )
  ) {
    return;
  }

  // Drop the dead skill effectiveness stats (#97 schema audit): the
  // skills.uses/successes/effectiveness columns are 100% unpopulated, read only
  // by reports.ts, and written only by the now-removed skill_record_outcome
  // tool. Rebuild the skills table without them, preserving every other column
  // (scope/trust_tier/status). The skill_invocations FK references skills(name)
  // by value, so per SQLite's table-rebuild guidance foreign_keys is toggled
  // OFF around the swap (it cannot change inside a transaction) and the FK is
  // re-checked afterward. After the rename skills(name) still holds every
  // referenced name, so the check passes.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    // LINT-ALLOW: scratch table for SQLite-style column drop via rebuild.
    db.exec('DROP TABLE IF EXISTS skills_new');
    db.exec(`
      CREATE TABLE skills_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT    NOT NULL UNIQUE,
          description     TEXT    NOT NULL,
          file_path       TEXT    NOT NULL,
          scope           TEXT    NOT NULL DEFAULT 'global'
                            CHECK (scope IN ('global','template','project-local')),
          trust_tier      TEXT    NOT NULL DEFAULT 'curated',
          status          TEXT    NOT NULL DEFAULT 'active',
          created_at      TEXT    NOT NULL,
          updated_at      TEXT    NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO skills_new (id, name, description, file_path, scope, trust_tier, status, created_at, updated_at)
      SELECT id, name, description, file_path, scope, trust_tier, status, created_at, updated_at FROM skills
    `);
    // LINT-ALLOW: column-drop rebuild — data already copied into skills_new.
    db.exec('DROP TABLE skills');
    db.exec('ALTER TABLE skills_new RENAME TO skills');
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV17toV18: foreign_key_check found ${violations.length} dangling reference(s) after skills rebuild`,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Unify the skills table into cheatcodes (#101). One typed capability registry:
// cheatcodes gains origin (builtin|installed) + file_path + description +
// created_at/updated_at, the install scope enum (local,global) folds into the
// skill placement enum (global,template,project-local) with local→project-local,
// and the builtin/installed CHECKs are enforced. The dead `skills` table is
// dropped after its rows migrate in as origin='builtin'.
//
// skill_invocations.skill_name FKs skills(name); we drop skills and reshape
// cheatcodes, so the FK is repointed to cheatcodes(name) via a coordinated
// rebuild. Per SQLite's table-rebuild guidance foreign_keys is toggled OFF
// around the swap (it cannot change inside a transaction) and re-checked after.
// Idempotent: a DB already at the unified shape (no skills table, cheatcodes has
// origin) is left untouched.
function migrateV18toV19(db: DatabaseSync): void {
  const skillsPresent = tableExists(db, 'skills');
  const cheatcodesUnified = tableExists(db, 'cheatcodes') && hasColumn(db, 'cheatcodes', 'origin');
  // Already at the unified shape with nothing left to fold in → no-op.
  if (cheatcodesUnified && !skillsPresent) {
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    // (1) Bring cheatcodes to the unified shape. Two pre-v19 starting points:
    //   - cheatcodes exists (pre-#101 install shape): rebuild it, mapping each
    //     installed row's scope local→project-local / global→global. file_path
    //     /description are absent pre-v19 so they take defaults / NULL; created_
    //     at/updated_at adopt installed_at.
    //   - cheatcodes absent (a DB seeded at v17 or earlier where the v13→v14
    //     create never ran): create the unified table fresh — no rows to copy.
    if (!cheatcodesUnified) {
      // LINT-ALLOW: scratch table for the SQLite table-rebuild swap (#101).
      db.exec('DROP TABLE IF EXISTS cheatcodes_new');
      db.exec(`
        CREATE TABLE cheatcodes_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT    NOT NULL UNIQUE,
            kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
            origin       TEXT    NOT NULL DEFAULT 'installed' CHECK (origin IN ('builtin','installed')),
            description  TEXT    NOT NULL DEFAULT '',
            source_url   TEXT,
            file_path    TEXT,
            version      TEXT,
            trust_tier   TEXT,
            scope        TEXT    NOT NULL DEFAULT 'project-local'
                           CHECK (scope IN ('global','template','project-local')),
            status       TEXT    NOT NULL DEFAULT 'installed',
            installed_at TEXT    NOT NULL,
            created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            CHECK (kind != 'skill' OR file_path IS NOT NULL),
            CHECK (origin != 'installed' OR source_url IS NOT NULL),
            CHECK (origin != 'builtin' OR source_url IS NULL)
        )
      `);
      if (tableExists(db, 'cheatcodes')) {
        db.exec(`
          INSERT INTO cheatcodes_new
            (id, name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
          SELECT
            id, name, kind, 'installed', '', source_url, NULL, version, trust_tier,
            CASE scope WHEN 'local' THEN 'project-local' WHEN 'global' THEN 'global' ELSE 'project-local' END,
            status, installed_at, installed_at, installed_at
          FROM cheatcodes
        `);
        // LINT-ALLOW: table-rebuild swap — installed rows already copied (#101).
        db.exec('DROP TABLE cheatcodes');
      }
      db.exec('ALTER TABLE cheatcodes_new RENAME TO cheatcodes');
    }

    // (2) Fold the skills rows in as origin='builtin' (kind='skill',
    // source_url NULL per the builtin CHECK). installed_at adopts created_at.
    if (tableExists(db, 'skills')) {
      db.exec(`
        INSERT OR IGNORE INTO cheatcodes
          (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
        SELECT
          name, 'skill', 'builtin', description, NULL, file_path, NULL, trust_tier, scope, status, created_at, created_at, updated_at
        FROM skills
      `);
    }

    // (3) Rebuild skill_invocations so its FK targets cheatcodes(name) instead
    // of the dropped skills(name). Rows are copied verbatim. The agent_runs /
    // tasks FKs are only declared when those parent tables already exist —
    // migrations run before the final applySchema re-creates them, so on a DB
    // seeded at v17 (which never had them) we keep the plain INTEGER columns
    // that shape already used, matching pre-migration behaviour.
    if (tableExists(db, 'skill_invocations')) {
      const agentRunFk = tableExists(db, 'agent_runs') ? ' REFERENCES agent_runs(id)' : '';
      const taskFk = tableExists(db, 'tasks') ? ' REFERENCES tasks(id)' : '';
      // LINT-ALLOW: scratch table for the FK-repoint rebuild (#101).
      db.exec('DROP TABLE IF EXISTS skill_invocations_new');
      db.exec(`
        CREATE TABLE skill_invocations_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            skill_name    TEXT    NOT NULL REFERENCES cheatcodes(name),
            agent_name    TEXT    NOT NULL,
            agent_run_id  INTEGER${agentRunFk},
            task_id       INTEGER${taskFk},
            invoked_at    TEXT    NOT NULL,
            outcome       TEXT    NOT NULL DEFAULT 'completed'
                            CHECK (outcome IN ('completed','failed','partial'))
        )
      `);
      db.exec(`
        INSERT INTO skill_invocations_new (id, skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome)
        SELECT id, skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome FROM skill_invocations
      `);
      // LINT-ALLOW: FK-repoint rebuild — rows already copied (#101).
      db.exec('DROP TABLE skill_invocations');
      db.exec('ALTER TABLE skill_invocations_new RENAME TO skill_invocations');
      db.exec('CREATE INDEX IF NOT EXISTS idx_skill_invocations_skill ON skill_invocations(skill_name)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_skill_invocations_task  ON skill_invocations(task_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_skill_invocations_agent_run ON skill_invocations(agent_run_id)');
    }

    // (4) Drop the now-empty skills registry.
    // LINT-ALLOW: v18→v19 migration retires the skills table, folded into cheatcodes (#101).
    db.exec('DROP TABLE IF EXISTS skills');

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV18toV19: foreign_key_check found ${violations.length} dangling reference(s) after the skills→cheatcodes unification`,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// v19→v20: correct the builtin-skill seed drift carried forward by the #101
// unification. The seed listed `tmb_agent-creator` (its skills/ dir was deleted
// at v0.7.0 → a dangling catalog row) and omitted `tmb_cheatcode` (a shipped
// skill whose invocations the skill-invocation-record.sh FK check silently
// drops with no seed row). Pure row correction — no table/FK rebuild. The dead
// name has no skill_invocations referencing it (the dir never shipped a row
// before v18→v19 either), so the DELETE is safe; foreign_key_check verifies it.
function migrateV19toV20(db: DatabaseSync): void {
  if (!tableExists(db, 'cheatcodes')) {
    return;
  }
  db.exec('BEGIN');
  try {
    // LINT-ALLOW: v19→v20 removes the dangling tmb_agent-creator builtin row (dir deleted v0.7.0, no invocations reference it) (#102).
    db.exec("DELETE FROM cheatcodes WHERE name = 'tmb_agent-creator' AND origin = 'builtin'");
    db.exec(`
      INSERT OR IGNORE INTO cheatcodes
        (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
      VALUES
        ('tmb_cheatcode', 'skill', 'builtin',
         'When bro hits a wall — a task leans on a capability the project lacks and a published skill / MCP toolkit / plugin would close the gap — name the gap, cheatcode_search for ranked candidates, judge the best fit, and recommend it for Human approval.',
         NULL, 'skills/tmb_cheatcode/SKILL.md', NULL, 'curated', 'global', 'active',
         datetime('now'), datetime('now'), datetime('now'))
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV19toV20: foreign_key_check found ${violations.length} dangling reference(s) after the builtin-skill seed correction`,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV7toV8(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    // Drop the SQLite directories infrastructure — world model moved to
    // kuzu graph DB (ADR 0002). World-model data is rebuilt from /scan on
    // first use; nothing to migrate out.
    db.exec('DROP TRIGGER IF EXISTS directories_au_new');
    db.exec('DROP TRIGGER IF EXISTS directories_au');
    db.exec('DROP TRIGGER IF EXISTS directories_ad');
    db.exec('DROP TRIGGER IF EXISTS directories_ai');
    db.exec('DROP INDEX IF EXISTS idx_directories_embeddings_model');
    db.exec('DROP INDEX IF EXISTS idx_directories_parent');
    // LINT-ALLOW: v7→v8 migration retires the SQLite world-model tables per ADR 0002 (graph DB substrate).
    db.exec('DROP TABLE IF EXISTS directories_embeddings');
    // LINT-ALLOW: v7→v8 migration retires the SQLite world-model tables per ADR 0002 (graph DB substrate).
    db.exec('DROP TABLE IF EXISTS directories_fts');
    // LINT-ALLOW: v7→v8 migration retires the SQLite world-model tables per ADR 0002 (graph DB substrate).
    db.exec('DROP TABLE IF EXISTS directories');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV6toV7(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    // Drop file_registry infrastructure — superseded by the directory-level
    // world model (ADR 0001). Order matters: triggers reference the virtual
    // FTS table, which references the base table; drop in reverse-dependency.
    db.exec('DROP TRIGGER IF EXISTS file_registry_au_new');
    db.exec('DROP TRIGGER IF EXISTS file_registry_au');
    db.exec('DROP TRIGGER IF EXISTS file_registry_ad');
    db.exec('DROP TRIGGER IF EXISTS file_registry_ai');
    db.exec('DROP INDEX IF EXISTS idx_file_registry_embeddings_model');
    // LINT-ALLOW: v6→v7 migration retires file_registry per ADR 0001 (world-model substrate replaces per-file index).
    db.exec('DROP TABLE IF EXISTS file_registry_embeddings');
    // LINT-ALLOW: v6→v7 migration retires file_registry per ADR 0001 (world-model substrate replaces per-file index).
    db.exec('DROP TABLE IF EXISTS file_registry_fts');
    // LINT-ALLOW: v6→v7 migration retires file_registry per ADR 0001 (world-model substrate replaces per-file index).
    db.exec('DROP TABLE IF EXISTS file_registry');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV5toV6(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS directories (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "repo TEXT NOT NULL DEFAULT '', " +
      "path TEXT NOT NULL, " +
      "parent_path TEXT, " +
      "summary TEXT, " +
      "summary_source TEXT CHECK (summary_source IN ('readme','llm','manual')) DEFAULT 'llm', " +
      "summary_updated_at TEXT, " +
      "file_count INTEGER NOT NULL DEFAULT 0, " +
      "UNIQUE(repo, path))",
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_directories_parent ON directories(repo, parent_path)',
    );
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS directories_fts USING fts5(summary, path, content='directories', tokenize='porter unicode61')",
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_ai AFTER INSERT ON directories WHEN new.summary IS NOT NULL BEGIN INSERT INTO directories_fts(rowid, summary, path) VALUES (new.id, new.summary, new.path); END",
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_ad AFTER DELETE ON directories WHEN old.summary IS NOT NULL BEGIN INSERT INTO directories_fts(directories_fts, rowid, summary, path) VALUES ('delete', old.id, old.summary, old.path); END",
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_au AFTER UPDATE ON directories WHEN old.summary IS NOT NULL BEGIN INSERT INTO directories_fts(directories_fts, rowid, summary, path) VALUES ('delete', old.id, old.summary, old.path); END",
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_au_new AFTER UPDATE ON directories WHEN new.summary IS NOT NULL BEGIN INSERT INTO directories_fts(rowid, summary, path) VALUES (new.id, new.summary, new.path); END",
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS directories_embeddings (' +
      'directory_id INTEGER PRIMARY KEY, ' +
      'embedding BLOB NOT NULL, ' +
      'model_id TEXT NOT NULL, ' +
      'embedded_at TEXT NOT NULL)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_directories_embeddings_model ON directories_embeddings(model_id)',
    );
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV4toV5(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'issues')) {
      if (!hasColumn(db, 'issues', 'gh_iid')) {
        db.exec('ALTER TABLE issues ADD COLUMN gh_iid INTEGER');
      }
      if (!hasColumn(db, 'issues', 'gl_iid')) {
        db.exec('ALTER TABLE issues ADD COLUMN gl_iid INTEGER');
      }
      db.exec(
        "UPDATE issues SET gh_iid = remote_iid WHERE remote_kind = 'github' AND remote_iid IS NOT NULL AND gh_iid IS NULL",
      );
      db.exec(
        "UPDATE issues SET gl_iid = remote_iid WHERE remote_kind = 'gitlab' AND remote_iid IS NOT NULL AND gl_iid IS NULL",
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV3toV4(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    // Source-table guards. The synthetic legacy-v1 upgrade fixture only
    // seeds plugin_meta + plugin_config, so the FK references would fail
    // with foreign_keys=ON. applySchema re-runs schema.sql after migrations
    // and will create the embedding companions in the fresh-DB path.

    if (tableExists(db, 'discussions')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS discussions_embeddings (
          discussion_id INTEGER PRIMARY KEY REFERENCES discussions(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          embedded_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_discussions_embeddings_model
        ON discussions_embeddings(model_id)
      `);
    }

    if (tableExists(db, 'audit')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_embeddings (
          audit_id INTEGER PRIMARY KEY REFERENCES audit(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          embedded_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_embeddings_model
        ON audit_embeddings(model_id)
      `);
    }

    if (tableExists(db, 'file_registry')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_registry_embeddings (
          file_registry_id INTEGER PRIMARY KEY,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          embedded_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_file_registry_embeddings_model
        ON file_registry_embeddings(model_id)
      `);
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV2toV3(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    // Source-table guards. On a synthetic legacy-v1 upgrade path (only
    // plugin_meta + plugin_config seeded), the base content tables don't
    // exist — FTS5 external-content tables require their source table to
    // exist at CREATE time. applySchema re-runs schema.sql after migrations
    // and creates the FTS5 companions in the fresh-DB path, so skipping
    // here keeps the migration step idempotent regardless of starting shape.

    if (tableExists(db, 'discussions')) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS discussions_fts USING fts5(
          body,
          content='discussions',
          content_rowid='id',
          tokenize='porter unicode61'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS discussions_ai AFTER INSERT ON discussions BEGIN
          INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS discussions_ad AFTER DELETE ON discussions BEGIN
          INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS discussions_au AFTER UPDATE ON discussions BEGIN
          INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
          INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
        END
      `);
      db.exec(`INSERT INTO discussions_fts(rowid, body) SELECT id, body FROM discussions`);
    }

    if (tableExists(db, 'audit')) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
          summary,
          content_json,
          content='audit',
          content_rowid='id',
          tokenize='porter unicode61'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_ai AFTER INSERT ON audit BEGIN
          INSERT INTO audit_fts(rowid, summary, content_json) VALUES (new.id, new.summary, new.content_json);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_ad AFTER DELETE ON audit BEGIN
          INSERT INTO audit_fts(audit_fts, rowid, summary, content_json) VALUES ('delete', old.id, old.summary, old.content_json);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_au AFTER UPDATE ON audit BEGIN
          INSERT INTO audit_fts(audit_fts, rowid, summary, content_json) VALUES ('delete', old.id, old.summary, old.content_json);
          INSERT INTO audit_fts(rowid, summary, content_json) VALUES (new.id, new.summary, new.content_json);
        END
      `);
      db.exec(`INSERT INTO audit_fts(rowid, summary, content_json) SELECT id, summary, content_json FROM audit`);
    }

    if (tableExists(db, 'file_registry')) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS file_registry_fts USING fts5(
          summary,
          path,
          content='file_registry',
          tokenize='porter unicode61'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_ai AFTER INSERT ON file_registry
        WHEN new.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(rowid, summary, path) VALUES (new.rowid, new.summary, new.path);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_ad AFTER DELETE ON file_registry
        WHEN old.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(file_registry_fts, rowid, summary, path) VALUES ('delete', old.rowid, old.summary, old.path);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_au AFTER UPDATE ON file_registry
        WHEN old.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(file_registry_fts, rowid, summary, path) VALUES ('delete', old.rowid, old.summary, old.path);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_au_new AFTER UPDATE ON file_registry
        WHEN new.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(rowid, summary, path) VALUES (new.rowid, new.summary, new.path);
        END
      `);
      db.exec(`INSERT INTO file_registry_fts(rowid, summary, path) SELECT rowid, summary, path FROM file_registry WHERE summary IS NOT NULL`);
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}

function migrateV1toV2(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    // Translate the legacy onboarded marker forward before dropping its table.
    // Pre-#2876, `identity` was a single-row marker (presence == onboarded).
    // Post-#2876 the marker lives in plugin_config('onboarded': true). Without
    // this translation, an upgraded user re-fires the onboarding ceremony.
    if (tableExists(db, 'identity') && tableExists(db, 'plugin_config')) {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM identity')
        .get() as { n: number } | undefined;
      if (row && row.n > 0) {
        db.exec(
          "INSERT OR IGNORE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')",
        );
      }
    }

    // LINT-ALLOW: v1->v2 migration drops zombie tables retired pre-#2886.
    db.exec('DROP TABLE IF EXISTS identity');
    // LINT-ALLOW: v1->v2 migration drops zombie tables retired pre-#2886.
    db.exec('DROP TABLE IF EXISTS regen_state');
    // LINT-ALLOW: v1->v2 migration drops zombie tables retired pre-#2886.
    db.exec('DROP TABLE IF EXISTS project_metadata');

    if (tableExists(db, 'skills') && !hasColumn(db, 'skills', 'scope')) {
      db.exec(
        "ALTER TABLE skills ADD COLUMN scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','template','project-local'))",
      );
    }

    if (tableExists(db, 'tasks') && hasColumn(db, 'tasks', 'success_criteria')) {
      // LINT-ALLOW: scratch table for SQLite-style column drop via rebuild.
      db.exec('DROP TABLE IF EXISTS tasks_new');
      db.exec(`
        CREATE TABLE tasks_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id          INTEGER NOT NULL REFERENCES issues(id),
            branch_id         TEXT    NOT NULL,
            parent_branch_id  TEXT,
            title             TEXT    NOT NULL DEFAULT '',
            description       TEXT    NOT NULL,
            status            TEXT    NOT NULL DEFAULT 'pending',
            attempts          INTEGER NOT NULL DEFAULT 0,
            spec_body         TEXT    NOT NULL DEFAULT '',
            commit_sha        TEXT,
            repo              TEXT,
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL,
            completed_at      TEXT
        )
      `);
      db.exec(`
        INSERT INTO tasks_new (id, issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, commit_sha, repo, created_at, updated_at, completed_at)
        SELECT id, issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, commit_sha, repo, created_at, updated_at, completed_at FROM tasks
      `);
      // LINT-ALLOW: column-drop rebuild — data already copied into tasks_new.
      db.exec('DROP TABLE tasks');
      db.exec('ALTER TABLE tasks_new RENAME TO tasks');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)',
      );
    }

    if (tableExists(db, 'roundtables') && hasColumn(db, 'roundtables', 'agent')) {
      // LINT-ALLOW: scratch table for SQLite-style column drop via rebuild.
      db.exec('DROP TABLE IF EXISTS roundtables_new');
      db.exec(`
        CREATE TABLE roundtables_new (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id                INTEGER NOT NULL REFERENCES issues(id),
            topic                   TEXT    NOT NULL,
            outcome                 TEXT    NOT NULL DEFAULT '',
            created_at              TEXT    NOT NULL,
            closed_at               TEXT,
            state                   TEXT    NOT NULL DEFAULT 'collecting'
                                      CHECK (state IN ('collecting','awaiting_human','closed','skipped')),
            expected_participants   INTEGER
        )
      `);
      const hasState = hasColumn(db, 'roundtables', 'state');
      const hasExpected = hasColumn(db, 'roundtables', 'expected_participants');
      const stateExpr = hasState ? 'state' : "'collecting' AS state";
      const expectedExpr = hasExpected
        ? 'expected_participants'
        : 'NULL AS expected_participants';
      db.exec(`
        INSERT INTO roundtables_new (id, issue_id, topic, outcome, created_at, closed_at, state, expected_participants)
        SELECT id, issue_id, topic, outcome, created_at, closed_at, ${stateExpr}, ${expectedExpr} FROM roundtables
      `);
      // LINT-ALLOW: column-drop rebuild — data already copied into roundtables_new.
      db.exec('DROP TABLE roundtables');
      db.exec('ALTER TABLE roundtables_new RENAME TO roundtables');
    }

    if (
      tableExists(db, 'roundtable_votes') &&
      hasColumn(db, 'roundtable_votes', 'agent')
    ) {
      // LINT-ALLOW: scratch table for SQLite-style column drop via rebuild.
      db.exec('DROP TABLE IF EXISTS roundtable_votes_new');
      db.exec(`
        CREATE TABLE roundtable_votes_new (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            roundtable_id  INTEGER NOT NULL REFERENCES roundtables(id),
            participant    TEXT    NOT NULL,
            vote           TEXT    NOT NULL,
            rationale      TEXT    NOT NULL DEFAULT '',
            created_at     TEXT    NOT NULL
        )
      `);
      const hasParticipant = hasColumn(db, 'roundtable_votes', 'participant');
      const participantExpr = hasParticipant ? 'participant' : 'agent AS participant';
      db.exec(`
        INSERT INTO roundtable_votes_new (id, roundtable_id, participant, vote, rationale, created_at)
        SELECT id, roundtable_id, ${participantExpr}, vote, rationale, created_at FROM roundtable_votes
      `);
      // LINT-ALLOW: column-drop rebuild — data already copied into roundtable_votes_new.
      db.exec('DROP TABLE roundtable_votes');
      db.exec('ALTER TABLE roundtable_votes_new RENAME TO roundtable_votes');
    }

    if (tableExists(db, 'file_registry')) {
      const stale = [
        'size_bytes',
        'last_commit_sha',
        'language',
        'last_change_type',
        'last_change_at',
        'imports_json',
        'exports_json',
        'metadata_json',
      ];
      const hasStale = stale.some((c) => hasColumn(db, 'file_registry', c));
      if (hasStale) {
        // LINT-ALLOW: scratch table for SQLite-style column drop via rebuild.
        db.exec('DROP TABLE IF EXISTS file_registry_new');
        db.exec(`
          CREATE TABLE file_registry_new (
              repo                TEXT NOT NULL DEFAULT '',
              path                TEXT NOT NULL,
              type                TEXT NOT NULL DEFAULT 'unknown',
              content_md5         TEXT,
              summary             TEXT,
              summary_updated_at  TEXT,
              PRIMARY KEY (repo, path)
          )
        `);
        const hasRepo = hasColumn(db, 'file_registry', 'repo');
        const hasType = hasColumn(db, 'file_registry', 'type');
        const hasContentMd5 = hasColumn(db, 'file_registry', 'content_md5');
        const hasSummary = hasColumn(db, 'file_registry', 'summary');
        const hasSummaryUpdated = hasColumn(db, 'file_registry', 'summary_updated_at');
        const repoExpr = hasRepo ? 'repo' : "'' AS repo";
        const typeExpr = hasType ? 'type' : "'unknown' AS type";
        const md5Expr = hasContentMd5 ? 'content_md5' : 'NULL AS content_md5';
        const summaryExpr = hasSummary ? 'summary' : 'NULL AS summary';
        const summaryUpdatedExpr = hasSummaryUpdated
          ? 'summary_updated_at'
          : 'NULL AS summary_updated_at';
        db.exec(`
          INSERT OR IGNORE INTO file_registry_new (repo, path, type, content_md5, summary, summary_updated_at)
          SELECT ${repoExpr}, path, ${typeExpr}, ${md5Expr}, ${summaryExpr}, ${summaryUpdatedExpr} FROM file_registry
        `);
        // LINT-ALLOW: column-drop rebuild — data already copied into file_registry_new.
        db.exec('DROP TABLE file_registry');
        db.exec('ALTER TABLE file_registry_new RENAME TO file_registry');
      }
    }

    if (tableExists(db, 'agent_runs')) {
      if (!hasColumn(db, 'agent_runs', 'started_at')) {
        db.exec('ALTER TABLE agent_runs ADD COLUMN started_at TEXT');
      }
      const cols = db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      const completedCol = cols.find((c) => c.name === 'completed_at');
      if (completedCol && completedCol.notnull === 1) {
        // LINT-ALLOW: scratch table for SQLite-style NOT NULL drop via rebuild.
        db.exec('DROP TABLE IF EXISTS agent_runs_new');
        db.exec(`
          CREATE TABLE agent_runs_new (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id      INTEGER REFERENCES tasks(id),
              issue_id     INTEGER REFERENCES issues(id),
              agent_type   TEXT    NOT NULL,
              tokens_in    INTEGER NOT NULL DEFAULT 0,
              tokens_out   INTEGER NOT NULL DEFAULT 0,
              tokens_total INTEGER NOT NULL DEFAULT 0,
              tool_uses    INTEGER NOT NULL DEFAULT 0,
              duration_ms  INTEGER NOT NULL DEFAULT 0,
              started_at   TEXT,
              completed_at TEXT
          )
        `);
        db.exec(`
          INSERT INTO agent_runs_new (id, task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, started_at, completed_at)
          SELECT id, task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, started_at, completed_at FROM agent_runs
        `);
        // LINT-ALLOW: NOT-NULL-relaxation rebuild — data already copied into agent_runs_new.
        db.exec('DROP TABLE agent_runs');
        db.exec('ALTER TABLE agent_runs_new RENAME TO agent_runs');
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id)',
        );
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id)',
        );
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Original error wins.
    }
    throw err;
  }
}
