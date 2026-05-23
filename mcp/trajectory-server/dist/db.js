import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { sqlLog } from './logger.js';
const TARGET_SCHEMA_VERSION = 8;
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
 * 2. Walk up from cwd to find an existing `.claude/<plugin>/trajectory.db`.
 *    Workspace-pattern projects keep the live DB at the workspace root above
 *    the inner repos; without this walk-up, the hook (PWD = inner repo) and
 *    the MCP server (PWD = workspace root) would resolve different DBs and
 *    bro would see false 'first contact' on every turn (#2872).
 * 3. Fallback: `<cwd>/.claude/<plugin-name>/trajectory.db` — fresh-init.
 */
export function resolveDbPath(opts) {
    const env = opts?.env ?? process.env;
    const cwd = opts?.cwd ?? process.cwd();
    const home = opts?.home ?? homedir();
    const override = env['TRAJECTORY_DB_PATH'];
    if (override && override.trim().length > 0)
        return override;
    const pluginName = resolvePluginName(env);
    const found = findExistingDbUp(cwd, pluginName, { home });
    if (found)
        return found;
    return join(cwd, '.claude', pluginName, 'trajectory.db');
}
function findExistingDbUp(startDir, pluginName, opts) {
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
        if (dir === home && startDir !== home)
            return null;
        const candidate = join(dir, '.claude', pluginName, 'trajectory.db');
        if (existsSync(candidate))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
export class TrajectoryDB {
    db;
    dbPath;
    constructor(dbPath) {
        // node:sqlite is part of Node's stdlib (>=22). Behind --experimental-sqlite
        // on 22.x, stable on 24+. The plugin's .mcp.json passes --experimental-sqlite
        // unconditionally — it's required on 22 and a no-op on 24+.
        this.dbPath = dbPath;
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec('PRAGMA busy_timeout = 5000');
        this.applySchema();
        this.syncPluginVersion();
    }
    applySchema() {
        const schemaDir = dirname(fileURLToPath(import.meta.url));
        const sql = readFileSync(join(schemaDir, 'schema.sql'), 'utf8');
        const applyEvalIfNeeded = () => {
            if (process.env['TMB_EVAL_MODE'] === '1') {
                const evalSql = readFileSync(join(schemaDir, 'schema-eval.sql'), 'utf8');
                this.db.exec(evalSql);
            }
        };
        const verifySeed = () => {
            const row = this.db
                .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
                .get();
            if (row === undefined) {
                throw new Error('TrajectoryDB: schema applied but plugin_meta has no rows — verify schema.sql seeds it.');
            }
        };
        const pluginMetaExists = this.db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_meta'")
            .get();
        if (pluginMetaExists === undefined) {
            // Fresh DB — apply schema and confirm the seed landed.
            this.db.exec(sql);
            applyEvalIfNeeded();
            verifySeed();
            return;
        }
        const versionRow = this.db
            .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
            .get();
        if (versionRow === undefined) {
            // plugin_meta table exists but is unseeded — treat as fresh; INSERT OR
            // IGNORE in schema.sql seeds it at the current TARGET_SCHEMA_VERSION.
            this.db.exec(sql);
            applyEvalIfNeeded();
            verifySeed();
            return;
        }
        const storedVersion = versionRow.schema_version;
        if (storedVersion > TARGET_SCHEMA_VERSION) {
            throw new Error(`TrajectoryDB: stored schema_version ${storedVersion} is newer than code's max ${TARGET_SCHEMA_VERSION}; downgrade not supported. Use a newer plugin version, or restore the .bak file from before the upgrade.`);
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
            return;
        }
        // storedVersion === TARGET_SCHEMA_VERSION — idempotent reapply.
        this.db.exec(sql);
        applyEvalIfNeeded();
        verifySeed();
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
                .prepare(`UPDATE plugin_meta SET plugin_version = ? WHERE id = 1`)
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
function backupDbBeforeMigration(db, dbPath, targetVersion) {
    if (!dbPath || dbPath === ':memory:')
        return;
    const dir = dirname(dbPath);
    const base = basename(dbPath);
    const prefix = `${base}.pre-v${targetVersion}.`;
    try {
        const existing = readdirSync(dir).some((f) => f.startsWith(prefix) && f.endsWith('.bak'));
        if (existing)
            return;
    }
    catch {
        // Directory not readable — fall through; copy will surface the real error.
    }
    // Flush WAL into the main DB file before copyFileSync. Without this the
    // backup captures only the main .db (pending WAL writes are excluded), so
    // a user restoring from .bak after a crashed migration would silently
    // lose any pre-migration writes that hadn't checkpointed yet.
    try {
        db.prepare('PRAGMA wal_checkpoint(FULL)').get();
    }
    catch {
        // Checkpoint can fail if another connection holds the lock. Proceed
        // with a best-effort backup rather than fail the boot.
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.pre-v${targetVersion}.${timestamp}.bak`;
    copyFileSync(dbPath, backupPath);
}
function runMigrations(db, fromVersion, toVersion) {
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
}
function hasColumn(db, table, column) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === column);
}
function tableExists(db, table) {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
    return row !== undefined;
}
function migrateV7toV8(db) {
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
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // Original error wins.
        }
        throw err;
    }
}
function migrateV6toV7(db) {
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
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // Original error wins.
        }
        throw err;
    }
}
function migrateV5toV6(db) {
    db.exec('BEGIN');
    try {
        db.exec("CREATE TABLE IF NOT EXISTS directories (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "repo TEXT NOT NULL DEFAULT '', " +
            "path TEXT NOT NULL, " +
            "parent_path TEXT, " +
            "summary TEXT, " +
            "summary_source TEXT CHECK (summary_source IN ('readme','llm','manual')) DEFAULT 'llm', " +
            "summary_updated_at TEXT, " +
            "file_count INTEGER NOT NULL DEFAULT 0, " +
            "UNIQUE(repo, path))");
        db.exec('CREATE INDEX IF NOT EXISTS idx_directories_parent ON directories(repo, parent_path)');
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS directories_fts USING fts5(summary, path, content='directories', tokenize='porter unicode61')");
        db.exec("CREATE TRIGGER IF NOT EXISTS directories_ai AFTER INSERT ON directories WHEN new.summary IS NOT NULL BEGIN INSERT INTO directories_fts(rowid, summary, path) VALUES (new.id, new.summary, new.path); END");
        db.exec("CREATE TRIGGER IF NOT EXISTS directories_ad AFTER DELETE ON directories WHEN old.summary IS NOT NULL BEGIN INSERT INTO directories_fts(directories_fts, rowid, summary, path) VALUES ('delete', old.id, old.summary, old.path); END");
        db.exec("CREATE TRIGGER IF NOT EXISTS directories_au AFTER UPDATE ON directories WHEN old.summary IS NOT NULL BEGIN INSERT INTO directories_fts(directories_fts, rowid, summary, path) VALUES ('delete', old.id, old.summary, old.path); END");
        db.exec("CREATE TRIGGER IF NOT EXISTS directories_au_new AFTER UPDATE ON directories WHEN new.summary IS NOT NULL BEGIN INSERT INTO directories_fts(rowid, summary, path) VALUES (new.id, new.summary, new.path); END");
        db.exec('CREATE TABLE IF NOT EXISTS directories_embeddings (' +
            'directory_id INTEGER PRIMARY KEY, ' +
            'embedding BLOB NOT NULL, ' +
            'model_id TEXT NOT NULL, ' +
            'embedded_at TEXT NOT NULL)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_directories_embeddings_model ON directories_embeddings(model_id)');
        db.exec('COMMIT');
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // Original error wins.
        }
        throw err;
    }
}
function migrateV4toV5(db) {
    db.exec('BEGIN');
    try {
        if (tableExists(db, 'issues')) {
            if (!hasColumn(db, 'issues', 'gh_iid')) {
                db.exec('ALTER TABLE issues ADD COLUMN gh_iid INTEGER');
            }
            if (!hasColumn(db, 'issues', 'gl_iid')) {
                db.exec('ALTER TABLE issues ADD COLUMN gl_iid INTEGER');
            }
            db.exec("UPDATE issues SET gh_iid = remote_iid WHERE remote_kind = 'github' AND remote_iid IS NOT NULL AND gh_iid IS NULL");
            db.exec("UPDATE issues SET gl_iid = remote_iid WHERE remote_kind = 'gitlab' AND remote_iid IS NOT NULL AND gl_iid IS NULL");
        }
        db.exec('COMMIT');
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // Original error wins.
        }
        throw err;
    }
}
function migrateV3toV4(db) {
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
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // Original error wins.
        }
        throw err;
    }
}
function migrateV2toV3(db) {
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
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // Original error wins.
        }
        throw err;
    }
}
function migrateV1toV2(db) {
    db.exec('BEGIN');
    try {
        // Translate the legacy onboarded marker forward before dropping its table.
        // Pre-#2876, `identity` was a single-row marker (presence == onboarded).
        // Post-#2876 the marker lives in plugin_config('onboarded': true). Without
        // this translation, an upgraded user re-fires the onboarding ceremony.
        if (tableExists(db, 'identity') && tableExists(db, 'plugin_config')) {
            const row = db
                .prepare('SELECT COUNT(*) AS n FROM identity')
                .get();
            if (row && row.n > 0) {
                db.exec("INSERT OR IGNORE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')");
            }
        }
        // LINT-ALLOW: v1->v2 migration drops zombie tables retired pre-#2886.
        db.exec('DROP TABLE IF EXISTS identity');
        // LINT-ALLOW: v1->v2 migration drops zombie tables retired pre-#2886.
        db.exec('DROP TABLE IF EXISTS regen_state');
        // LINT-ALLOW: v1->v2 migration drops zombie tables retired pre-#2886.
        db.exec('DROP TABLE IF EXISTS project_metadata');
        if (tableExists(db, 'skills') && !hasColumn(db, 'skills', 'scope')) {
            db.exec("ALTER TABLE skills ADD COLUMN scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','template','project-local'))");
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
            db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)');
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
        if (tableExists(db, 'roundtable_votes') &&
            hasColumn(db, 'roundtable_votes', 'agent')) {
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
            const cols = db.prepare('PRAGMA table_info(agent_runs)').all();
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
                db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id)');
            }
        }
        db.exec('COMMIT');
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // Original error wins.
        }
        throw err;
    }
}
//# sourceMappingURL=db.js.map