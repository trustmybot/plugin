/**
 * One sqlite3 invocation as the shell hook libs make it (GH 1692): through
 * node:sqlite when this Node ships it unflagged, else through the sqlite3 CLI
 * with the exact args the .sh passes. The node path reproduces what the CLI
 * prints in list mode (`|`-separated, no header), its exit codes (arg mode: the
 * primary error code of the first failure; stdin mode: 1 on any error) and the
 * first stderr line of a stdin-mode error, so callers read either path alike.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { noteSpawn, spawnLimit, spawnOptions } from './deadline.js';
const KILLED_CODE = 124;
const NOT_FOUND_CODE = 127;
const MAX_BUFFER = 64 * 1024 * 1024;
let nodeSqlite;
function isSqliteExperimentalWarning(warning, rest) {
    const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
    const opt = rest[0];
    const type = typeof opt === 'string'
        ? opt
        : opt !== null && typeof opt === 'object' && typeof opt.type === 'string'
            ? opt.type
            : warning instanceof Error
                ? warning.name
                : '';
    return type === 'ExperimentalWarning' && /sqlite/i.test(message);
}
/**
 * node:sqlite through process.getBuiltinModule (no flag needed, no throw on a
 * Node that lacks it), with only its ExperimentalWarning suppressed while it
 * loads. Null when this Node has no usable node:sqlite (setReturnArrays is
 * needed to read duplicate column names as the CLI prints them).
 */
