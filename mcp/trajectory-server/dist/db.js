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
export function resolvePluginName(env = process.env) {
    const root = env['CLAUDE_PLUGIN_ROOT'];
    if (!root)
        return 'tmb';
    try {
        const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
        if (typeof manifest.name === 'string' && manifest.name.length > 0) {
            return manifest.name;
        }
    }
    catch {
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
export function resolveDbPath(opts) {
    const env = opts?.env ?? process.env;
    const cwd = opts?.cwd ?? process.cwd();
    const override = env['TRAJECTORY_DB_PATH'];
    if (override && override.trim().length > 0)
        return override;
    const pluginName = resolvePluginName(env);
    return join(cwd, '.claude', pluginName, 'trajectory.db');
}
export class TrajectoryDB {
    db;
    constructor(dbPath) {
        // node:sqlite is part of Node's stdlib (>=22). Behind --experimental-sqlite
        // on 22.x, stable on 24+. The plugin's .mcp.json passes --experimental-sqlite
        // unconditionally — it's required on 22 and a no-op on 24+.
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec('PRAGMA busy_timeout = 5000');
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
        this.syncPluginVersion();
    }
    applySchema() {
        const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
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
            .get();
        if (row === undefined) {
            throw new Error('TrajectoryDB: schema applied but plugin_meta has no rows — verify schema.sql seeds it.');
        }
    }
    migrateEvalResultsAbColumns() {
        const cols = this.db
            .prepare('PRAGMA table_info(eval_results)')
            .all();
        const present = new Set(cols.map((c) => c.name));
        // 'arm' is NOT NULL DEFAULT 'control' on fresh installs; on existing DBs
        // we ALTER with the same default so old rows get backfilled. SQLite's
        // ALTER ADD COLUMN with a literal DEFAULT applies the default to existing
        // rows automatically.
        if (!present.has('arm')) {
            this.db.exec(`ALTER TABLE eval_results ADD COLUMN arm TEXT NOT NULL DEFAULT 'control'`);
        }
        if (!present.has('scenario')) {
            this.db.exec(`ALTER TABLE eval_results ADD COLUMN scenario TEXT`);
        }
    }
    migrateFileRegistryCodebaseMemory() {
        const cols = this.db
            .prepare('PRAGMA table_info(file_registry)')
            .all();
        const present = new Set(cols.map((c) => c.name));
        const additions = [
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
    migrateTasksRepo() {
        const cols = this.db
            .prepare('PRAGMA table_info(tasks)')
            .all();
        const present = new Set(cols.map((c) => c.name));
        if (!present.has('repo')) {
            this.db.exec(`ALTER TABLE tasks ADD COLUMN repo TEXT`);
        }
    }
    migrateIssuesLabels() {
        const cols = this.db
            .prepare('PRAGMA table_info(issues)')
            .all();
        if (!cols.find((c) => c.name === 'labels')) {
            this.db.exec('ALTER TABLE issues ADD COLUMN labels TEXT;');
        }
    }
    migrateRemotesConfig() {
        const sql = `INSERT OR IGNORE INTO plugin_config (key, value_json, updated_at)` +
            ` VALUES ('remotes', '[]', datetime('now'))`;
        this.db.exec(sql);
    }
    migrateAgentRuns() {
        const createTable = 'CREATE TABLE IF NOT EXISTS agent_runs (' +
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
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id)');
    }
    migrateRoundtablesState() {
        const cols = this.db
            .prepare('PRAGMA table_info(roundtables)')
            .all();
        const present = new Set(cols.map((c) => c.name));
        if (!present.has('state')) {
            this.db.exec(`ALTER TABLE roundtables ADD COLUMN state TEXT NOT NULL DEFAULT 'collecting'` +
                ` CHECK (state IN ('collecting','awaiting_human','closed','skipped'))`);
            this.db.exec(`UPDATE roundtables SET state = 'closed' WHERE status = 'closed' AND state = 'collecting'`);
        }
        if (!present.has('expected_participants')) {
            this.db.exec(`ALTER TABLE roundtables ADD COLUMN expected_participants INTEGER`);
        }
        if (!present.has('ratification_received_at')) {
            this.db.exec(`ALTER TABLE roundtables ADD COLUMN ratification_received_at DATETIME`);
        }
    }
    migrateRoundtableVotesParticipant() {
        const cols = this.db
            .prepare('PRAGMA table_info(roundtable_votes)')
            .all();
        if (!cols.find((c) => c.name === 'participant')) {
            this.db.exec(`ALTER TABLE roundtable_votes ADD COLUMN participant TEXT`);
            this.db.exec(`UPDATE roundtable_votes SET participant = agent WHERE participant IS NULL`);
        }
    }
    migrateIssuesRemoteSync() {
        const cols = this.db
            .prepare('PRAGMA table_info(issues)')
            .all();
        const present = new Set(cols.map((c) => c.name));
        const additions = [
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
    migrateIssueSyncConfig() {
        this.db.exec(`INSERT OR IGNORE INTO plugin_config (key, value_json, updated_at)
       VALUES ('issue_sync', '"auto"', datetime('now'))`);
    }
    migratePluginMetaDuplicates() {
        this.transaction(() => {
            // LINT-ALLOW: dedup of singleton plugin_meta row (#89). Targets only id != 1.
            this.db.prepare('DELETE FROM plugin_meta WHERE id != 1').run();
        });
    }
    syncPluginVersion(env = process.env) {
        const root = env['CLAUDE_PLUGIN_ROOT'];
        if (!root)
            return;
        try {
            const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
            if (typeof manifest.version !== 'string' || manifest.version.length === 0)
                return;
            this.db
                .prepare(`UPDATE plugin_meta SET plugin_version = ?, updated_at = datetime('now') WHERE id = 1`)
                .run(manifest.version);
        }
        catch {
            // Silent skip — leave existing value unchanged.
        }
    }
    run(sql, params) {
        const start = performance.now();
        try {
            const stmt = this.db.prepare(sql);
            const result = stmt.run(...(params ?? []));
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
        }
        catch (err) {
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
    get(sql, params) {
        const start = performance.now();
        try {
            const stmt = this.db.prepare(sql);
            const row = stmt.get(...(params ?? []));
            sqlLog({
                kind: 'get',
                sql,
                params: params ?? [],
                duration_ms: Math.round(performance.now() - start),
                row_count: row === undefined ? 0 : 1,
                ok: true,
            });
            return row;
        }
        catch (err) {
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
    all(sql, params) {
        const start = performance.now();
        try {
            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...(params ?? []));
            sqlLog({
                kind: 'all',
                sql,
                params: params ?? [],
                duration_ms: Math.round(performance.now() - start),
                row_count: rows.length,
                ok: true,
            });
            return rows;
        }
        catch (err) {
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
    transaction(fn) {
        this.db.exec('BEGIN');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (err) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                // ROLLBACK can fail if the txn was already broken; surface the
                // original error, not the rollback error.
            }
            throw err;
        }
    }
    close() {
        this.db.close();
    }
}
export function nowISO() {
    return new Date().toISOString();
}
export function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}
//# sourceMappingURL=db.js.map