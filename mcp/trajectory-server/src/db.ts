import { copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import {
  sqlLog as defaultSqlLog,
  serverLog as defaultServerLog,
} from './logger.js';
import {
  assertSafeProjectWritePath,
  resolveClaudeDbPath,
  resolveClaudePluginName,
  resolveClaudePluginVersion,
} from './platform.js';
import { AUDIT_EVENT_TYPES } from './audit-events.js';
import { parseLegacyRemotes, primaryIndex, remoteProvider } from './repos/remotes.js';

export const TARGET_SCHEMA_VERSION = 40;

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
  return resolveClaudePluginName(env);
}

/**
 * Resolve the plugin version from CLAUDE_PLUGIN_ROOT's manifest. Returns null
 * when the env is unset or the manifest is unreadable / carries no version —
 * the builtin-version backfill (#111) then leaves the column unchanged.
 */
export function resolvePluginVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveClaudePluginVersion(env);
}

/**
 * Resolve the trajectory DB path: the DB found by `findExistingClaudeDbUp`
 * (platform.ts), else a fresh-init path under `CLAUDE_PROJECT_DIR` (or cwd). The rule is
 * documented in docs/reference/TRAJECTORY_DB_LOCATION.md.
 */
export function resolveDbPath(opts?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}): string {
  return resolveClaudeDbPath(opts);
}

export type TrajectoryLog = (entry: Record<string, unknown>) => void;

export interface TrajectoryDBDependencies {
  /**
   * Explicitly nullable. When a dependency object is supplied it is
   * authoritative; null does not fall back to Claude environment discovery.
   */
  readonly pluginVersion: string | null;
  readonly serverLog: TrajectoryLog;
  readonly sqlLog: TrajectoryLog;
  /** Canonical project root for Codex-bound persistent databases. */
  readonly trustedProjectRoot?: string;
}

export class TrajectoryDB {
  private db: DatabaseSync;
  private readonly pluginVersion: string | null;
  private readonly serverLog: TrajectoryLog;
  private readonly sqlLog: TrajectoryLog;
  readonly dbPath: string;

  /**
   * True when the DB opened with user tables present but NO plugin_meta table
   * (a pre-stamp legacy shape that predates schema versioning). Such a DB is
   * adopted forward (its tables are kept; the schema is reapplied) rather than
   * treated as a clean fresh install — but the ambiguity is surfaced as a
   * degraded signal so the upgrade is not silent. Non-fatal.
   */
  readonly legacyNoPluginMeta: boolean = false;

