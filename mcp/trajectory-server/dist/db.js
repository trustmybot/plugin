import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
/**
 * Resolve the trajectory DB path.
 *
 * 1. Explicit `TRAJECTORY_DB_PATH` env override wins. Power-user / CI use.
 * 2. Default: `<cwd>/.claude/tmb/trajectory.db` — project-local, per-user,
 *    auto-gitignored via the plugin-root `.gitignore` exclusion of `.claude/`.
 */
export function resolveDbPath(opts) {
    const env = opts?.env ?? process.env;
    const cwd = opts?.cwd ?? process.cwd();
    const override = env['TRAJECTORY_DB_PATH'];
    if (override && override.trim().length > 0)
        return override;
    return join(cwd, '.claude', 'tmb', 'trajectory.db');
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
    }
    applySchema() {
        const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
        const sql = readFileSync(schemaPath, 'utf8');
        this.db.exec(sql);
        const row = this.db
            .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
            .get();
        if (row === undefined) {
            throw new Error('TrajectoryDB: schema applied but plugin_meta has no rows — verify schema.sql seeds it.');
        }
    }
    run(sql, params) {
        const stmt = this.db.prepare(sql);
        const result = stmt.run(...(params ?? []));
        return {
            changes: Number(result.changes),
            lastInsertRowid: result.lastInsertRowid,
        };
    }
    get(sql, params) {
        const stmt = this.db.prepare(sql);
        return stmt.get(...(params ?? []));
    }
    all(sql, params) {
        const stmt = this.db.prepare(sql);
        return stmt.all(...(params ?? []));
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