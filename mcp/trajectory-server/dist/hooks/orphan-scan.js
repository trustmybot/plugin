/**
 * SessionStart hook (GH 1692), the port of scripts/hooks/orphan-scan.sh:
 * reports, and with TMB_ORPHAN_SCAN_CLEAN=1 cleans, what version upgrades left
 * behind for THIS project only: its stale old-layout or 0-byte trajectory DBs,
 * a duplicate trajectory-server on its live DB whose Claude Code session is
 * dead, and cache versions no installed_plugins.json entry pins. Another
 * project's DB, process or pinned cache version is never listed or touched.
 * Advisory: every failure exits 0 silently, and a 4 s internal deadline
 * (second granularity, as the .sh's `date +%s`) caps the scan.
 *
 * Divergences: the .sh exits 0 silently without jq, and skips the schema
 * comparison without the sqlite3 CLI; this gate needs neither.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, opendirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { dbLocation, dbPath, GATE_READ_ERROR, gateRead, haveSqlite, projectRoot, sqliteRo, stripTrailingNewlines } from './lib/db.js';
import { byteCompare, commandOnPath, firstLine } from './lib/host.js';
import { jqCompact, jsonStream } from './lib/jq.js';
import { jqRawText, pluginName, posixDirname, TMB_DB_FILENAME } from './lib/project-env.js';
export const GATE_NAME = 'orphan-scan';
const DEADLINE_S = 4;
const ANCESTRY_GUARD = 40;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const CC_WORD = /^(claude|claude\.exe|.*\/claude|.*\/claude\.exe|.*\/claude\/versions\/.*|.*\/claude-code\/cli\.js|.*\/claude-code\/cli\.mjs)$/s;
function signal(pid, sig) {
    if (!/^[0-9]+$/.test(pid))
        return false;
    try {
        process.kill(Number(pid), sig);
        return true;
    }
    catch {
        return false;
    }
}
export const REAL_PROCESS_OPS = {
    alive: (pid) => signal(pid, 0),
    terminate: (pid) => signal(pid, 'SIGTERM'),
};
/** bash's `[ <a> -gt/-lt <b> ]` operand: an int64 with optional blanks and sign, else null. */
export function bashInt(text) {
    const m = /^[ \t\n]*([+-]?[0-9]+)[ \t\n]*$/.exec(text);
    if (m === null)
        return null;
    const n = BigInt(m[1]);
    return n < INT64_MIN || n > INT64_MAX ? null : n;
}
/** CC's project slug: every run of non-alphanumerics a single '-', line by line as sed reads it. */
export function projectSlug(dir) {
    return stripTrailingNewlines(dir
        .split('\n')
        .map((line) => line.replace(/[^A-Za-z0-9]+/g, '-'))
        .join('\n'));
}
/** is_cc_cmd: a word of the command's first line is the Claude Code CLI. */
export function isCcCommand(command) {
    return firstLine(command)
        .split(/[ \t]+/)
        .some((word) => word !== '' && CC_WORD.test(word));
}
function capture(cmd, args, env) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.error ? '' : (r.stdout ?? '');
}
function procPpid(pid, env) {
    return stripTrailingNewlines(capture('ps', ['-o', 'ppid=', '-p', pid], env).replaceAll(' ', ''));
}
function procCmd(pid, env) {
    return stripTrailingNewlines(capture('ps', ['-o', 'command=', '-p', pid], env));
}
function aboveInit(pid) {
    const n = pid === '' ? null : bashInt(pid);
    return n !== null && n > 1n;
}
/** nearest_cc_ancestor: the first pid of <pid>'s ancestry (itself included) running Claude Code, else "". */
export function nearestCcAncestor(start, env) {
    let pid = start;
    for (let guard = 1; aboveInit(pid) && guard <= ANCESTRY_GUARD; guard += 1) {
        if (isCcCommand(procCmd(pid, env)))
            return pid;
        pid = procPpid(pid, env);
    }
    return '';
}
function chainContains(start, target, env) {
    if (target === '')
        return false;
    let pid = start;
    for (let guard = 1; aboveInit(pid) && guard <= ANCESTRY_GUARD; guard += 1) {
        if (pid === target)
            return true;
        pid = procPpid(pid, env);
    }
    return false;
}
function isTrajectoryServer(pid, env) {
    return capture('ps', ['-p', pid, '-o', 'command='], env).includes('trajectory-server');
}
function holders(liveDb, env) {
    const override = env.TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE ?? '';
    if (override !== '')
        return override.replaceAll(' ', '\n').split('\n');
    if (!commandOnPath('lsof', env))
        return [];
    const lines = stripTrailingNewlines(capture('lsof', ['-t', '--', liveDb], env)).split('\n');
    return [...new Set(lines)].sort(byteCompare);
}
function exists(path) {
    return existsSync(path);
}
function nonEmpty(path) {
    try {
        return statSync(path).size > 0;
    }
    catch {
        return false;
    }
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function isDir(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
class JqError extends Error {
}
function index(value, key) {
    if (value === null)
        return null;
    if (typeof value !== 'object' || Array.isArray(value))
        throw new JqError(key);
    const v = value[key];
    return v === undefined ? null : v;
}
function children(value) {
    if (Array.isArray(value))
        return value;
    if (value !== null && typeof value === 'object')
        return Object.values(value);
    return [];
}
/** `jq -r '.plugins // {} | to_entries[] | .value[]? | .installPath // empty'`, each value up to its first error. */
export function pinnedPaths(json) {
    let text;
    try {
        text = readFileSync(json, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    for (const doc of jsonStream(text).values) {
        try {
            let plugins = index(doc, 'plugins');
            if (plugins === null || plugins === false)
                plugins = {};
            if (typeof plugins !== 'object')
                throw new JqError('has no keys');
            for (const value of children(plugins)) {
                for (const install of children(value)) {
                    const path = index(install, 'installPath');
                    if (path !== null && path !== false)
                        out.push(...jqRawText(path).split('\n'));
                }
            }
        }
        catch (e) {
            if (!(e instanceof JqError))
                throw e;
        }
    }
    return out;
}
function globRegex(glob) {
    let re = '';
    for (const c of glob)
        re += c === '*' ? '.*' : c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${re}$`, 's');
}
/**
 * `find <root> -mindepth 3 -maxdepth 3 -type d -path '*\/<plugin>/*'`: depth-3
 * dirs in the order find visits them (readdir order, pre-order, symlinks
 * neither followed nor counted as dirs), while <within> holds.
 */
export function cacheVersionDirs(root, plugin, within) {
    const match = globRegex(`*/${plugin}/*`);
    const out = [];
    const walk = (dir, depth) => {
        let handle;
        try {
            handle = opendirSync(dir);
        }
        catch {
            return;
        }
        try {
            for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
                if (!within())
                    return;
                const path = `${dir}/${entry.name}`;
                let directory;
                try {
                    directory = lstatSync(path).isDirectory();
                }
                catch {
                    continue;
                }
                if (!directory)
                    continue;
                if (depth === 3) {
                    if (match.test(path))
                        out.push(path);
                }
                else {
                    walk(path, depth + 1);
                }
            }
        }
        finally {
            handle.closeSync();
        }
    };
    try {
        if (!lstatSync(root).isDirectory())
            return out;
    }
    catch {
        return out;
    }
    walk(root, 1);
    return out;
}
function liveDbOf(env, warn) {
    const pinned = env.TMB_ORPHAN_SCAN_PROJECT_DIR ?? '';
    if (pinned !== '') {
        return { liveDb: dbPath({ ...env, CLAUDE_PROJECT_DIR: pinned }, warn) ?? '', projectDir: pinned };
    }
    const liveDb = dbPath(env, warn) ?? '';
    let projectDir = projectRoot(env);
    if (liveDb !== '' && (env.TRAJECTORY_DB_PATH ?? '') === '')
        projectDir = posixDirname(posixDirname(posixDirname(liveDb)));
    return { liveDb, projectDir };
}
/** The orphan scan as a function of its env and process operations. */
export function orphanScanRun(env, ops, stderr) {
    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_S;
    const within = () => Math.floor(Date.now() / 1000) < deadline;
    const clean = (env.TMB_ORPHAN_SCAN_CLEAN ?? '') === '1';
    const plugin = pluginName(env);
    const scanHome = env.TMB_ORPHAN_SCAN_HOME || (env.HOME ?? '');
    const resolved = liveDbOf(env, (line) => stderr(`${line}\n`));
    const projectDir = resolved.projectDir;
    if (projectDir === '')
        return ALLOW;
    const liveDb = resolved.liveDb || dbLocation(projectDir, env);
    if (exists(liveDb) && gateRead(liveDb, 'SELECT count(*) FROM sqlite_master;', env) === GATE_READ_ERROR) {
        stderr(`orphan-scan: trajectory DB unavailable (${liveDb}) — scan continues without its schema version\n`);
    }
    const historyDir = `${scanHome}/.claude/projects/${projectSlug(projectDir)}`;
    const schemaVersion = (db) => haveSqlite(env) ? sqliteRo(db, 'SELECT schema_version FROM plugin_meta ORDER BY id DESC LIMIT 1;', env) : '';
    const liveSchema = nonEmpty(liveDb) ? schemaVersion(liveDb) : '';
    const report = [];
    const staleDbs = [];
    const considerStaleDb = (db) => {
        if (!exists(db) || db === liveDb)
            return;
        if (!nonEmpty(db)) {
            staleDbs.push(db);
            return;
        }
        const v = schemaVersion(db);
        if (v === '' || liveSchema === '')
            return;
        const a = bashInt(v);
        const b = bashInt(liveSchema);
        if (a !== null && b !== null && a < b)
            staleDbs.push(db);
    };
    considerStaleDb(`${historyDir}/${TMB_DB_FILENAME}`);
    considerStaleDb(`${historyDir}/memory/${TMB_DB_FILENAME}`);
    if (!nonEmpty(liveDb))
        considerStaleDb(dbLocation(scanHome, env));
    for (const db of staleDbs)
        report.push(`stale trajectory DB (this project): ${db}`);
    const installedJson = `${scanHome}/.claude/plugins/installed_plugins.json`;
    const cacheRoot = `${scanHome}/.claude/plugins/cache`;
    const unusedCache = [];
    if (isFile(installedJson) && isDir(cacheRoot) && within()) {
        const pinned = new Set(pinnedPaths(installedJson));
        for (const vdir of cacheVersionDirs(cacheRoot, plugin, within)) {
            if (!isDir(vdir))
                continue;
            if (!within())
                break;
            if (pinned.has(vdir))
                continue;
            unusedCache.push(vdir);
        }
    }
    for (const vdir of unusedCache)
        report.push(`unused cache version (pinned by no project): ${vdir}`);
    const ownCc = nearestCcAncestor(env.TMB_ORPHAN_SCAN_SELF_PID || String(process.pid), env);
    const staleProcs = [];
    if (nonEmpty(liveDb) && within()) {
        for (const pid of holders(liveDb, env)) {
            if (pid === '')
                continue;
            if (!isTrajectoryServer(pid, env))
                continue;
            if (chainContains(pid, ownCc, env))
                continue;
            const owner = nearestCcAncestor(pid, env);
            if (owner !== '' && ops.alive(owner))
                continue;
            staleProcs.push(pid);
        }
    }
    for (const pid of staleProcs)
        report.push(`stale duplicate trajectory-server on this project's live DB: pid ${pid}`);
    const cleaned = [];
    if (clean) {
        for (const db of staleDbs) {
            if (db === liveDb)
                continue;
            try {
                rmSync(db, { force: true });
                cleaned.push(`removed stale DB: ${db}`);
            }
            catch {
                /* rm failed */
            }
        }
        for (const vdir of unusedCache) {
            if (!vdir.startsWith(`${cacheRoot}/`))
                continue;
            try {
                rmSync(vdir, { recursive: true, force: true });
                cleaned.push(`removed unused cache version: ${vdir}`);
            }
            catch {
                /* rm failed */
            }
        }
        for (const pid of staleProcs) {
            if (ops.alive(pid) && isTrajectoryServer(pid, env) && ops.terminate(pid)) {
                cleaned.push(`terminated stale duplicate trajectory-server: pid ${pid}`);
            }
        }
    }
    if (report.length === 0)
        return ALLOW;
    const mode = clean ? 'cleanup enabled (TMB_ORPHAN_SCAN_CLEAN=1)' : 'report-only (set TMB_ORPHAN_SCAN_CLEAN=1 to clean)';
    let ctx = `=== TMB orphan scan (project-scoped) ===\nproject: ${projectDir}\nmode: ${mode}\n${report.map((l) => `${l}\n`).join('')}`;
    if (cleaned.length > 0)
        ctx += `--- cleaned ---\n${cleaned.map((l) => `${l}\n`).join('')}`;
    ctx += '========================================';
    return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })}\n`, code: 0 };
}
export const orphanScan = (_payload, env) => {
    try {
        return orphanScanRun(env, REAL_PROCESS_OPS, (text) => process.stderr.write(text));
    }
    catch {
        return ALLOW;
    }
};
//# sourceMappingURL=orphan-scan.js.map