  constructor(dbPath: string, dependencies?: TrajectoryDBDependencies) {
    // node:sqlite is part of Node's stdlib (>=22). Behind --experimental-sqlite
    // on 22.x, stable on 24+. The plugin's .mcp.json passes --experimental-sqlite
    // unconditionally — it's required on 22 and a no-op on 24+.
    const resolvedDependencies = resolveDependencies(dependencies);

    this.dbPath = dbPath;
    this.pluginVersion = resolvedDependencies.pluginVersion;
    this.serverLog = resolvedDependencies.serverLog;
    this.sqlLog = resolvedDependencies.sqlLog;
    if (
      dbPath !== ':memory:' &&
      resolvedDependencies.trustedProjectRoot !== undefined
    ) {
      assertSafeProjectWritePath(
        resolvedDependencies.trustedProjectRoot,
        dbPath,
        'Trajectory database',
        'file',
      );
    }
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.legacyNoPluginMeta = this.applySchema();
      this.syncPluginVersion();
      this.syncBuiltinVersions();
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the initialization error if SQLite already closed itself.
      }
      throw error;
    }
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
        this.serverLog({
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

  private syncPluginVersion(): void {
    if (!this.pluginVersion) return;
    try {
      this.db
        .prepare(`UPDATE plugin_meta SET plugin_version = ? WHERE id = 1`)
        .run(this.pluginVersion);
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
  private syncBuiltinVersions(): void {
    if (!this.pluginVersion) return;
    try {
      this.db
        .prepare(`UPDATE cheatcodes SET version = ? WHERE origin = 'builtin'`)
        .run(this.pluginVersion);
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
      this.sqlLog({
        kind: 'run',
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        rows_affected: out.changes,
        ok: true,
      });
      return out;
    } catch (err) {
      this.sqlLog({
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
      this.sqlLog({
        kind: 'get',
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        row_count: row === undefined ? 0 : 1,
        ok: true,
      });
      return row;
    } catch (err) {
      this.sqlLog({
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
      this.sqlLog({
        kind: 'all',
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance.now() - start),
        row_count: rows.length,
        ok: true,
      });
      return rows;
    } catch (err) {
      this.sqlLog({
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

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  close(): void {
    this.db.close();
  }
}

function resolveDependencies(
  dependencies: TrajectoryDBDependencies | undefined,
): TrajectoryDBDependencies {
  if (dependencies === undefined) {
    return {
      pluginVersion: resolvePluginVersion(process.env),
      serverLog: noThrowTrajectoryLog(defaultServerLog),
      sqlLog: noThrowTrajectoryLog(defaultSqlLog),
    };
  }
  if (
    dependencies.pluginVersion !== null &&
    (typeof dependencies.pluginVersion !== 'string' ||
      dependencies.pluginVersion.trim().length === 0)
  ) {
    throw new TypeError(
      'TrajectoryDB dependencies.pluginVersion must be a non-empty string or null',
    );
  }
  if (typeof dependencies.serverLog !== 'function') {
    throw new TypeError('TrajectoryDB dependencies.serverLog must be a function');
  }
  if (typeof dependencies.sqlLog !== 'function') {
    throw new TypeError('TrajectoryDB dependencies.sqlLog must be a function');
  }
  return {
    pluginVersion: dependencies.pluginVersion,
    serverLog: noThrowTrajectoryLog(dependencies.serverLog),
    sqlLog: noThrowTrajectoryLog(dependencies.sqlLog),
    trustedProjectRoot: dependencies.trustedProjectRoot,
  };
}

function noThrowTrajectoryLog(log: TrajectoryLog): TrajectoryLog {
  return (entry) => {
    try {
      log(entry);
    } catch {
      // Observability must never change a database operation's result.
    }
  };
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
  origin: 'builtin' | 'marketplace' | 'external';
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
  if (fromVersion < 21 && toVersion >= 21) {
    migrateV20toV21(db);
  }
  if (fromVersion < 22 && toVersion >= 22) {
    migrateV21toV22(db);
  }
  if (fromVersion < 23 && toVersion >= 23) {
    migrateV22toV23(db);
  }
  if (fromVersion < 24 && toVersion >= 24) {
    migrateV23toV24(db);
  }
  if (fromVersion < 25 && toVersion >= 25) {
    migrateV24toV25(db);
  }
  if (fromVersion < 26 && toVersion >= 26) {
    migrateV25toV26(db);
  }
  if (fromVersion < 27 && toVersion >= 27) {
    migrateV26toV27(db);
  }
  if (fromVersion < 28 && toVersion >= 28) {
    migrateV27toV28(db);
  }
  if (fromVersion < 29 && toVersion >= 29) {
    migrateV28toV29(db);
  }
  if (fromVersion < 30 && toVersion >= 30) {
    migrateV29toV30(db);
  }
  if (fromVersion < 31 && toVersion >= 31) {
    migrateV30toV31(db);
  }
  if (fromVersion < 32 && toVersion >= 32) {
    migrateV31toV32(db);
  }
  if (fromVersion < 33 && toVersion >= 33) {
    migrateV32toV33(db);
  }
  if (fromVersion < 34 && toVersion >= 34) {
    migrateV33toV34(db);
  }
  if (fromVersion < 35 && toVersion >= 35) {
    migrateV34toV35(db);
  }
  if (fromVersion < 36 && toVersion >= 36) {
    migrateV35toV36(db);
  }
  if (fromVersion < 37 && toVersion >= 37) {
    migrateV36toV37(db);
  }
  if (fromVersion < 38 && toVersion >= 38) {
    migrateV37toV38(db);
  }
  if (fromVersion < 39 && toVersion >= 39) {
    migrateV38toV39(db);
  }
  if (fromVersion < 40 && toVersion >= 40) {
    migrateV39toV40(db);
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

function readTableSql(db: DatabaseSync, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? '';
}

// SQLite cannot ALTER a CHECK, a DEFAULT or a column's nullability in place, so
// a table is rebuilt: create `<table>_new`, copy every row keeping ids (columns
// missing from the old shape take their fallback expression), swap, and carry
// the AUTOINCREMENT high-water mark over. Callers run it inside their own
// transaction with foreign_keys OFF and re-create the table's indexes.
function rebuildTable(
  db: DatabaseSync,
  table: string,
  createBody: string,
  columns: Array<[string, string]>,
): void {
  const scratch = `${table}_new`;
  const select = columns
    .map(([name, fallback]) => (hasColumn(db, table, name) ? name : `${fallback} AS ${name}`))
    .join(', ');
  const seqRow = tableExists(db, 'sqlite_sequence')
    ? (db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as
        | { seq: number }
        | undefined)
    : undefined;
  // LINT-ALLOW: scratch table for the SQLite table-rebuild swap.
  db.exec(`DROP TABLE IF EXISTS ${scratch}`);
  db.exec(`CREATE TABLE ${scratch} (${createBody})`);
  db.exec(
    `INSERT INTO ${scratch} (${columns.map(([name]) => name).join(', ')}) SELECT ${select} FROM ${table}`,
  );
  // LINT-ALLOW: table-rebuild swap — rows already copied into the scratch table.
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${scratch} RENAME TO ${table}`);
  if (seqRow !== undefined) {
    db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(seqRow.seq, table);
  }
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

// v20→v21: retire skill_invocations (#118). TMB no longer records skill/plugin/
// cheatcode usage in the trajectory DB — verification moved to the stream-json
// log. Drop the table outright; no replacement. Its only FK referenced
// cheatcodes(name), so dropping it leaves no dangling references in other tables.
function migrateV20toV21(db: DatabaseSync): void {
  // LINT-ALLOW: v20→v21 drops the unused skill_invocations table; no FK references (see comment above)
  db.exec('DROP TABLE IF EXISTS skill_invocations');
}

function migrateV21toV22(db: DatabaseSync): void {
  // #83/#763 — bind issues to a milestone. Nullable, append-only; existing
  // rows get NULL (no backfill). tableExists handles partial-seed fixtures
  // and hasColumn guards an idempotent re-run.
  if (tableExists(db, 'issues') && !hasColumn(db, 'issues', 'milestone')) {
    db.exec('ALTER TABLE issues ADD COLUMN milestone TEXT');
  }
}

function migrateV27toV28(db: DatabaseSync): void {
  // #53 — persist the validated label set on the issue row so issue_sync_retry
  // replays the original labels instead of re-deriving defaultSyncLabels.
  // Nullable JSON array string, append-only; existing rows get NULL (no
  // backfill) — NULL means "created pre-v28" and keeps the defaultSyncLabels
  // fallback. tableExists handles partial-seed fixtures and hasColumn guards an
  // idempotent re-run.
  if (tableExists(db, 'issues') && !hasColumn(db, 'issues', 'labels')) {
    db.exec('ALTER TABLE issues ADD COLUMN labels TEXT');
  }
}

// v28→v29: closed-enum CHECKs, dead-column drops, cursor-only pr_review_runs.
//
//   tasks               — drop `attempts`; CHECK on status.
//   issues              — drop `remote_iid` (gh_iid/gl_iid are canonical; any
//                         row still carrying only remote_iid is backfilled
//                         first); CHECK on status. The id=-1 system row and
//                         every id survive the copy.
//   validation_attempts — CHECK on verdict; mcp_available loses its DEFAULT.
//   discussions         — CHECK on kind. The FTS5 triggers are recreated and
//                         discussions_fts is rebuilt; embeddings are untouched.
//   milestones          — CHECK on state.
//   agents              — drop the never-read `status` column.
//   pr_review_runs      — the pr_number=0 validation sentinels are deleted;
//                         verdict/attempt_n go; pr_number>0 and repo<>'' are
//                         enforced with a plain UNIQUE (pr_number, repo).
//   plugin_config       — the drained `tmb_default_repo` residue is deleted.
//
// SQLite cannot ALTER a CHECK in, so each table is rebuilt (create _new, copy
// keeping ids, swap) with foreign_keys OFF; foreign_key_check re-validates
// before COMMIT. Rows that would violate a new constraint abort the migration
// with one error naming every offending table.column and value. Each rebuild is
// guarded on the old shape, so a re-run against a v29 shape is a no-op. The new
// hot-path indexes live in schema.sql, which is re-applied after migration.
function migrateV28toV29(db: DatabaseSync): void {
  const tableSql = (table: string): string => readTableSql(db, table);
  const needsRebuild = (table: string, checkMarker: string, droppedColumn?: string): boolean =>
    tableExists(db, table) &&
    ((droppedColumn !== undefined && hasColumn(db, table, droppedColumn)) ||
      !tableSql(table).includes(checkMarker));
  const rebuild = (table: string, createBody: string, columns: Array<[string, string]>): void =>
    rebuildTable(db, table, createBody, columns);

  const TASK_STATUSES = "'pending','running','needs_validation','completed','closed','failed','escalated'";
  const OPEN_CLOSED = "'open','closed'";
  const VERDICTS = "'pass','fail','escalate'";
  const DISCUSSION_KINDS = "'intent','question','answer','decision','note','analysis'";

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'pr_review_runs')) {
      // LINT-ALLOW: v29 retires the validation_record audit sentinels; verdicts live in validation_attempts.
      db.exec('DELETE FROM pr_review_runs WHERE pr_number = 0');
    }

    const probes: Array<[string, string, string]> = [
      ['tasks', 'status', `status NOT IN (${TASK_STATUSES})`],
      ['issues', 'status', `status NOT IN (${OPEN_CLOSED})`],
      ['validation_attempts', 'verdict', `verdict NOT IN (${VERDICTS})`],
      ['validation_attempts', 'mcp_available', 'mcp_available IS NULL'],
      ['discussions', 'kind', `kind NOT IN (${DISCUSSION_KINDS})`],
      ['milestones', 'state', `state NOT IN (${OPEN_CLOSED})`],
      ['pr_review_runs', 'pr_number', 'pr_number IS NULL OR pr_number <= 0'],
      ['pr_review_runs', 'repo', "repo IS NULL OR repo = ''"],
    ];
    const violations: string[] = [];
    for (const [table, column, predicate] of probes) {
      if (!tableExists(db, table) || !hasColumn(db, table, column)) continue;
      const bad = db
        .prepare(`SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${predicate} LIMIT 20`)
        .all() as Array<{ v: unknown }>;
      if (bad.length > 0) {
        violations.push(`${table}.${column} = ${bad.map((r) => JSON.stringify(r.v)).join(', ')}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `migrateV28toV29: rows violate the new v29 constraints — fix or delete them, then reopen: ${violations.join('; ')}`,
      );
    }

    if (needsRebuild('tasks', 'CHECK (status IN', 'attempts')) {
      rebuild(
        'tasks',
        `
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id          INTEGER NOT NULL REFERENCES issues(id),
          branch_id         TEXT    NOT NULL,
          parent_branch_id  TEXT,
          title             TEXT    NOT NULL DEFAULT '',
          description       TEXT    NOT NULL,
          status            TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN (${TASK_STATUSES})),
          spec_body         TEXT    NOT NULL DEFAULT '',
          commit_sha        TEXT,
          repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          prompt_bearing    INTEGER NOT NULL DEFAULT 0,
          files             TEXT    NOT NULL DEFAULT '[]',
          verification      TEXT    NOT NULL DEFAULT '[]',
          created_at        TEXT    NOT NULL,
          updated_at        TEXT    NOT NULL,
          completed_at      TEXT
        `,
        [
          ['id', 'NULL'], ['issue_id', 'NULL'], ['branch_id', 'NULL'], ['parent_branch_id', 'NULL'],
          ['title', "''"], ['description', "''"], ['status', "'pending'"], ['spec_body', "''"],
          ['commit_sha', 'NULL'], ['repo', 'NULL'], ['prompt_bearing', '0'], ['files', "'[]'"],
          ['verification', "'[]'"], ['created_at', 'NULL'], ['updated_at', 'NULL'], ['completed_at', 'NULL'],
        ],
      );
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)');
    }

    if (needsRebuild('issues', 'CHECK (status IN', 'remote_iid')) {
      if (hasColumn(db, 'issues', 'remote_iid')) {
        db.exec(
          "UPDATE issues SET gh_iid = remote_iid WHERE remote_kind = 'github' AND remote_iid IS NOT NULL AND gh_iid IS NULL",
        );
        db.exec(
          "UPDATE issues SET gl_iid = remote_iid WHERE remote_kind = 'gitlab' AND remote_iid IS NOT NULL AND gl_iid IS NULL",
        );
      }
      rebuild(
        'issues',
        `
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          objective         TEXT    NOT NULL,
          description       TEXT    NOT NULL DEFAULT '',
          status            TEXT    NOT NULL DEFAULT 'open' CHECK (status IN (${OPEN_CLOSED})),
          created_at        TEXT    NOT NULL,
          updated_at        TEXT    NOT NULL,
          closed_at         TEXT,
          remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab')),
          gh_iid            INTEGER,
          gl_iid            INTEGER,
          repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          milestone         TEXT,
          labels            TEXT,
          FOREIGN KEY (milestone, repo) REFERENCES milestones(name, repo) ON DELETE RESTRICT
        `,
        [
          ['id', 'NULL'], ['objective', "''"], ['description', "''"], ['status', "'open'"],
          ['created_at', 'NULL'], ['updated_at', 'NULL'], ['closed_at', 'NULL'], ['remote_kind', 'NULL'],
          ['gh_iid', 'NULL'], ['gl_iid', 'NULL'], ['repo', 'NULL'], ['milestone', 'NULL'], ['labels', 'NULL'],
        ],
      );
    }

    if (needsRebuild('validation_attempts', 'CHECK (verdict IN')) {
      rebuild(
        'validation_attempts',
        `
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id             INTEGER NOT NULL REFERENCES tasks(id),
          attempt_n           INTEGER NOT NULL,
          agent               TEXT    NOT NULL DEFAULT '',
          verdict             TEXT    NOT NULL CHECK (verdict IN (${VERDICTS})),
          feedback            TEXT    NOT NULL DEFAULT '',
          mcp_available       INTEGER NOT NULL,
          subagent_session_id TEXT,
          repo                TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          created_at          TEXT    NOT NULL,
          UNIQUE(task_id, attempt_n)
        `,
        [
          ['id', 'NULL'], ['task_id', 'NULL'], ['attempt_n', 'NULL'], ['agent', "''"], ['verdict', 'NULL'],
          ['feedback', "''"], ['mcp_available', '1'], ['subagent_session_id', 'NULL'], ['repo', 'NULL'],
          ['created_at', 'NULL'],
        ],
      );
    }

    if (needsRebuild('discussions', 'CHECK (kind IN')) {
      const embeddingsCount = (): number =>
        tableExists(db, 'discussions_embeddings')
          ? (db.prepare('SELECT COUNT(*) AS n FROM discussions_embeddings').get() as { n: number }).n
          : 0;
      const embeddingsBefore = embeddingsCount();
      rebuild(
        'discussions',
        `
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id       INTEGER NOT NULL REFERENCES issues(id),
          author         TEXT    NOT NULL,
          kind           TEXT    NOT NULL DEFAULT 'note'
                           CHECK (kind IN (${DISCUSSION_KINDS})),
          body           TEXT    NOT NULL,
          repo           TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          created_at     TEXT    NOT NULL
        `,
        [
          ['id', 'NULL'], ['issue_id', 'NULL'], ['author', "''"], ['kind', "'note'"], ['body', "''"],
          ['repo', 'NULL'], ['created_at', 'NULL'],
        ],
      );
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_discussions_issue_created ON discussions(issue_id, created_at)',
      );
      if (tableExists(db, 'discussions_fts')) {
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS discussions_ai AFTER INSERT ON discussions BEGIN
            INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
          END;
          CREATE TRIGGER IF NOT EXISTS discussions_ad AFTER DELETE ON discussions BEGIN
            INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
          END;
          CREATE TRIGGER IF NOT EXISTS discussions_au AFTER UPDATE ON discussions BEGIN
            INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
            INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
          END;
        `);
        db.exec("INSERT INTO discussions_fts(discussions_fts) VALUES('rebuild')");
      }
      const embeddingsAfter = embeddingsCount();
      if (embeddingsAfter !== embeddingsBefore) {
        throw new Error(
          `migrateV28toV29: discussions_embeddings changed from ${embeddingsBefore} to ${embeddingsAfter} rows across the discussions rebuild`,
        );
      }
    }

    if (needsRebuild('milestones', 'CHECK (state IN')) {
      rebuild(
        'milestones',
        `
          name   TEXT NOT NULL,
          repo   TEXT NOT NULL REFERENCES repos(name) ON DELETE RESTRICT,
          state  TEXT NOT NULL DEFAULT 'open' CHECK (state IN (${OPEN_CLOSED})),
          PRIMARY KEY (name, repo)
        `,
        [['name', 'NULL'], ['repo', 'NULL'], ['state', "'open'"]],
      );
    }

    if (tableExists(db, 'agents') && hasColumn(db, 'agents', 'status')) {
      // LINT-ALLOW: v29 drops the never-read agents.status column.
      db.exec('ALTER TABLE agents DROP COLUMN status');
    }

    if (needsRebuild('pr_review_runs', 'CHECK (pr_number > 0)', 'verdict')) {
      rebuild(
        'pr_review_runs',
        `
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          pr_number       INTEGER NOT NULL CHECK (pr_number > 0),
          repo            TEXT    NOT NULL CHECK (repo <> ''),
          last_fetched_at DATETIME NOT NULL,
          last_comment_id TEXT,
          task_id         INTEGER REFERENCES tasks(id),
          UNIQUE (pr_number, repo)
        `,
        [
          ['id', 'NULL'], ['pr_number', 'NULL'], ['repo', 'NULL'], ['last_fetched_at', 'NULL'],
          ['last_comment_id', 'NULL'], ['task_id', 'NULL'],
        ],
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_pr_review_runs_task ON pr_review_runs(task_id)');
    }
    // LINT-ALLOW: the partial and audit indexes are superseded by the table-level UNIQUE (v29).
    db.exec('DROP INDEX IF EXISTS idx_pr_review_runs_pr');
    // LINT-ALLOW: the audit index keyed the retired validation_record sentinel rows (v29).
    db.exec('DROP INDEX IF EXISTS idx_pr_review_runs_audit');

    if (tableExists(db, 'plugin_config')) {
      // LINT-ALLOW: tmb_default_repo was drained into the repos table; the residue key is dead (v29).
      db.exec("DELETE FROM plugin_config WHERE key = 'tmb_default_repo'");
    }

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV28toV29: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v29 rebuilds`,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const ISO_NOW_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

// Every timestamp column the trajectory schema owns. v30 normalizes them all to
// the one ms-ISO format `YYYY-MM-DDTHH:MM:SS.sssZ` (24 chars).
const TIMESTAMP_COLUMNS: Array<[string, string]> = [
  ['audit', 'created_at'],
  ['tasks', 'created_at'],
  ['tasks', 'updated_at'],
  ['tasks', 'completed_at'],
  ['issues', 'created_at'],
  ['issues', 'updated_at'],
  ['issues', 'closed_at'],
  ['discussions', 'created_at'],
  ['validation_attempts', 'created_at'],
  ['agent_runs', 'started_at'],
  ['agent_runs', 'completed_at'],
  ['roundtables', 'created_at'],
  ['roundtables', 'closed_at'],
  ['roundtable_votes', 'created_at'],
  ['agents', 'created_at'],
  ['agents', 'updated_at'],
  ['cheatcodes', 'installed_at'],
  ['cheatcodes', 'created_at'],
  ['cheatcodes', 'updated_at'],
  ['cheatcode_attachments', 'created_at'],
  ['repos', 'last_scanned_at'],
  ['pr_review_runs', 'last_fetched_at'],
  ['discussions_embeddings', 'embedded_at'],
  ['audit_embeddings', 'embedded_at'],
];

// v29→v30: agent_runs metering columns, discussions.remote_comment_id, one
// timestamp format.
//
//   agent_runs  — rebuilt: the four token columns become nullable with no
//                 DEFAULT (NULL = unmeasured); spawn_id / session_id /
//                 usage_source (CHECKed) are added. Closed rows whose four token
//                 columns are all 0 become NULL + 'unmeasured'; other closed rows
//                 take 'transcript' (bro) or 'subagent_stop' (everything else);
//                 open rows copy unchanged with usage_source NULL.
//   discussions — remote_comment_id via ADD COLUMN (FTS + triggers untouched)
//                 with a partial UNIQUE index on the non-NULL values.
//   agents, cheatcodes, repos — rebuilt so their DEFAULTs write ms-ISO.
//   every timestamp column — any non-24-char value strftime can parse (the
//                 hook-written `YYYY-MM-DD HH:MM:SS` and `…SSZ`, microsecond or
//                 offset stamps, date-only values) is rewritten to the 24-char
//                 ms-ISO form; a value strftime cannot parse aborts the migration.
//
// Same rebuild discipline as v29: foreign_keys OFF, one transaction, rows that
// would violate a rebuilt table's CHECKs abort up front with one error naming
// them, and foreign_key_check re-validates before COMMIT. Each step is guarded
// on the old shape, so a re-run against a v30 shape is a no-op.
function migrateV29toV30(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const probes: Array<[string, string, string]> = [
      ['agents', 'kind', "kind NOT IN ('backbone','consultant')"],
      ['agents', 'scope', "scope NOT IN ('global','template','project-local')"],
      ['cheatcodes', 'kind', "kind NOT IN ('skill','mcp','plugin')"],
      ['cheatcodes', 'origin', "origin NOT IN ('builtin','marketplace','external')"],
      ['cheatcodes', 'scope', "scope NOT IN ('global','template','project-local')"],
      ['cheatcodes', 'name', "kind = 'skill' AND file_path IS NULL"],
      ['cheatcodes', 'name', "origin <> 'builtin' AND source_url IS NULL"],
      ['cheatcodes', 'name', "origin = 'builtin' AND source_url IS NOT NULL"],
    ];
    const violations: string[] = [];
    for (const [table, column, predicate] of probes) {
      if (!tableExists(db, table) || !hasColumn(db, table, column)) continue;
      const bad = db
        .prepare(`SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${predicate} LIMIT 20`)
        .all() as Array<{ v: unknown }>;
      if (bad.length > 0) {
        violations.push(`${table}.${column} = ${bad.map((r) => JSON.stringify(r.v)).join(', ')} (${predicate})`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `migrateV29toV30: rows violate the rebuilt v30 constraints — fix or delete them, then reopen: ${violations.join('; ')}`,
      );
    }

    if (tableExists(db, 'agent_runs') && !hasColumn(db, 'agent_runs', 'usage_source')) {
      rebuildTable(
        db,
        'agent_runs',
        `
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id               INTEGER REFERENCES tasks(id),
          issue_id              INTEGER REFERENCES issues(id),
          agent_type            TEXT    NOT NULL,
          tokens_in             INTEGER,
          tokens_out            INTEGER,
          tokens_total          INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER,
          cache_creation_tokens INTEGER,
          tool_uses             INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          started_at            TEXT,
          completed_at          TEXT,
          usage_baseline_json   TEXT,
          repo                  TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          spawn_id              TEXT,
          session_id            TEXT,
          usage_source          TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured'))
        `,
        [
          ['id', 'NULL'], ['task_id', 'NULL'], ['issue_id', 'NULL'], ['agent_type', "''"],
          ['tokens_in', 'NULL'], ['tokens_out', 'NULL'], ['tokens_total', '0'], ['cache_read_tokens', 'NULL'],
          ['cache_creation_tokens', 'NULL'], ['tool_uses', '0'], ['duration_ms', '0'], ['started_at', 'NULL'],
          ['completed_at', 'NULL'], ['usage_baseline_json', 'NULL'], ['repo', 'NULL'], ['spawn_id', 'NULL'],
          ['session_id', 'NULL'], ['usage_source', 'NULL'],
        ],
      );
      db.exec(`
        UPDATE agent_runs
           SET tokens_in = NULL, tokens_out = NULL, cache_read_tokens = NULL, cache_creation_tokens = NULL,
               usage_source = 'unmeasured'
         WHERE completed_at IS NOT NULL
           AND tokens_in = 0 AND tokens_out = 0 AND cache_read_tokens = 0 AND cache_creation_tokens = 0
      `);
      db.exec(`
        UPDATE agent_runs
           SET usage_source = CASE agent_type WHEN 'bro' THEN 'transcript' ELSE 'subagent_stop' END
         WHERE completed_at IS NOT NULL AND usage_source IS NULL
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;
      `);
    }

    if (tableExists(db, 'discussions') && !hasColumn(db, 'discussions', 'remote_comment_id')) {
      db.exec('ALTER TABLE discussions ADD COLUMN remote_comment_id TEXT');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_discussions_remote_comment ON discussions(remote_comment_id) WHERE remote_comment_id IS NOT NULL',
      );
    }

    const needsIsoDefault = (table: string): boolean =>
      tableExists(db, table) && !readTableSql(db, table).includes('strftime(');

    if (needsIsoDefault('agents')) {
      rebuildTable(
        db,
        'agents',
        `
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT    NOT NULL UNIQUE,
          kind        TEXT    NOT NULL CHECK (kind IN ('backbone','consultant')),
          scope       TEXT    NOT NULL CHECK (scope IN ('global','template','project-local')),
          file_path   TEXT    NOT NULL,
          created_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          updated_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
        `,
        [
          ['id', 'NULL'], ['name', 'NULL'], ['kind', 'NULL'], ['scope', 'NULL'], ['file_path', "''"],
          ['created_at', ISO_NOW_DEFAULT], ['updated_at', ISO_NOW_DEFAULT],
        ],
      );
    }

    if (needsIsoDefault('cheatcodes')) {
      rebuildTable(
        db,
        'cheatcodes',
        `
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL UNIQUE,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
          description  TEXT    NOT NULL DEFAULT '',
          source_url   TEXT,
          file_path    TEXT,
          version      TEXT,
          trust_tier   TEXT,
          scope        TEXT    NOT NULL DEFAULT 'project-local'
                         CHECK (scope IN ('global','template','project-local')),
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          updated_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          CHECK (kind != 'skill' OR file_path IS NOT NULL),
          CHECK (origin = 'builtin' OR source_url IS NOT NULL),
          CHECK (origin != 'builtin' OR source_url IS NULL)
        `,
        [
          ['id', 'NULL'], ['name', 'NULL'], ['kind', 'NULL'], ['origin', "'external'"], ['description', "''"],
          ['source_url', 'NULL'], ['file_path', 'NULL'], ['version', 'NULL'], ['trust_tier', 'NULL'],
          ['scope', "'project-local'"], ['status', "'installed'"], ['installed_at', ISO_NOW_DEFAULT],
          ['created_at', ISO_NOW_DEFAULT], ['updated_at', ISO_NOW_DEFAULT],
        ],
      );
    }

    if (needsIsoDefault('repos')) {
      rebuildTable(
        db,
        'repos',
        `
          name               TEXT PRIMARY KEY,
          path               TEXT    NOT NULL,
          file_count         INTEGER NOT NULL DEFAULT 0,
          last_scanned_at    TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          target_branch      TEXT,
          branching_model    TEXT,
          protected_branches TEXT,
          remotes            TEXT
        `,
        [
          ['name', 'NULL'], ['path', "''"], ['file_count', '0'], ['last_scanned_at', ISO_NOW_DEFAULT],
          ['target_branch', 'NULL'], ['branching_model', 'NULL'], ['protected_branches', 'NULL'],
          ['remotes', 'NULL'],
        ],
      );
    }

    const presentTimestampColumns = TIMESTAMP_COLUMNS.filter(
      ([table, column]) => tableExists(db, table) && hasColumn(db, table, column),
    );
    for (const [table, column] of presentTimestampColumns) {
      db.exec(
        `UPDATE ${table} SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
          WHERE ${column} IS NOT NULL AND length(${column}) <> 24
            AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL`,
      );
    }
    const malformed: string[] = [];
    for (const [table, column] of presentTimestampColumns) {
      const bad = db
        .prepare(
          `SELECT DISTINCT ${column} AS v FROM ${table}
            WHERE ${column} IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NULL LIMIT 5`,
        )
        .all() as Array<{ v: unknown }>;
      if (bad.length > 0) {
        malformed.push(`${table}.${column} = ${bad.map((r) => JSON.stringify(r.v)).join(', ')}`);
      }
    }
    if (malformed.length > 0) {
      throw new Error(
        `migrateV29toV30: timestamps that cannot be parsed into YYYY-MM-DDTHH:MM:SS.sssZ — fix them, then reopen: ${malformed.join('; ')}`,
      );
    }

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV29toV30: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v30 rebuilds`,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// v30→v31: agent_runs drops tokens_total and usage_baseline_json. Tokens are
// attributed by time window and recomputed absolutely, so no baseline is
// stored, and the total is computed (in + out + cache_read + cache_creation)
// rather than kept as a column that excluded cache.
//
// Same rebuild discipline as v30: foreign_keys OFF, one transaction,
// foreign_key_check before COMMIT. Guarded on the old shape, so a re-run
// against a v31 shape is a no-op.
function migrateV30toV31(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    if (
      tableExists(db, 'agent_runs') &&
      (hasColumn(db, 'agent_runs', 'tokens_total') || hasColumn(db, 'agent_runs', 'usage_baseline_json'))
    ) {
      rebuildTable(
        db,
        'agent_runs',
        `
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id               INTEGER REFERENCES tasks(id),
          issue_id              INTEGER REFERENCES issues(id),
          agent_type            TEXT    NOT NULL,
          tokens_in             INTEGER,
          tokens_out            INTEGER,
          cache_read_tokens     INTEGER,
          cache_creation_tokens INTEGER,
          tool_uses             INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          started_at            TEXT,
          completed_at          TEXT,
          repo                  TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          spawn_id              TEXT,
          session_id            TEXT,
          usage_source          TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured'))
        `,
        [
          ['id', 'NULL'], ['task_id', 'NULL'], ['issue_id', 'NULL'], ['agent_type', "''"],
          ['tokens_in', 'NULL'], ['tokens_out', 'NULL'], ['cache_read_tokens', 'NULL'],
          ['cache_creation_tokens', 'NULL'], ['tool_uses', '0'], ['duration_ms', '0'], ['started_at', 'NULL'],
          ['completed_at', 'NULL'], ['repo', 'NULL'], ['spawn_id', 'NULL'], ['session_id', 'NULL'],
          ['usage_source', 'NULL'],
        ],
      );
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;
      `);
    }

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV30toV31: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v31 rebuild`,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// The MCP server this plugin bundles; its parent plugin row carries the
// plugin's own name (resolvePluginName), not the server's.
const OWN_MCP_SERVER_NAME = 'trajectory-server';

// v31→v32: cheatcodes is keyed by (name, kind). A plugin and the MCP server it
// bundles share a name (`linear` plugin → `linear` server); UNIQUE(name) made
// scan.sh's insert of the server fail on every scan, and before the hook writes
// were transactional each failure still committed a scan_discovered audit row.
//
//   1. Rebuild cheatcodes with UNIQUE (name, kind) instead of UNIQUE on name.
//      Every CHECK is kept; cheatcode_attachments references cheatcodes(id),
//      which the rebuild preserves.
//   2. Bundled-server rows recorded as 'mcp:<server>' become
//      'mcp:<plugin>/<server>' when the parent plugin row is known: a plugin
//      row of the same name, or, for this plugin's own server, the plugin row
//      named after this plugin.
//   3. Delete scan_discovered audit rows whose content_json (name, kind) has no
//      cheatcodes row. The audit_ad trigger removes their audit_fts entries;
//      their audit_embeddings rows are deleted here because foreign keys are
//      OFF during the rebuild, so the ON DELETE CASCADE does not fire. One
//      scan_discovered_repair audit row records the count.
//   4. mcp rows with an 'mcp:' source_url wrongly marked broken go back to
//      installed; the cheatcode health-check re-derives their status.
//
// Guarded on the old shape for the rebuild; steps 2–4 are no-ops on a re-run.
function migrateV31toV32(db: DatabaseSync): void {
  if (!tableExists(db, 'cheatcodes')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    if (!/UNIQUE\s*\(\s*name\s*,\s*kind\s*\)/.test(readTableSql(db, 'cheatcodes'))) {
      rebuildTable(
        db,
        'cheatcodes',
        `
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
          description  TEXT    NOT NULL DEFAULT '',
          source_url   TEXT,
          file_path    TEXT,
          version      TEXT,
          trust_tier   TEXT,
          scope        TEXT    NOT NULL DEFAULT 'project-local'
                         CHECK (scope IN ('global','template','project-local')),
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          updated_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          CHECK (kind != 'skill' OR file_path IS NOT NULL),
          CHECK (origin = 'builtin' OR source_url IS NOT NULL),
          CHECK (origin != 'builtin' OR source_url IS NULL),
          UNIQUE (name, kind)
        `,
        [
          ['id', 'NULL'], ['name', 'NULL'], ['kind', 'NULL'], ['origin', "'external'"], ['description', "''"],
          ['source_url', 'NULL'], ['file_path', 'NULL'], ['version', 'NULL'], ['trust_tier', 'NULL'],
          ['scope', "'project-local'"], ['status', "'installed'"], ['installed_at', ISO_NOW_DEFAULT],
          ['created_at', ISO_NOW_DEFAULT], ['updated_at', ISO_NOW_DEFAULT],
        ],
      );
    }

    const pluginRow = db.prepare("SELECT 1 FROM cheatcodes WHERE kind = 'plugin' AND name = ? LIMIT 1");
    const ownPlugin = resolvePluginName();
    const legacyServers = db
      .prepare("SELECT id, name FROM cheatcodes WHERE kind = 'mcp' AND source_url = 'mcp:' || name")
      .all() as Array<{ id: number; name: string }>;
    for (const server of legacyServers) {
      let parent: string | null = null;
      if (pluginRow.get(server.name) !== undefined) {
        parent = server.name;
      } else if (server.name === OWN_MCP_SERVER_NAME && pluginRow.get(ownPlugin) !== undefined) {
        parent = ownPlugin;
      }
      if (parent === null) continue;
      db.prepare('UPDATE cheatcodes SET source_url = ? WHERE id = ?').run(`mcp:${parent}/${server.name}`, server.id);
    }

    let phantoms = 0;
    if (tableExists(db, 'audit')) {
      const phantomIds = db
        .prepare(
          `SELECT a.id FROM audit a
            WHERE a.event_type = 'scan_discovered'
              AND json_valid(a.content_json)
              AND NOT EXISTS (
                SELECT 1 FROM cheatcodes c
                 WHERE c.name = json_extract(a.content_json, '$.name')
                   AND c.kind = json_extract(a.content_json, '$.kind'))`,
        )
        .all() as Array<{ id: number }>;
      phantoms = phantomIds.length;
      if (phantoms > 0) {
        const ids = JSON.stringify(phantomIds.map((r) => r.id));
        if (tableExists(db, 'audit_embeddings')) {
          db.prepare(
            // LINT-ALLOW: v31→v32 removes the embeddings of phantom scan_discovered audit rows (GH 1200).
            'DELETE FROM audit_embeddings WHERE audit_id IN (SELECT value FROM json_each(?))',
          ).run(ids);
        }
        // LINT-ALLOW: v31→v32 deletes phantom scan_discovered audit rows (GH 1200).
        db.prepare('DELETE FROM audit WHERE id IN (SELECT value FROM json_each(?))').run(ids);
        db.prepare(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
           SELECT -1, NULL, 'system', 'scan_discovered_repair', ?, ?, (SELECT repo FROM issues WHERE id = -1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE EXISTS (SELECT 1 FROM issues WHERE id = -1)`,
        ).run(
          `deleted ${phantoms} phantom scan_discovered audit row(s)`,
          JSON.stringify({ deleted: phantoms }),
        );
      }
    }

    db.exec(`
      UPDATE cheatcodes
         SET status = 'installed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE kind = 'mcp' AND source_url LIKE 'mcp:%' AND status = 'broken'
    `);

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV31toV32: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v32 rebuild`,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// v32→v33: run audit columns (GH 1249) and the GH 1212 lifecycle data repair.
//
//   1. Rebuild agent_runs with root_dir, model, host (CHECK claude|codex) and
//      exit_reason (CHECK completed|failed|escalated|swept_orphan|swept_stale|
//      issue_closed); usage_source also admits 'backfill'.
//   2. Backfill: host = 'claude' on every existing row. A closed row's
//      exit_reason comes from what closed it where that is derivable:
//      swept_orphan for an unmeasured row, else the task status (closed or
//      completed → completed, failed, escalated); otherwise NULL.
//   3. Repair: a task still pending/running/needs_validation/completed whose
//      issue is already closed becomes escalated, with one
//      task_escalated_repair audit row (from_node system) each; its open
//      agent_runs rows close with exit_reason issue_closed.
//
// The rebuild is guarded on the old shape; steps 2–3 are no-ops on a re-run.
function migrateV32toV33(db: DatabaseSync): void {
  if (!tableExists(db, 'agent_runs')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'agent_runs', 'exit_reason') || !/'backfill'/.test(readTableSql(db, 'agent_runs'))) {
      rebuildTable(
        db,
        'agent_runs',
        `
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id               INTEGER REFERENCES tasks(id),
          issue_id              INTEGER REFERENCES issues(id),
          agent_type            TEXT    NOT NULL,
          tokens_in             INTEGER,
          tokens_out            INTEGER,
          cache_read_tokens     INTEGER,
          cache_creation_tokens INTEGER,
          tool_uses             INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          started_at            TEXT,
          completed_at          TEXT,
          repo                  TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          spawn_id              TEXT,
          session_id            TEXT,
          usage_source          TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured','backfill')),
          root_dir              TEXT,
          model                 TEXT,
          host                  TEXT CHECK (host IN ('claude','codex')),
          exit_reason           TEXT CHECK (exit_reason IN ('completed','failed','escalated','swept_orphan','swept_stale','issue_closed'))
        `,
        [
          ['id', 'NULL'], ['task_id', 'NULL'], ['issue_id', 'NULL'], ['agent_type', "''"],
          ['tokens_in', 'NULL'], ['tokens_out', 'NULL'], ['cache_read_tokens', 'NULL'],
          ['cache_creation_tokens', 'NULL'], ['tool_uses', '0'], ['duration_ms', '0'], ['started_at', 'NULL'],
          ['completed_at', 'NULL'], ['repo', 'NULL'], ['spawn_id', 'NULL'], ['session_id', 'NULL'],
          ['usage_source', 'NULL'], ['root_dir', 'NULL'], ['model', 'NULL'], ['host', 'NULL'], ['exit_reason', 'NULL'],
        ],
      );
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;
      `);
    }

    db.exec("UPDATE agent_runs SET host = 'claude' WHERE host IS NULL");
    if (tableExists(db, 'tasks')) db.exec(`
      UPDATE agent_runs
         SET exit_reason = CASE
               WHEN usage_source = 'unmeasured' THEN 'swept_orphan'
               ELSE (SELECT CASE t.status
                              WHEN 'closed' THEN 'completed'
                              WHEN 'completed' THEN 'completed'
                              WHEN 'failed' THEN 'failed'
                              WHEN 'escalated' THEN 'escalated'
                            END
                       FROM tasks t WHERE t.id = agent_runs.task_id)
             END
       WHERE completed_at IS NOT NULL AND exit_reason IS NULL
    `);

    if (tableExists(db, 'tasks') && tableExists(db, 'issues')) {
      const leaked = db
        .prepare(
          `SELECT t.id, t.issue_id, t.branch_id, t.status FROM tasks t JOIN issues i ON i.id = t.issue_id
            WHERE i.status = 'closed' AND t.status IN ('pending','running','needs_validation','completed')
            ORDER BY t.id`,
        )
        .all() as Array<{ id: number; issue_id: number; branch_id: string; status: string }>;
      const insertRepairAudit = tableExists(db, 'audit')
        ? db.prepare(
            `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
             VALUES (?, ?, 'system', 'task_escalated_repair', ?, ?, (SELECT repo FROM issues WHERE id = ?), ${ISO_NOW_SQL})`,
          )
        : null;
      const escalate = db.prepare(
        `UPDATE tasks SET status = 'escalated', completed_at = NULL, updated_at = ${ISO_NOW_SQL} WHERE id = ?`,
      );
      const closeRuns = db.prepare(
        `UPDATE agent_runs
            SET completed_at = ${ISO_NOW_SQL},
                duration_ms = CASE WHEN duration_ms = 0
                                   THEN COALESCE(MAX(0, CAST(ROUND((julianday('now') - julianday(started_at)) * 86400000) AS INTEGER)), 0)
                                   ELSE duration_ms END,
                exit_reason = 'issue_closed'
          WHERE task_id = ? AND completed_at IS NULL`,
      );
      for (const task of leaked) {
        insertRepairAudit?.run(
          task.issue_id,
          task.branch_id,
          `task ${task.id} escalated: its issue ${task.issue_id} is closed (was ${task.status})`,
          JSON.stringify({ task_id: task.id, issue_id: task.issue_id, from_status: task.status }),
          task.issue_id,
        );
        escalate.run(task.id);
        closeRuns.run(task.id);
      }
    }

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV32toV33: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v33 rebuild`,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// v33→v34: agents.file_path names the root its prompt file ships from (GH 1267).
//
//   1. A file_path without a root marker gains one from the legacy scope:
//      global/template → 'plugin:', project-local → 'project:'. A row that
//      already carries 'plugin:' or 'project:' keeps its path.
//   2. Rebuild agents without the scope column; file_path gains
//      CHECK (file_path LIKE 'plugin:%' OR file_path LIKE 'project:%').
//
// Guarded on the old shape; a re-run against a v34 shape is a no-op.
function migrateV33toV34(db: DatabaseSync): void {
  if (!tableExists(db, 'agents')) return;
  if (!hasColumn(db, 'agents', 'scope') && /file_path\s+LIKE\s+'plugin:%'/.test(readTableSql(db, 'agents'))) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const root = hasColumn(db, 'agents', 'scope')
      ? "CASE WHEN scope = 'project-local' THEN 'project:' ELSE 'plugin:' END"
      : "'plugin:'";
    db.exec(`
      UPDATE agents
         SET file_path = ${root} || file_path
       WHERE file_path NOT LIKE 'plugin:%' AND file_path NOT LIKE 'project:%'
    `);
    rebuildTable(
      db,
      'agents',
      `
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL UNIQUE,
        kind        TEXT    NOT NULL CHECK (kind IN ('backbone','consultant')),
        file_path   TEXT    NOT NULL CHECK (file_path LIKE 'plugin:%' OR file_path LIKE 'project:%'),
        created_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
        updated_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
      `,
      [
        ['id', 'NULL'], ['name', 'NULL'], ['kind', 'NULL'], ['file_path', "''"],
        ['created_at', ISO_NOW_DEFAULT], ['updated_at', ISO_NOW_DEFAULT],
      ],
    );

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV33toV34: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v34 rebuild`,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// v34→v35: a repo's remotes become rows (GH 1225); audit.branch_id '' → NULL (GH 1221).
//
//   1. repo_remotes(repo → repos ON DELETE/UPDATE CASCADE, name, provider,
//      url, is_primary, created_at, PK(repo, name)) is created and filled from
//      each JSON value of the repos remotes column — an array of {name, provider, url} or a
//      name → url map. provider comes from the URL host; `origin` (else the
//      first remote) is primary. A value that does not parse, or entries that
//      carry no url, leave one repo_remotes_migration_skipped audit row with
//      the raw value on the system issue -1; the migration goes on.
//   2. repos is rebuilt without the remotes column.
//   3. validation_attempts gains reviewer_agent_id (GH 1226 writes it).
//   4. audit.branch_id '' becomes NULL, the one "no branch" value.
//
// Guarded on the old shape; a re-run against a v35 shape is a no-op.
function migrateV34toV35(db: DatabaseSync): void {
  if (!tableExists(db, 'repos')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repo_remotes (
        repo        TEXT    NOT NULL REFERENCES repos(name) ON DELETE CASCADE ON UPDATE CASCADE,
        name        TEXT    NOT NULL,
        provider    TEXT    NOT NULL CHECK (provider IN ('github','gitlab','other')),
        url         TEXT    NOT NULL,
        is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
        created_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
        PRIMARY KEY (repo, name)
      );
      CREATE INDEX IF NOT EXISTS idx_repo_remotes_primary ON repo_remotes(repo, is_primary);
    `);

    if (hasColumn(db, 'repos', 'remotes')) {
      const rows = db
        .prepare(`SELECT name, remotes AS legacy FROM repos WHERE remotes IS NOT NULL AND trim(remotes) <> '' ORDER BY name`)
        .all() as Array<{ name: string; legacy: string }>;
      const insertRemote = db.prepare(
        `INSERT OR IGNORE INTO repo_remotes (repo, name, provider, url, is_primary) VALUES (?, ?, ?, ?, ?)`,
      );
      const canAudit = tableExists(db, 'audit') && tableExists(db, 'issues');
      const skipped = (repo: string, raw: string, reason: string): void => {
        if (!canAudit) return;
        db.exec(
          `INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
           VALUES (-1, 'system', 'parent issue for recovery / system-level audit and discussion events', 'open', ${ISO_NOW_SQL}, ${ISO_NOW_SQL})`,
        );
        db.prepare(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
           VALUES (-1, NULL, 'system', 'repo_remotes_migration_skipped', ?, ?, ?, ${ISO_NOW_SQL})`,
        ).run(`v35 migration skipped remotes of repo ${repo}: ${reason}`, JSON.stringify({ repo, reason, raw }), repo);
      };
      for (const row of rows) {
        const parsed = parseLegacyRemotes(row.legacy);
        if (!parsed.ok) {
          skipped(row.name, row.legacy, parsed.reason);
          continue;
        }
        const primary = primaryIndex(parsed.entries);
        parsed.entries.forEach((r, i) => {
          insertRemote.run(row.name, r.name, remoteProvider(r.url, r.provider), r.url, i === primary ? 1 : 0);
        });
        if (parsed.dropped > 0) {
          skipped(row.name, row.legacy, `${parsed.dropped} remote entr${parsed.dropped === 1 ? 'y' : 'ies'} without a url or with a duplicate name`);
        }
      }

      rebuildTable(
        db,
        'repos',
        `
          name               TEXT PRIMARY KEY,
          path               TEXT    NOT NULL,
          file_count         INTEGER NOT NULL DEFAULT 0,
          last_scanned_at    TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          target_branch      TEXT,
          branching_model    TEXT,
          protected_branches TEXT
        `,
        [
          ['name', 'NULL'], ['path', "''"], ['file_count', '0'], ['last_scanned_at', ISO_NOW_DEFAULT],
          ['target_branch', 'NULL'], ['branching_model', 'NULL'], ['protected_branches', 'NULL'],
        ],
      );
    }

    if (tableExists(db, 'validation_attempts') && !hasColumn(db, 'validation_attempts', 'reviewer_agent_id')) {
      db.exec('ALTER TABLE validation_attempts ADD COLUMN reviewer_agent_id TEXT');
    }

    if (tableExists(db, 'audit')) {
      db.exec(`UPDATE audit SET branch_id = NULL WHERE branch_id = ''`);
    }

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV34toV35: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v35 rebuild`,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// v35→v36: verification runs are recorded (GH 1294). Adds
// verification_runs(task → tasks ON DELETE CASCADE, commit_sha, source
// gate|manual, started_at, finished_at, exit_code, budget_s, timed_out,
// created_at) with an index on (task_id, commit_sha, finished_at), and
// verification_run_commands(run → verification_runs ON DELETE CASCADE,
// ordinal, command, exit_code, elapsed_s, output_tail, PK(run_id, ordinal)).
// New tables only; no existing row changes. A re-run is a no-op.
function migrateV35toV36(db: DatabaseSync): void {
  if (!tableExists(db, 'tasks')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_runs (
      id           INTEGER PRIMARY KEY,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      commit_sha   TEXT    NOT NULL,
      source       TEXT    NOT NULL CHECK (source IN ('gate','manual')),
      started_at   TEXT    NOT NULL,
      finished_at  TEXT,
      exit_code    INTEGER,
      budget_s     INTEGER NOT NULL,
      timed_out    INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0,1)),
      created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
    );
    CREATE INDEX IF NOT EXISTS idx_verification_runs_task_commit
      ON verification_runs(task_id, commit_sha, finished_at);
    CREATE TABLE IF NOT EXISTS verification_run_commands (
      run_id       INTEGER NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
      ordinal      INTEGER NOT NULL,
      command      TEXT    NOT NULL,
      exit_code    INTEGER,
      elapsed_s    REAL,
      output_tail  TEXT,
      PRIMARY KEY (run_id, ordinal)
    );
  `);
}

// v36→v37: typed effort (GH 1349). tasks.effort (low|medium|high, NOT NULL
// DEFAULT 'medium') is the effort swe runs the task at; agent_runs.effort
// (nullable) records the effort a run was spawned at. Existing task rows take
// 'medium'; existing runs stay NULL. A re-run is a no-op.
function migrateV36toV37(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'tasks') && !hasColumn(db, 'tasks', 'effort')) {
      db.exec("ALTER TABLE tasks ADD COLUMN effort TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low','medium','high'))");
    }
    if (tableExists(db, 'agent_runs') && !hasColumn(db, 'agent_runs', 'effort')) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN effort TEXT CHECK (effort IN ('low','medium','high'))");
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

// v37→v38: legacy audit event types (GH 1464). v1.0.x let audit_append write any
// event_type; the closed AUDIT_EVENT_TYPES set (GH 1216) left such rows failing
// the event_type_documented contract. Every audit row outside the set becomes
// 'legacy_event'; its content_json keeps the original content (non-JSON content
// is wrapped as {"legacy_content": ...}) and gains legacy_event_type, the old
// type. The audit_au trigger keeps audit_fts consistent. A re-run touches nothing.
function migrateV37toV38(db: DatabaseSync): void {
  if (!tableExists(db, 'audit')) return;
  const documented = AUDIT_EVENT_TYPES.map((e) => e.type);
  const placeholders = documented.map(() => '?').join(', ');
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE audit
          SET content_json = json_set(
                CASE WHEN json_valid(content_json) THEN content_json ELSE json_object('legacy_content', content_json) END,
                '$.legacy_event_type', event_type),
              event_type = 'legacy_event'
        WHERE event_type NOT IN (${placeholders})`,
    ).run(...documented);
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

// v38→v39: legacy duplicate verification waivers (GH 1492). Before the
// swe-verification-gate hook became the one writer (one row per task and commit),
// swe wrote verification_gate_waived rows itself, with no commit_sha and
// sometimes twice. For each task, the lowest-id such row stays; every later one
// becomes 'legacy_event' with the same remap as v38 (legacy_event_type keeps the
// old type), so the audit log stays append-only. A re-run touches nothing.
function migrateV38toV39(db: DatabaseSync): void {
  if (!tableExists(db, 'audit')) return;
  const legacyWaiver = (alias: string): string =>
    `${alias}.event_type = 'verification_gate_waived' AND ${alias}.from_node = 'swe'
          AND (CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.commit_sha') END) IS NULL`;
  const taskId = (alias: string): string =>
    `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.task_id') END`;
  db.exec('BEGIN');
  try {
    db.exec(
      `UPDATE audit
          SET content_json = json_set(
                CASE WHEN json_valid(content_json) THEN content_json ELSE json_object('legacy_content', content_json) END,
                '$.legacy_event_type', event_type),
              event_type = 'legacy_event'
        WHERE ${legacyWaiver('audit')}
          AND EXISTS (SELECT 1 FROM audit k
                       WHERE ${legacyWaiver('k')}
                         AND ${taskId('k')} IS ${taskId('audit')}
                         AND k.id < audit.id)`,
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

// v39→v40: repos.onboard_scan (GH 1575), the JSON evidence + recommendation the
// /onboard pre-scan writes on every onboard_state_get. NULL until the first call.
function migrateV39toV40(db: DatabaseSync): void {
  if (!tableExists(db, 'repos') || hasColumn(db, 'repos', 'onboard_scan')) return;
  db.exec('ALTER TABLE repos ADD COLUMN onboard_scan TEXT');
}

// v22→v23: the repos-centric schema (#155). repos(name) becomes the FK hub.
//
//   1. repos gains a remotes column so issue-scoped sync resolves the per-repo
//      remote. Populated by scan_run (#979) from each repo's git remotes.
//   2. milestones(name, repo→repos, state, PK(name,repo)) — GitHub-style
//      per-repo milestones; backfilled from distinct issues.milestone values.
//   3. repo FK on all work tables. issues + tasks are rebuilt (issues gains the
//      composite issues.milestone→milestones FK which ALTER cannot add; tasks
//      formalizes its existing plain `repo` column into a declared FK).
//      audit / validation_attempts / discussions / agent_runs take a plain
//      `ALTER ... ADD COLUMN repo REFERENCES repos(name)` — SQLite allows a
//      nullable FK column via ADD COLUMN, and it leaves the FTS5/embeddings
//      companions of discussions+audit untouched (the rowid mapping is stable),
//      so no FTS teardown is needed for those two.
//   4. Backfill repo on every table from its parent (tasks/pr_review_runs are
//      already populated where applicable; discussions/audit/agent_runs/
//      validation_attempts inherit from their parent issue/task).
//
// Single-repo installs resolve the "sole repo" — when exactly one repos row
// exists, every NULL repo backfills to it. Multi-repo installs with ambiguous
// parentage leave repo NULL (FK-exempt) rather than guess. foreign_keys is
// toggled OFF around the table rebuilds (it cannot change inside a transaction)
// and foreign_key_check re-validates before COMMIT.
function migrateV22toV23(db: DatabaseSync): void {
  // Resolve the sole repo name for single-repo backfill, when exactly one
  // repos row exists. Multi-repo → undefined (leave NULLs; no guessing).
  const soleRepo = (): string | null => {
    if (!tableExists(db, 'repos')) return null;
    const rows = db.prepare('SELECT name FROM repos').all() as Array<{ name: string }>;
    return rows.length === 1 ? rows[0]!.name : null;
  };

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    // (1) the repos remotes column — the per-repo remote list. scan_run populates
    // it from each repo's actual git remotes (#979); migrateV26toV27 drains any
    // residual global plugin_config('remotes') before that key is removed.
    if (tableExists(db, 'repos')) {
      if (!hasColumn(db, 'repos', 'remotes')) {
        db.exec('ALTER TABLE repos ADD COLUMN remotes TEXT');
      }
    }

    const sole = soleRepo();

    // (2) milestones table. Created before the issues rebuild re-applies the
    // composite milestone FK so the backfilled values resolve.
    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
          name   TEXT NOT NULL,
          repo   TEXT NOT NULL REFERENCES repos(name) ON DELETE RESTRICT,
          state  TEXT NOT NULL DEFAULT 'open',
          PRIMARY KEY (name, repo)
      )
    `);

    // (4a) Backfill issues.repo BEFORE the rebuild so the milestone backfill and
    // the composite FK both see resolved repos. Single-repo only — leave
    // multi-repo NULLs untouched.
    if (tableExists(db, 'issues') && hasColumn(db, 'issues', 'milestone')) {
      const issuesHasRepo = hasColumn(db, 'issues', 'repo');
      if (!issuesHasRepo) {
        db.exec('ALTER TABLE issues ADD COLUMN repo TEXT');
      }
      if (sole !== null) {
        // Don't backfill the synthetic system issue (id = -1) — it belongs to no
        // repo. Real issues adopt the sole repo.
        db.prepare('UPDATE issues SET repo = ? WHERE repo IS NULL AND id <> -1').run(sole);
      }

      // (2b) milestones backfill from distinct (milestone, repo) pairs on issues.
      db.exec(`
        INSERT OR IGNORE INTO milestones (name, repo, state)
        SELECT DISTINCT milestone, repo, 'open'
          FROM issues
         WHERE milestone IS NOT NULL AND repo IS NOT NULL
      `);

      // (3a/5) Rebuild issues to declare repo FK + the composite milestone FK
      // that ALTER cannot add. Column order mirrors schema.sql.
      // LINT-ALLOW: scratch table for the SQLite FK-formalize rebuild (#155).
      db.exec('DROP TABLE IF EXISTS issues_new');
      db.exec(`
        CREATE TABLE issues_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            objective         TEXT    NOT NULL,
            description       TEXT    NOT NULL DEFAULT '',
            status            TEXT    NOT NULL DEFAULT 'open',
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL,
            closed_at         TEXT,
            remote_iid        INTEGER,
            remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab')),
            gh_iid            INTEGER,
            gl_iid            INTEGER,
            repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
            milestone         TEXT,
            FOREIGN KEY (milestone, repo) REFERENCES milestones(name, repo) ON DELETE RESTRICT
        )
      `);
      // Older upgrade fixtures (seeded at v9–v17) carry leaner issues shapes
      // that may omit columns added pre-v22 (closed_at, gh_iid, …). Build each
      // SELECT term defensively so the rebuild works regardless of starting
      // shape, mirroring migrateV1toV2/migrateV2toV3.
      const issueCol = (name: string, expr = name): string =>
        hasColumn(db, 'issues', name) ? expr : `NULL AS ${name}`;
      db.exec(`
        INSERT INTO issues_new
          (id, objective, description, status, created_at, updated_at, closed_at,
           remote_iid, remote_kind, gh_iid, gl_iid, repo, milestone)
        SELECT
           id, objective, description, status, created_at, updated_at,
           ${issueCol('closed_at')},
           ${issueCol('remote_iid')}, ${issueCol('remote_kind')},
           ${issueCol('gh_iid')}, ${issueCol('gl_iid')},
           repo, milestone
          FROM issues
      `);
      // LINT-ALLOW: FK-formalize rebuild — rows already copied into issues_new (#155).
      db.exec('DROP TABLE issues');
      db.exec('ALTER TABLE issues_new RENAME TO issues');
    }

    // (3b/5) Rebuild tasks to formalize the existing plain `repo` column into a
    // declared FK. Preserves every column including the Typed Rails files/
    // verification and prompt_bearing. The tasks(issue_id) FK + the unique
    // (issue_id, branch_id) index are recreated.
    if (tableExists(db, 'tasks') && hasColumn(db, 'tasks', 'repo')) {
      // LINT-ALLOW: scratch table for the SQLite FK-formalize rebuild (#155).
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
            repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
            prompt_bearing    INTEGER NOT NULL DEFAULT 0,
            files             TEXT    NOT NULL DEFAULT '[]',
            verification      TEXT    NOT NULL DEFAULT '[]',
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL,
            completed_at      TEXT
        )
      `);
      // Defensive SELECT terms for leaner fixtures (see the issues rebuild).
      const taskCol = (name: string, fallback: string): string =>
        hasColumn(db, 'tasks', name) ? name : `${fallback} AS ${name}`;
      db.exec(`
        INSERT INTO tasks_new
          (id, issue_id, branch_id, parent_branch_id, title, description, status,
           attempts, spec_body, commit_sha, repo, prompt_bearing, files,
           verification, created_at, updated_at, completed_at)
        SELECT
           id, issue_id, branch_id,
           ${taskCol('parent_branch_id', 'NULL')},
           ${taskCol('title', "''")},
           description, status, attempts,
           ${taskCol('spec_body', "''")},
           ${taskCol('commit_sha', 'NULL')},
           repo,
           ${taskCol('prompt_bearing', '0')},
           ${taskCol('files', "'[]'")},
           ${taskCol('verification', "'[]'")},
           created_at, updated_at,
           ${taskCol('completed_at', 'NULL')}
          FROM tasks
      `);
      // LINT-ALLOW: FK-formalize rebuild — rows already copied into tasks_new (#155).
      db.exec('DROP TABLE tasks');
      db.exec('ALTER TABLE tasks_new RENAME TO tasks');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)',
      );
    }

    // (3c/4b) discussions / audit / agent_runs / validation_attempts: nullable
    // FK column via ADD COLUMN, then backfill repo from the parent. ADD COLUMN
    // with a REFERENCES clause is allowed by SQLite for a nullable column with no
    // default — and leaves the FTS5/embeddings companions of discussions+audit
    // intact, so no teardown is needed.
    if (tableExists(db, 'discussions') && !hasColumn(db, 'discussions', 'repo')) {
      db.exec('ALTER TABLE discussions ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT');
      if (tableExists(db, 'issues')) {
        db.exec(`
          UPDATE discussions
             SET repo = (SELECT i.repo FROM issues i WHERE i.id = discussions.issue_id)
           WHERE repo IS NULL
        `);
      }
    }
    if (tableExists(db, 'audit') && !hasColumn(db, 'audit', 'repo')) {
      db.exec('ALTER TABLE audit ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT');
      if (tableExists(db, 'issues')) {
        db.exec(`
          UPDATE audit
             SET repo = (SELECT i.repo FROM issues i WHERE i.id = audit.issue_id)
           WHERE repo IS NULL
        `);
      }
    }
    if (tableExists(db, 'agent_runs') && !hasColumn(db, 'agent_runs', 'repo')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT');
      // Prefer the task's repo; fall back to the issue's repo.
      if (tableExists(db, 'tasks')) {
        db.exec(`
          UPDATE agent_runs
             SET repo = (SELECT t.repo FROM tasks t WHERE t.id = agent_runs.task_id)
           WHERE repo IS NULL AND task_id IS NOT NULL
        `);
      }
      if (tableExists(db, 'issues')) {
        db.exec(`
          UPDATE agent_runs
             SET repo = (SELECT i.repo FROM issues i WHERE i.id = agent_runs.issue_id)
           WHERE repo IS NULL AND issue_id IS NOT NULL
        `);
      }
    }
    if (tableExists(db, 'validation_attempts') && !hasColumn(db, 'validation_attempts', 'repo')) {
      db.exec('ALTER TABLE validation_attempts ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT');
      if (tableExists(db, 'tasks')) {
        db.exec(`
          UPDATE validation_attempts
             SET repo = (SELECT t.repo FROM tasks t WHERE t.id = validation_attempts.task_id)
           WHERE repo IS NULL
        `);
      }
    }

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV22toV23: foreign_key_check found ${violations.length} dangling reference(s) after the repos-centric migration`,
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

// v23→v24: cheatcode registry data-integrity (#150) + origin provenance (#152).
//
//   (#150) Delete the rows the scan-ingest leaked. scripts/scan.sh used to
//     line-split human-formatted `claude plugin list` stdout, inserting header
//     words (Installed/Version/Scope/Status/Location), the ❯ glyph, and
//     tokenized fragments as fake cheatcodes rows (all source_url='scan_discovered').
//     A real plugin/mcp name matches ^[A-Za-z0-9._-]+$; anything else under
//     'scan_discovered' is garbage and is deleted. The known header words pass
//     the charset gate, so they are denylisted explicitly.
//   (#152) origin becomes a provenance enum builtin|marketplace|external (was
//     builtin|installed). The cheatcodes table is rebuilt with the new CHECK and
//     every non-builtin row's origin is backfilled: typescript-lsp /
//     mcp-server-dev / plugin-dev → marketplace; superpowers → external; any
//     other acquired row is classified by its source_url shape (a <name>@<mkt>
//     ref or a ./marketplace-relative path → marketplace, else external).
//
// Idempotent: a DB already at the new shape (origin CHECK admits 'marketplace')
// skips the rebuild; the garbage delete is a no-op once the rows are gone.
function migrateV23toV24(db: DatabaseSync): void {
  if (!tableExists(db, 'cheatcodes')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    // (#150) Drop the scan-ingest garbage before the rebuild copies rows over.
    // Charset gate + header-word denylist. Builtins (origin='builtin') are never
    // 'scan_discovered', so this only touches leaked acquired rows.
    db.exec(`
      -- LINT-ALLOW: v23→v24 WHERE-scoped cleanup of leaked scan-ingest rows (#150).
      DELETE FROM cheatcodes
       WHERE source_url = 'scan_discovered'
         AND (
           name GLOB '*[^A-Za-z0-9._-]*'
           OR name IN ('Installed','Version','Scope','Status','Location','Name','Source','Enabled')
         )
    `);

    // (#152) Rebuild cheatcodes with the provenance enum CHECK. SQLite cannot
    // ALTER a CHECK, so copy through a scratch table, mapping origin in the SELECT.
    // LINT-ALLOW: scratch table for the SQLite CHECK-rebuild swap (#152).
    db.exec('DROP TABLE IF EXISTS cheatcodes_new');
    db.exec(`
      CREATE TABLE cheatcodes_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL UNIQUE,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
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
          CHECK (origin = 'builtin' OR source_url IS NOT NULL),
          CHECK (origin != 'builtin' OR source_url IS NULL)
      )
    `);
    db.exec(`
      INSERT INTO cheatcodes_new
        (id, name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
      SELECT
        id, name, kind,
        CASE
          WHEN origin = 'builtin' THEN 'builtin'
          WHEN name IN ('typescript-lsp','mcp-server-dev','plugin-dev') THEN 'marketplace'
          WHEN name = 'superpowers' THEN 'external'
          WHEN source_url LIKE '%@%' AND source_url NOT LIKE '%://%' AND source_url NOT LIKE '%@%:%' THEN 'marketplace'
          WHEN source_url LIKE './%' THEN 'marketplace'
          ELSE 'external'
        END,
        description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at
      FROM cheatcodes
    `);
    // LINT-ALLOW: CHECK-rebuild swap — rows already copied (#152).
    db.exec('DROP TABLE cheatcodes');
    db.exec('ALTER TABLE cheatcodes_new RENAME TO cheatcodes');

    const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `migrateV23toV24: foreign_key_check found ${violations.length} dangling reference(s) after the cheatcodes rebuild`,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// v24→v25: split the dual-responsibility tmb_push-triage builtin skill into two
// single-responsibility rows — tmb_push-gate (push-gate orchestration) and
// tmb_comment-triage (PR/MR comment triage) (#161). They load on different
// events, so the SKILL.md was split; the builtin seed follows. Idempotent: the
// DELETE is a no-op once the old row is gone and INSERT OR IGNORE skips rows
// already present. Mirrors migrateV19toV20's seed-correction shape.
function migrateV24toV25(db: DatabaseSync): void {
  if (!tableExists(db, 'cheatcodes')) {
    return;
  }
  db.exec('BEGIN');
  try {
    // LINT-ALLOW: v24→v25 removes the split tmb_push-triage builtin row, replaced by two rows below (#161).
    db.exec("DELETE FROM cheatcodes WHERE name = 'tmb_push-triage' AND origin = 'builtin'");
    db.exec(`
      INSERT OR IGNORE INTO cheatcodes
        (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
      VALUES
        ('tmb_push-gate', 'skill', 'builtin',
         'Bro''s push-gate orchestration — reaping unsigned commits, spawning pr-reviewer per task, and the all-pass push + PR-create + post-merge cleanup path. Loaded by bro when the push hook blocks or the Human asks for review-before-push.',
         NULL, 'skills/tmb_push-gate/SKILL.md', NULL, 'curated', 'global', 'active',
         datetime('now'), datetime('now'), datetime('now')),
        ('tmb_comment-triage', 'skill', 'builtin',
         'Bro''s PR/MR comment triage — resolve the PR, fetch the comment threads, judge which are task-worthy, and dispatch SWE per ratified group. Loaded by bro when /monitor surfaces PR/MR comments.',
         NULL, 'skills/tmb_comment-triage/SKILL.md', NULL, 'curated', 'global', 'active',
         datetime('now'), datetime('now'), datetime('now'))
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV24toV25: foreign_key_check found ${violations.length} dangling reference(s) after the push-triage skill split`,
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

// v25→v26: typed pr-reviewer verdict (#157). Replace the magic-string
// 'MCP available: yes/no' feedback prefix with a typed mcp_available column.
// SQLite cannot ALTER-DROP the old feedback CHECK, so REBUILD validation_attempts:
// create a scratch table with the identical columns minus the CHECK plus
// mcp_available, copy rows backfilling availability from the old prefix, swap.
function migrateV25toV26(db: DatabaseSync): void {
  if (!tableExists(db, 'validation_attempts')) return;
  if (hasColumn(db, 'validation_attempts', 'mcp_available')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    // LINT-ALLOW: scratch table for the SQLite CHECK-rebuild swap (#157).
    db.exec('DROP TABLE IF EXISTS validation_attempts_new');
    db.exec(`
      CREATE TABLE validation_attempts_new (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id             INTEGER NOT NULL REFERENCES tasks(id),
          attempt_n           INTEGER NOT NULL,
          agent               TEXT    NOT NULL DEFAULT '',
          verdict             TEXT    NOT NULL,
          feedback            TEXT    NOT NULL DEFAULT '',
          mcp_available       INTEGER NOT NULL DEFAULT 1,
          subagent_session_id TEXT,
          repo                TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          created_at          TEXT    NOT NULL,
          UNIQUE(task_id, attempt_n)
      )
    `);
    db.exec(`
      INSERT INTO validation_attempts_new
        (id, task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, repo, created_at)
      SELECT
        id, task_id, attempt_n, agent, verdict, feedback,
        CASE WHEN feedback LIKE 'MCP available: no%' THEN 0 ELSE 1 END,
        subagent_session_id, repo, created_at
      FROM validation_attempts
    `);
    // LINT-ALLOW: CHECK-rebuild swap — rows already copied (#157).
    db.exec('DROP TABLE validation_attempts');
    db.exec('ALTER TABLE validation_attempts_new RENAME TO validation_attempts');

    const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `migrateV25toV26: foreign_key_check found ${violations.length} dangling reference(s) after the validation_attempts rebuild`,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// v26 -> v27: the repos table becomes the SOLE source of truth for the four
// repo-scoped keys (target_branch/pr_target, branching_model,
// protected_branches, remotes); they are removed from plugin_config (#980).
// Before deleting the keys, drain each one into any repos row whose column is
// still NULL so existing single-repo installs keep working state across the
// upgrade. issue_sync, onboarded, and the label taxonomies stay in plugin_config.
function migrateV26toV27(db: DatabaseSync): void {
  if (!tableExists(db, 'plugin_config')) return;

  db.exec('BEGIN');
  try {
    if (tableExists(db, 'repos')) {
      const scalarFromConfig = (key: string): string | null => {
        const row = db
          .prepare('SELECT value_json FROM plugin_config WHERE key = ?')
          .get(key) as { value_json: string } | undefined;
        if (!row?.value_json) return null;
        try {
          const v = JSON.parse(row.value_json) as unknown;
          return typeof v === 'string' && v.length > 0 ? v : null;
        } catch {
          return null;
        }
      };
      const rawFromConfig = (key: string): string | null => {
        const row = db
          .prepare('SELECT value_json FROM plugin_config WHERE key = ?')
          .get(key) as { value_json: string } | undefined;
        return row?.value_json ?? null;
      };

      const prTarget = scalarFromConfig('pr_target');
      const branchingModel = scalarFromConfig('branching_model');
      const protectedBranches = rawFromConfig('protected_branches');
      const remotes = rawFromConfig('remotes');

      if (hasColumn(db, 'repos', 'target_branch') && prTarget !== null) {
        db.prepare('UPDATE repos SET target_branch = ? WHERE target_branch IS NULL').run(prTarget);
      }
      if (hasColumn(db, 'repos', 'branching_model') && branchingModel !== null) {
        db.prepare('UPDATE repos SET branching_model = ? WHERE branching_model IS NULL').run(
          branchingModel,
        );
      }
      if (hasColumn(db, 'repos', 'protected_branches') && protectedBranches !== null) {
        db.prepare('UPDATE repos SET protected_branches = ? WHERE protected_branches IS NULL').run(
          protectedBranches,
        );
      }
      if (hasColumn(db, 'repos', 'remotes') && remotes !== null) {
        db.prepare('UPDATE repos SET remotes = ? WHERE remotes IS NULL').run(remotes);
      }
    }

    // v27 drains repo-scoped policy keys from plugin_config into the repos table;
    // deleting the now-migrated global keys is the intended migration step (#980).
    db.prepare(
      // LINT-ALLOW: v27 migration intentionally removes the drained global policy keys (#980).
      "DELETE FROM plugin_config WHERE key IN ('pr_target', 'branching_model', 'protected_branches', 'remotes')",
    ).run();

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // original error wins
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