export function loadNodeSqlite() {
    if (nodeSqlite !== undefined)
        return nodeSqlite;
    const original = process.emitWarning;
    process.emitWarning = function filtered(warning, ...rest) {
        if (isSqliteExperimentalWarning(warning, rest))
            return;
        return original.call(process, warning, ...rest);
    };
    try {
        const get = process.getBuiltinModule;
        const mod = typeof get === 'function' ? get.call(process, 'node:sqlite') : undefined;
        nodeSqlite =
            mod && typeof mod.DatabaseSync === 'function' && typeof mod.StatementSync?.prototype?.setReturnArrays === 'function'
                ? mod
                : null;
    }
    catch {
        nodeSqlite = null;
    }
    finally {
        process.emitWarning = original;
    }
    return nodeSqlite;
}
/** `cli` when TMB_HOOKS_SQLITE=cli or this Node has no usable node:sqlite. */
export function sqliteBackend(env = process.env) {
    return env.TMB_HOOKS_SQLITE === 'cli' || loadNodeSqlite() === null ? 'cli' : 'node';
}
function onPath(command, env) {
    for (const dir of (env.PATH ?? '').split(':')) {
        try {
            accessSync(`${dir === '' ? '.' : dir}/${command}`, constants.X_OK);
            return true;
        }
        catch {
            /* next dir */
        }
    }
    return false;
}
/** tmb_have_sqlite: a SQLite engine this process can read with. */
export function haveSqlite(env = process.env) {
    return sqliteBackend(env) === 'node' || onPath('sqlite3', env);
}
export function sqliteRun(call, env = process.env) {
    const sqlite = sqliteBackend(env) === 'node' ? loadNodeSqlite() : null;
    return sqlite ? runNode(sqlite, call) : runCli(call, env);
}
export function cliArgs(call) {
    const args = [];
    if (call.bail)
        args.push('-bail');
    if (call.readonly)
        args.push('-readonly');
    args.push('-cmd', `.timeout ${call.timeoutMs}`, call.target);
    if (call.sql !== undefined)
        args.push(call.sql);
    return args;
}
function runCli(call, env) {
    const limit = spawnLimit(call.killAfterMs, 'SIGKILL');
    const r = spawnSync('sqlite3', cliArgs(call), {
        env,
        input: call.sql === undefined ? (call.script ?? '') : undefined,
        stdio: [call.sql === undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        ...spawnOptions(limit),
    });
    noteSpawn(limit, r);
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';
    const errno = r.error?.code;
    if (errno === 'ENOENT')
        return { code: NOT_FOUND_CODE, stdout: '', stderr: 'sqlite3: command not found\n' };
    if (errno === 'ETIMEDOUT' || r.signal === 'SIGKILL')
        return { code: KILLED_CODE, stdout, stderr: '' };
    if (r.error)
        return { code: 1, stdout, stderr: stderr || `${r.error.message}\n` };
    return { code: r.status ?? 1, stdout, stderr };
}
const TOKEN_COLUMN = {
    semi: 0,
    ws: 1,
    other: 2,
    explain: 3,
    create: 4,
    temp: 5,
    trigger: 6,
    end: 7,
};
const COMPLETE_TRANS = [
    [1, 0, 2, 3, 4, 2, 2, 2],
    [1, 1, 2, 3, 4, 2, 2, 2],
    [1, 2, 2, 2, 2, 2, 2, 2],
    [1, 3, 3, 2, 4, 2, 2, 2],
    [1, 4, 2, 2, 2, 4, 5, 2],
    [6, 5, 5, 5, 5, 5, 5, 5],
    [6, 6, 5, 5, 5, 5, 5, 7],
    [1, 7, 5, 5, 5, 5, 5, 5],
];
function isIdChar(ch) {
    if (ch === undefined)
        return false;
    return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}
function keywordKind(word) {
    switch (word.toLowerCase()) {
        case 'create':
            return 'create';
        case 'trigger':
            return 'trigger';
        case 'temp':
        case 'temporary':
            return 'temp';
        case 'end':
            return 'end';
        case 'explain':
            return 'explain';
        default:
            return 'other';
    }
}
/** The token stream sqlite3_complete walks, plus the named parameters it holds. */
function scanSql(sql) {
    const tokens = [];
    let unterminated = false;
    let i = 0;
    while (i < sql.length) {
        const start = i;
        const ch = sql[i];
        if (ch === ';') {
            tokens.push({ kind: 'semi', start, end: ++i });
        }
        else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r') {
            tokens.push({ kind: 'ws', start, end: ++i });
        }
        else if (ch === '/' && sql[i + 1] === '*') {
            const close = sql.indexOf('*/', i + 2);
            if (close < 0) {
                unterminated = true;
                i = sql.length;
            }
            else {
                i = close + 2;
            }
            tokens.push({ kind: 'ws', start, end: i });
        }
        else if (ch === '-' && sql[i + 1] === '-') {
            const nl = sql.indexOf('\n', i);
            i = nl < 0 ? sql.length : nl;
            tokens.push({ kind: 'ws', start, end: i });
        }
        else if (ch === '[' || ch === '`' || ch === '"' || ch === "'") {
            const close = sql.indexOf(ch === '[' ? ']' : ch, i + 1);
            if (close < 0) {
                unterminated = true;
                i = sql.length;
            }
            else {
                i = close + 1;
            }
            tokens.push({ kind: 'other', start, end: i });
        }
        else if ((ch === ':' || ch === '@') && isIdChar(sql[i + 1])) {
            i += 1;
            while (isIdChar(sql[i]))
                i += 1;
            tokens.push({ kind: 'other', start, end: i, param: sql.slice(start, i) });
        }
        else if (isIdChar(ch)) {
            while (isIdChar(sql[i]))
                i += 1;
            const word = sql.slice(start, i);
            tokens.push(word.startsWith('$') && word.length > 1
                ? { kind: 'other', start, end: i, param: word }
                : { kind: keywordKind(word), start, end: i });
        }
        else {
            tokens.push({ kind: 'other', start, end: ++i });
        }
    }
    return { tokens, unterminated };
}
/** sqlite3_complete: the text ends a whole statement (triggers included). */
export function sqlComplete(sql) {
    const { tokens, unterminated } = scanSql(sql);
    if (unterminated)
        return false;
    let state = 0;
    for (const t of tokens)
        state = COMPLETE_TRANS[state][TOKEN_COLUMN[t.kind]];
    return state === 1;
}
/** The statements sqlite3_prepare's tail loop would run from <sql>, in order. */
export function splitStatements(sql) {
    const { tokens } = scanSql(sql);
    const out = [];
    let state = 0;
    let begin = 0;
    let dark = false;
    let params = new Set();
    const flush = (end) => {
        if (dark)
            out.push({ text: sql.slice(begin, end), params: [...params] });
        begin = end;
        dark = false;
        params = new Set();
    };
    for (const t of tokens) {
        const next = COMPLETE_TRANS[state][TOKEN_COLUMN[t.kind]];
        if (t.kind !== 'ws' && t.kind !== 'semi')
            dark = true;
        if (t.param)
            params.add(t.param);
        state = next;
        if (t.kind === 'semi' && next === 1)
            flush(t.end);
    }
    flush(sql.length);
    return out;
}
/** sqlite's `%!.15g`, the CLI's text for a REAL. */
export function formatReal(x) {
    if (x === 0)
        return '0.0';
    if (Number.isNaN(x))
        return '';
    if (!Number.isFinite(x))
        return x > 0 ? 'Inf' : '-Inf';
    const [mantissa, expText] = x.toExponential(14).split('e');
    const exp = Number(expText);
    const trim = (digits) => {
        if (!digits.includes('.'))
            return `${digits}.0`;
        const t = digits.replace(/0+$/, '');
        return t.endsWith('.') ? `${t}0` : t;
    };
    if (exp < -4 || exp >= 15) {
        return `${trim(mantissa)}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
    }
    return trim(x.toFixed(14 - exp));
}
function cutAtNul(text) {
    const nul = text.indexOf('\0');
    return nul < 0 ? text : text.slice(0, nul);
}
/** One value as list mode prints it. */
export function listValue(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'bigint')
        return v.toString();
    if (typeof v === 'number')
        return formatReal(v);
    if (typeof v === 'string')
        return cutAtNul(v);
    if (v instanceof Uint8Array)
        return cutAtNul(Buffer.from(v).toString('utf8'));
    return String(v);
}
function failure(e) {
    const err = e;
    const ext = err && typeof err.errcode === 'number' ? err.errcode : 1;
    return {
        code: ext & 0xff || 1,
        message: err && typeof err.message === 'string' ? err.message : String(e),
    };
}
function withCode(f) {
    return f.code > 1 ? `${f.message} (${f.code})` : f.message;
}
class Killed extends Error {
}
class ShellSession {
    db;
    deadline;
    parameters = new Map();
    busyMs;
    stdout = '';
    stderr = '';
    constructor(db, timeoutMs, killAfterMs) {
        this.db = db;
        this.busyMs = timeoutMs;
        this.deadline = killAfterMs === undefined ? Infinity : performance.now() + killAfterMs;
        this.applyTimeout(timeoutMs);
    }
    applyTimeout(ms) {
        this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(ms))}`);
    }
    checkDeadline() {
        if (performance.now() >= this.deadline)
            throw new Killed();
    }
    setTimeout(ms) {
        this.busyMs = ms;
        this.applyTimeout(ms);
    }
    beforeStatement() {
        this.checkDeadline();
        if (this.deadline !== Infinity) {
            this.applyTimeout(Math.min(this.busyMs, Math.ceil(this.deadline - performance.now())));
        }
    }
    /** Runs one statement; null on success, else where and why it failed. */
    run(stmt) {
        this.beforeStatement();
        let prepared;
        try {
            prepared = this.db.prepare(stmt.text);
        }
        catch (e) {
            this.checkDeadline();
            return { phase: 'prepare', failure: failure(e) };
        }
        try {
            prepared.setReturnArrays(true);
            prepared.setReadBigInts(true);
            const bound = {};
            for (const name of stmt.params) {
                if (this.parameters.has(name))
                    bound[name] = this.parameters.get(name) ?? null;
            }
            const rows = Object.keys(bound).length > 0 ? prepared.iterate(bound) : prepared.iterate();
            let out = '';
            for (const row of rows) {
                this.checkDeadline();
                const values = Array.isArray(row) ? row : Object.values(row);
                out += `${values.map(listValue).join('|')}\n`;
            }
            this.checkDeadline();
            this.stdout += out;
        }
        catch (e) {
            this.checkDeadline();
            return { phase: 'step', failure: failure(e) };
        }
        return null;
    }
    evalParameter(value) {
        try {
            const prepared = this.db.prepare(`SELECT ${value}`);
            prepared.setReturnArrays(true);
            prepared.setReadBigInts(true);
            const rows = prepared.all();
            if (rows.length === 1 && rows[0].length === 1)
                return rows[0][0];
        }
        catch {
            /* stored as text */
        }
        return value;
    }
    setParameter(name, value) {
        this.parameters.set(name, this.evalParameter(value));
    }
    clearParameters() {
        this.parameters.clear();
    }
}
function openSession(sqlite, call) {
    try {
        const db = new sqlite.DatabaseSync(call.target, {
            readOnly: call.readonly,
            enableDoubleQuotedStringLiterals: true,
            enableForeignKeyConstraints: false,
        });
        return new ShellSession(db, call.timeoutMs, call.killAfterMs);
    }
    catch (e) {
        return failure(e);
    }
}
function closeSession(session) {
    try {
        session.db.close();
    }
    catch {
        /* already closed */
    }
}
function runNode(sqlite, call) {
    const opened = openSession(sqlite, call);
    if (!(opened instanceof ShellSession)) {
        return {
            code: call.sql !== undefined ? opened.code : 1,
            stdout: '',
            stderr: `Error: unable to open database "${call.target}": ${opened.message}\n`,
        };
    }
    try {
        const code = call.sql !== undefined ? runArgMode(opened, call.sql) : runStdinMode(opened, call.script ?? '', !!call.bail);
        return { code, stdout: opened.stdout, stderr: opened.stderr };
    }
    catch (e) {
        if (e instanceof Killed)
            return { code: KILLED_CODE, stdout: opened.stdout, stderr: '' };
        throw e;
    }
    finally {
        closeSession(opened);
    }
}
function runArgMode(session, sql) {
    for (const stmt of splitStatements(sql)) {
        const failed = session.run(stmt);
        if (failed) {
            session.stderr += `Error: ${failed.phase === 'prepare' ? 'in prepare' : 'stepping'}, ${withCode(failed.failure)}\n`;
            return failed.failure.code;
        }
    }
    return 0;
}
const QSS_START = { wait: '', dark: false, semi: false };
function isSpace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\v' || ch === '\f' || ch === '\r';
}
/** The CLI's quickscan: string/comment state, dark text, a trailing `;`. */
function quickscan(line, prev) {
    const q = { ...prev };
    let i = 0;
    for (;;) {
        if (q.wait === '') {
            let jumped = false;
            while (i < line.length) {
                const ch = line[i++];
                if (isSpace(ch))
                    continue;
                if (ch === '-' && line[i] === '-')
                    return q;
                if (ch === ';') {
                    q.semi = true;
                    continue;
                }
                if (ch === '/' && line[i] === '*') {
                    i += 1;
                    q.wait = '*';
                    jumped = true;
                    break;
                }
                if (ch === '[' || ch === '`' || ch === "'" || ch === '"') {
                    q.wait = ch === '[' ? ']' : ch;
                    q.dark = true;
                    q.semi = false;
                    jumped = true;
                    break;
                }
                q.semi = false;
                q.dark = true;
            }
            if (!jumped)
                return q;
        }
        else {
            let jumped = false;
            while (i < line.length) {
                const ch = line[i++];
                if (ch !== q.wait)
                    continue;
                if (q.wait === '*') {
                    if (line[i] !== '/')
                        continue;
                    i += 1;
                }
                else if (q.wait !== ']' && line[i] === q.wait) {
                    i += 1;
                    continue;
                }
                q.wait = '';
                jumped = true;
                break;
            }
            if (!jumped)
                return q;
        }
    }
}
function plainWhite(q) {
    return q.wait === '' && !q.dark;
}
function semiTerminated(q) {
    return q.wait === '' && q.semi;
}
function inputLines(script) {
    if (script === '')
        return [];
    const lines = script.split('\n');
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
const BACKSLASH_ESCAPES = {
    a: '\x07',
    b: '\b',
    t: '\t',
    n: '\n',
    v: '\v',
    f: '\f',
    r: '\r',
    '"': '"',
    "'": "'",
    '\\': '\\',
};
/** The CLI's resolve_backslashes: C escapes and up to three octal digits. */
function resolveBackslashes(text) {
    return text.replace(/\\([0-7]{1,3}|.)/gs, (all, esc) => {
        if (/^[0-7]/.test(esc))
            return String.fromCharCode(parseInt(esc, 8));
        return BACKSLASH_ESCAPES[esc] ?? all;
    });
}
/**
 * The CLI's meta-command argument split: whitespace-separated words, a
 * '…' or "…" word taken whole (a double-quoted one with its backslash
 * escapes resolved), an unclosed quote running to the end of the line.
 */
function metaArgs(line) {
    const args = [];
    let i = 1;
    while (i < line.length) {
        while (i < line.length && isSpace(line[i]))
            i += 1;
        if (i >= line.length)
            break;
        const delim = line[i];
        if (delim === "'" || delim === '"') {
            i += 1;
            const start = i;
            while (i < line.length && line[i] !== delim) {
                if (line[i] === '\\' && delim === '"' && i + 1 < line.length)
                    i += 1;
                i += 1;
            }
            const word = line.slice(start, i);
            if (i < line.length)
                i += 1;
            args.push(delim === '"' ? resolveBackslashes(word) : word);
        }
        else {
            const start = i;
            while (i < line.length && !isSpace(line[i]))
                i += 1;
            args.push(line.slice(start, i));
        }
    }
    return args;
}
function integerValue(text) {
    const m = /^\s*([+-]?\d+)/.exec(text);
    return m ? Number(m[1]) : 0;
}
/** The meta commands hook scripts send; 1 (an error) for any other. */
function runMeta(session, line) {
    const args = metaArgs(line);
    const cmd = args[0] ?? '';
    if (cmd === 'timeout') {
        session.setTimeout(args.length >= 2 ? integerValue(args[1]) : 0);
        return 0;
    }
    if (cmd === 'parameter' || cmd === 'param') {
        const sub = args[1] ?? '';
        if ((sub === 'clear' || sub === 'init') && args.length === 2) {
            if (sub === 'clear')
                session.clearParameters();
            return 0;
        }
        if (sub === 'set' && args.length === 4) {
            session.setParameter(args[2], args[3]);
            return 0;
        }
    }
    session.stderr += `Error: unknown command or invalid arguments:  "${cmd}". Enter ".help" for help\n`;
    return 1;
}
function runChunk(session, sql, startLine) {
    for (const stmt of splitStatements(sql)) {
        const failed = session.run(stmt);
        if (failed) {
            const type = failed.phase === 'prepare' ? 'Parse error' : 'Runtime error';
            session.stderr += `${type} near line ${startLine}: ${withCode(failed.failure)}\n`;
            return 1;
        }
    }
    return 0;
}
function runStdinMode(session, script, bail) {
    let errors = 0;
    let qss = QSS_START;
    let sql = '';
    let startLine = 0;
    let lineNo = 0;
    for (const line of inputLines(script)) {
        if (errors > 0 && bail)
            break;
        lineNo += 1;
        qss = quickscan(line, qss);
        if (plainWhite(qss) && sql === '') {
            qss = QSS_START;
            continue;
        }
        if ((line[0] === '.' || line[0] === '#') && sql === '') {
            if (line[0] === '.')
                errors += runMeta(session, line);
            qss = QSS_START;
            continue;
        }
        if (sql === '') {
            sql = line.replace(/^[ \t\n\v\f\r]+/, '');
            startLine = lineNo;
        }
        else {
            sql += `\n${line}`;
        }
        if (sql !== '' && semiTerminated(qss) && sqlComplete(sql)) {
            errors += runChunk(session, sql, startLine);
            sql = '';
            qss = QSS_START;
        }
        else if (sql !== '' && plainWhite(qss)) {
            sql = '';
            qss = QSS_START;
        }
    }
    if (sql !== '')
        errors += runChunk(session, sql, startLine);
    return errors > 0 ? 1 : 0;
}
//# sourceMappingURL=sqlite-shell.js.map