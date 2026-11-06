/**
 * `cli.js bro-sqlite-readonly` (GH 1692): bro's recovery fallback for the
 * read tools (issue_get, issue_resume, config_get and the rest) while the MCP
 * trajectory-server is down. Answers the seven read tools from the trajectory
 * DB in the MCP response shape, printed as Python's json.dumps prints it;
 * refuses every write or unknown tool before the DB is touched. The DB is
 * opened read-only and never written: a cold WAL (WAL mode, no -shm) is read
 * from a VACUUM INTO snapshot in a scratch dir removed on exit, taken through
 * an immutable URI when no -wal is beside it either.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { walCold } from '../hooks/lib/db.js';
import { posixDirname } from '../hooks/lib/project-env.js';
import { loadNodeSqlite } from '../hooks/lib/sqlite-shell.js';
import { dbNotFoundJson, digitsOr, fallbackDbPath, isFile } from './fallback-db.js';
import { pyDumps, pyLoads, pyStr } from './py-json.js';
export const SUPPORTED_READ_TOOLS = [
    'issue_resume',
    'issue_get',
    'issue_get_phase',
    'task_get',
    'task_first_actionable',
    'config_get',
    'config_list',
];
export const KNOWN_WRITE_TOOLS = [
    'issue_create',
    'issue_close',
    'issue_list',
    'task_create_batch',
    'task_update_status',
    'config_set',
    'discussion_append',
    'audit_append',
    'validation_record',
];
const SNAPSHOT_TIMEOUT_MS = 5000;
const ISSUE_SQL = 'SELECT id, objective, description, status, created_at, updated_at, closed_at, remote_kind, gh_iid, gl_iid FROM issues WHERE id = ?;';
const ISSUE_FULL_SQL = 'SELECT * FROM issues WHERE id = ?;';
const FIRST_ACTIONABLE_SQL = "SELECT * FROM tasks WHERE issue_id = ? AND status IN ('pending','failed') ORDER BY branch_id ASC LIMIT 1;";
class Exit extends Error {
    code;
    constructor(code) {
        super(`exit ${code}`);
        this.code = code;
    }
}
class ReadFailure extends Error {
}
class ToolError extends Error {
}
function refusalJson(tool) {
    return `{"error":"degraded-mode-readonly","requested":"${tool}","recovery":"MCP is dead. Kill zombie: pkill -f 'trajectory-server/dist/index.js' then restart Claude Code."}\n`;
}
function errorJson(message) {
    return `{"error":${pyDumps(message)}}\n`;
}
function uriPath(path) {
    return path.replace(/%/g, '%25').replace(/\?/g, '%3f').replace(/#/g, '%23');
}
function errorText(e) {
    return e instanceof Error ? e.message : String(e);
}
function sqlite() {
    const mod = loadNodeSqlite();
    if (!mod)
        throw new ReadFailure('node:sqlite is unavailable in this Node (needs Node 22.13+ with node:sqlite)');
    return mod;
}
function toPy(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'bigint' || typeof value === 'string')
        return value;
    if (typeof value === 'number')
        return Object.is(value, -0) ? 0 : value;
    if (value instanceof Uint8Array)
        return Buffer.from(value).toString('utf8');
    return String(value);
}
class ReadSession {
    dbPath;
    env;
    db = null;
    snapDir = '';
    readDb = '';
    constructor(dbPath, env) {
        this.dbPath = dbPath;
        this.env = env;
    }
    /** prepare_read_db: the file the queries read; throws Exit(1) when the snapshot fails. */
    prepare(io) {
        this.readDb = this.dbPath;
        if (!walCold(this.dbPath))
            return;
        const src = existsSync(`${this.dbPath}-wal`) ? this.dbPath : `file:${uriPath(this.dbPath)}?immutable=1`;
        try {
            this.snapDir = mkdtempSync(`${this.env.TMPDIR || '/tmp'}/bro-sqlite-readonly.`);
            const { DatabaseSync } = sqlite();
            const snap = `${this.snapDir}/snap.db`;
            const source = new DatabaseSync(src, { readOnly: true, timeout: SNAPSHOT_TIMEOUT_MS });
            try {
                source.prepare('VACUUM INTO ?').run(snap);
            }
            finally {
                source.close();
            }
            const copy = new DatabaseSync(snap, { timeout: SNAPSHOT_TIMEOUT_MS });
            try {
                copy.exec('PRAGMA journal_mode=DELETE;');
            }
            finally {
                copy.close();
            }
            this.readDb = snap;
        }
        catch (e) {
            io.err(`bro-sqlite-readonly: snapshot of ${this.dbPath} failed: ${errorText(e)}\n`);
            throw new Exit(1);
        }
    }
    open() {
        if (!this.db) {
            const { DatabaseSync } = sqlite();
            const timeout = digitsOr(this.env.TMB_DB_WRITE_TIMEOUT_MS || undefined, 1500);
            this.db = new DatabaseSync(this.readDb, { readOnly: true, timeout });
        }
        return this.db;
    }
    /** The rows of <sql> as the dicts Python reads from `sqlite3 -json`. */
    rows(sql, params = []) {
        try {
            const stmt = this.open().prepare(sql);
            stmt.setReadBigInts(true);
            stmt.setReturnArrays(true);
            const names = stmt.columns().map((c) => c.name);
            return stmt.all(...params).map((row) => {
                const dict = new Map();
                names.forEach((name, i) => dict.set(name, toPy(row[i])));
                return dict;
            });
        }
        catch (e) {
            throw new ReadFailure(errorText(e));
        }
    }
    close() {
        try {
            this.db?.close();
        }
        catch {
            /* already closed */
        }
        this.db = null;
        if (this.snapDir !== '')
            rmSync(this.snapDir, { recursive: true, force: true });
        this.snapDir = '';
    }
}
/** parse_json_field: str() of <field> in the JSON object <args>, null when absent, null or unreadable. */
export function parseJsonField(args, field) {
    let parsed;
    try {
        parsed = pyLoads(args);
    }
    catch {
        return null;
    }
    if (!(parsed instanceof Map))
        return null;
    const v = parsed.get(field);
    if (v === undefined || v === null)
        return null;
    return pyStr(v).replace(/\n+$/, '');
}
function rawPrefix(value) {
    return Array.from(typeof value === 'string' ? value : pyStr(value ?? null))
        .slice(0, 200)
        .join('');
}
function loadsOr(value, fallback) {
    try {
        return pyLoads(typeof value === 'string' ? value : pyStr(value ?? null));
    }
    catch {
        return fallback(rawPrefix(value));
    }
}
function runTool(tool, args, s) {
    const required = (field) => {
        const v = parseJsonField(args, field);
        if (v === null)
            throw new ToolError(`Missing required arg: ${field}`);
        return v;
    };
    const first = (rows) => rows[0] ?? null;
    switch (tool) {
        case 'issue_resume': {
            const id = required('issue_id');
            const issue = s.rows(ISSUE_SQL, [id]);
            if (issue.length === 0)
                throw new ToolError(`Not found: ${id}`);
            const task = s.rows(FIRST_ACTIONABLE_SQL, [id]);
            const result = new Map([
                ['issue', first(issue)],
                ['next_task', first(task)],
            ]);
            return { out: pyDumps(result), code: 0 };
        }
        case 'issue_get': {
            const id = required('issue_id');
            const include = parseJsonField(args, 'include_description') ?? 'false';
            const full = include === 'True' || include === 'true' || include === '1';
            const rows = s.rows(full ? ISSUE_FULL_SQL : ISSUE_SQL, [id]);
            if (rows.length === 0)
                throw new ToolError(`Not found: ${id}`);
            return { out: pyDumps(first(rows)), code: 0 };
        }
        case 'issue_get_phase': {
            const id = required('issue_id');
            const issueRows = s.rows('SELECT id, status FROM issues WHERE id = ?;', [id]);
            if (issueRows.length === 0)
                throw new ToolError(`Not found: ${id}`);
            const countRows = s.rows("SELECT COUNT(*) as tasks_total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as tasks_completed, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as tasks_failed FROM tasks WHERE issue_id = ?;", [id]);
            const counts = countRows[0] ?? new Map();
            const count = (key) => counts.get(key) ?? 0n;
            const total = count('tasks_total');
            const completed = count('tasks_completed');
            const status = issueRows[0].get('status') ?? '';
            const phase = status === 'closed'
                ? 'done'
                : Number(total) === 0
                    ? 'discussion'
                    : Number(completed) < Number(total)
                        ? 'tasks'
                        : 'blueprint';
            const result = new Map([
                ['phase', phase],
                [
                    'counts',
                    new Map([
                        ['tasks_total', total],
                        ['tasks_completed', completed],
                        ['tasks_failed', count('tasks_failed')],
                    ]),
                ],
            ]);
            return { out: pyDumps(result), code: 0 };
        }
        case 'task_get': {
            const id = required('task_id');
            const rows = s.rows('SELECT * FROM tasks WHERE id = ?;', [id]);
            if (rows.length === 0)
                throw new ToolError(`Not found: ${id}`);
            return { out: pyDumps(first(rows)), code: 0 };
        }
        case 'task_first_actionable': {
            const id = required('issue_id');
            return { out: pyDumps(first(s.rows(FIRST_ACTIONABLE_SQL, [id]))), code: 0 };
        }
        case 'config_get': {
            const key = required('key');
            const rows = s.rows('SELECT key, value_json FROM plugin_config WHERE key = ?;', [key]);
            if (rows.length === 0)
                return { out: 'null', code: 0 };
            const value = loadsOr(rows[0].get('value_json'), (raw) => new Map([
                ['error', 'stored value is not valid JSON'],
                ['raw', raw],
            ]));
            return { out: pyDumps(value), code: 0 };
        }
        case 'config_list': {
            const result = new Map();
            for (const row of s.rows('SELECT key, value_json FROM plugin_config ORDER BY key;')) {
                result.set(pyStr(row.get('key') ?? null), loadsOr(row.get('value_json'), (raw) => new Map([
                    ['error', 'not valid JSON'],
                    ['raw', raw],
                ])));
            }
            return { out: pyDumps(result), code: 0 };
        }
    }
}
function appendLog(db, tool) {
    try {
        const logDir = `${posixDirname(db)}/logs`;
        mkdirSync(logDir, { recursive: true });
        const ts = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
        appendFileSync(`${logDir}/mcp-health.log`, `{"ts":"${ts}","kind":"fallback","tool":"${tool}","agent":"bro"}\n`);
    }
    catch {
        /* best effort, as the hooks log */
    }
}
function dryRun(env, io) {
    const db = fallbackDbPath(env);
    if (!isFile(db)) {
        io.out(dbNotFoundJson(db));
        return 1;
    }
    const s = new ReadSession(db, env);
    try {
        s.prepare(io);
        let count = '-1';
        try {
            const v = s.rows('SELECT COUNT(*) FROM issues;')[0]?.values().next().value;
            if (v !== undefined && v !== null)
                count = pyStr(v);
        }
        catch {
            count = '-1';
        }
        io.out(`{"ok":true,"db_path":"${db}","issues_count":${count}}\n`);
        return 0;
    }
    finally {
        s.close();
    }
}
function isReadTool(tool) {
    return SUPPORTED_READ_TOOLS.includes(tool);
}
function main(argv, env, io) {
    const first = argv[0] ?? '';
    if (first === '--dry-run')
        return dryRun(env, io);
    if (first === '--list') {
        io.out(`${pyDumps(new Map([['supported_read_tools', [...SUPPORTED_READ_TOOLS]]]))}\n`);
        return 0;
    }
    const tool = first;
    const args = argv[1] || '{}';
    if (tool === '') {
        io.out('{"error":"usage","message":"bro-sqlite-readonly <tool_name> [json_args] | --dry-run | --list"}\n');
        return 1;
    }
    if (KNOWN_WRITE_TOOLS.includes(tool) || !isReadTool(tool)) {
        io.out(refusalJson(tool));
        return 1;
    }
    const db = fallbackDbPath(env);
    if (!isFile(db)) {
        io.out(dbNotFoundJson(db));
        return 1;
    }
    appendLog(db, tool);
    const s = new ReadSession(db, env);
    try {
        s.prepare(io);
        const { out, code } = runTool(tool, args, s);
        io.out(`${out}\n`);
        return code;
    }
    catch (e) {
        if (e instanceof ToolError) {
            io.out(errorJson(e.message));
            return 1;
        }
        if (e instanceof ReadFailure) {
            io.err(`bro-sqlite-readonly: ${tool} failed: ${e.message}\n`);
            return 1;
        }
        throw e;
    }
    finally {
        s.close();
    }
}
/** Runs the subcommand on <argv> (the arguments after its name); returns the exit code. */
export function broSqliteReadonly(argv, env, io) {
    try {
        return main(argv, env, io);
    }
    catch (e) {
        if (e instanceof Exit)
            return e.code;
        throw e;
    }
}
//# sourceMappingURL=bro-sqlite-readonly.js.map