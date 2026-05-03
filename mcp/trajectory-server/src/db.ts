import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    this.migrateLedgerIntoAudit();
    this.applySchema();
    this.migratePluginMetaDuplicates();
    this.migrateTasksRepo();
    this.migrateIssuesLabels();
    this.migrateRemotesConfig();
    this.migrateAgentRuns();
    this.migrateRoundtablesState();
    this.migrateRoundtableVotesParticipant();
    this.migrateIssuesRemoteSync();
    this.migrateIssueSyncConfig();
    this.migratePrReviewRuns();
    this.migrateValidationSubagentSessionId();
    this.migrateDiscussionsVerifiedHuman();
    this.syncPluginVersion();
  }

  private migrateLedgerIntoAudit(): void {
    const ledgerExists = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ledger'`)
      .get() as { name: string } | undefined;
    if (!ledgerExists) return;

    const auditExists = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='audit'`)
      .get() as { name: string } | undefined;

    if (auditExists) {
      const auditCols = this.db
        .prepare('PRAGMA table_info(audit)')
        .all() as Array<{ name: string }>;
      const auditColNames = new Set(auditCols.map((c) => c.name));

      if (!auditColNames.has('kind')) {
        this.db.exec(
          `ALTER TABLE audit ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool_call'`,
        );
      }
      if (!auditColNames.has('event_type')) {
        this.db.exec(`ALTER TABLE audit ADD COLUMN event_type TEXT`);
      }
      if (!auditColNames.has('summary')) {
        this.db.exec(`ALTER TABLE audit ADD COLUMN summary TEXT`);
      }
      if (!auditColNames.has('content_json')) {
        this.db.exec(
          `ALTER TABLE audit ADD COLUMN content_json TEXT NOT NULL DEFAULT '{}'`,
        );
      }
    } else {
      this.db.exec(
        `CREATE TABLE audit (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id     INTEGER NOT NULL,
          branch_id    TEXT,
          from_node    TEXT    NOT NULL DEFAULT 'executor',
          kind         TEXT    NOT NULL DEFAULT 'tool_call',
          event_type   TEXT,
          summary      TEXT,
          content_json TEXT    NOT NULL DEFAULT '{}',
          round        INTEGER NOT NULL DEFAULT 0,
          tool_name    TEXT,
          tool_args    TEXT    NOT NULL DEFAULT '{}',
          output       TEXT    NOT NULL DEFAULT '',
          output_chars INTEGER NOT NULL DEFAULT 0,
          is_truncated INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT    NOT NULL
        )`,
      );
    }

    // Provide empty string for tool_name to satisfy any NOT NULL constraint on that
    // column that may exist in older audit table schemas (pre-unification).
    this.db.exec(
      `INSERT INTO audit
         (issue_id, branch_id, from_node, kind, event_type, summary, content_json,
          tool_name, is_truncated, created_at)
       SELECT issue_id, branch_id, from_node, 'event', event_type, summary,
              COALESCE(content, '{}'), '', is_truncated, created_at
       FROM ledger`,
    );

    // LINT-ALLOW: #170 ledger→audit migration
    this.db.exec(`DROP TABLE ledger`);
  }

  private applySchema(): void {
    const schemaDir = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(schemaDir, 'schema.sql'), 'utf8');
    this.db.exec(sql);

    if (process.env['TMB_EVAL_MODE'] === '1') {
      const evalSql = readFileSync(join(schemaDir, 'schema-eval.sql'), 'utf8');
      this.db.exec(evalSql);
    }

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
    const tableExists = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='eval_results'`)
      .get() as { name: string } | undefined;
    if (!tableExists) return;

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

  private migrateTasksRepo(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(tasks)')
      .all() as Array<{ name: string }>;
    const present = new Set(cols.map((c) => c.name));
    if (!present.has('repo')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN repo TEXT`);
    }
  }

  private migrateIssuesLabels(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(issues)')
      .all() as Array<{ name: string }>;
    if (!cols.find((c) => c.name === 'labels')) {
      this.db.exec('ALTER TABLE issues ADD COLUMN labels TEXT;');
    }
  }

  private migrateRemotesConfig(): void {
    const sql =
      `INSERT OR IGNORE INTO plugin_config (key, value_json, updated_at)` +
      ` VALUES ('remotes', '[]', datetime('now'))`;
    this.db.exec(sql);
  }

  private migrateAgentRuns(): void {
    const createTable =
      'CREATE TABLE IF NOT EXISTS agent_runs (' +
      '  id           INTEGER PRIMARY KEY AUTOINCREMENT,' +
      '  task_id      INTEGER REFERENCES tasks(id),' +
      '  issue_id     INTEGER REFERENCES issues(id),' +
      '  agent_type   TEXT    NOT NULL,' +
      '  tokens_in    INTEGER NOT NULL DEFAULT 0,' +
      '  tokens_out   INTEGER NOT NULL DEFAULT 0,' +
      '  tokens_total INTEGER NOT NULL DEFAULT 0,' +
      '  tool_uses    INTEGER NOT NULL DEFAULT 0,' +
      '  duration_ms  INTEGER NOT NULL DEFAULT 0,' +
      '  started_at   TEXT,' +
      "  completed_at TEXT    NOT NULL," +
      "  exit_status  TEXT    NOT NULL DEFAULT 'completed'" +
      ')';
    this.db.exec(createTable);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id)',
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id)',
    );
  }

  private migrateRoundtablesState(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(roundtables)')
      .all() as Array<{ name: string }>;
    const present = new Set(cols.map((c) => c.name));
    if (!present.has('state')) {
      this.db.exec(
        `ALTER TABLE roundtables ADD COLUMN state TEXT NOT NULL DEFAULT 'collecting'` +
        ` CHECK (state IN ('collecting','awaiting_human','closed','skipped'))`,
      );
      this.db.exec(
        `UPDATE roundtables SET state = 'closed' WHERE status = 'closed' AND state = 'collecting'`,
      );
    }
    if (!present.has('expected_participants')) {
      this.db.exec(`ALTER TABLE roundtables ADD COLUMN expected_participants INTEGER`);
    }
    if (!present.has('ratification_received_at')) {
      this.db.exec(`ALTER TABLE roundtables ADD COLUMN ratification_received_at DATETIME`);
    }
  }

  private migrateRoundtableVotesParticipant(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(roundtable_votes)')
      .all() as Array<{ name: string }>;
    if (!cols.find((c) => c.name === 'participant')) {
      this.db.exec(`ALTER TABLE roundtable_votes ADD COLUMN participant TEXT`);
      this.db.exec(`UPDATE roundtable_votes SET participant = agent WHERE participant IS NULL`);
    }
  }

  private migrateIssuesRemoteSync(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(issues)')
      .all() as Array<{ name: string }>;
    const present = new Set(cols.map((c) => c.name));
    const additions: Array<{ name: string; type: string }> = [
      { name: 'remote_iid', type: 'INTEGER' },
      { name: 'remote_kind', type: "TEXT CHECK(remote_kind IN ('github','gitlab'))" },
      { name: 'remote_synced_at', type: 'DATETIME' },
    ];
    for (const { name, type } of additions) {
      if (!present.has(name)) {
        this.db.exec(`ALTER TABLE issues ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private migrateIssueSyncConfig(): void {
    this.db.exec(
      `INSERT OR IGNORE INTO plugin_config (key, value_json, updated_at)
       VALUES ('issue_sync', '"off"', datetime('now'))`,
    );
    this.db.exec(
      `UPDATE plugin_config SET value_json = '"off"', updated_at = datetime('now')
       WHERE key = 'issue_sync' AND value_json = '"auto"'`,
    );
  }

  private migratePrReviewRuns(): void {
    const tables = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pr_review_runs'`)
      .all() as Array<{ name: string }>;
    if (tables.length === 0) {
      this.db
        .prepare(
          `CREATE TABLE pr_review_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pr_number INTEGER NOT NULL,
            repo TEXT NOT NULL,
            remote_kind TEXT NOT NULL CHECK(remote_kind IN ('github','gitlab')),
            last_fetched_at DATETIME NOT NULL,
            last_comment_id TEXT,
            comments_processed INTEGER NOT NULL DEFAULT 0,
            tasks_created INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT (datetime('now'))
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE INDEX idx_pr_review_runs_pr ON pr_review_runs(pr_number, repo)`,
        )
        .run();
    }
  }

  private migrateValidationSubagentSessionId(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(validation_attempts)')
      .all() as Array<{ name: string }>;
    const present = new Set(cols.map((c) => c.name));
    if (!present.has('subagent_session_id')) {
      this.db.exec(`ALTER TABLE validation_attempts ADD COLUMN subagent_session_id TEXT`);
    }
  }

  private migrateDiscussionsVerifiedHuman(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(discussions)')
      .all() as Array<{ name: string }>;
    const present = new Set(cols.map((c) => c.name));
    if (!present.has('verified_human')) {
      this.db
        .prepare(`ALTER TABLE discussions ADD COLUMN verified_human INTEGER NOT NULL DEFAULT 0`)
        .run();
    }
  }

  private migratePluginMetaDuplicates(): void {
    this.transaction(() => {
      // LINT-ALLOW: dedup of singleton plugin_meta row (#89). Targets only id != 1.
      this.db.prepare('DELETE FROM plugin_meta WHERE id != 1').run();
    });
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
        .prepare(
          `UPDATE plugin_meta SET plugin_version = ?, updated_at = datetime('now') WHERE id = 1`,
        )
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
