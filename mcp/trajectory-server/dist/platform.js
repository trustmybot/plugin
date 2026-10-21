import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, isAbsolute, join, relative, sep, } from 'node:path';
export class UnsafeProjectWritePathError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnsafeProjectWritePathError';
    }
}
/**
 * Read Claude Code's plugin manifest using the same tolerant fallback rules as
 * the legacy resolver. Codex callers must not use this loader; their metadata
 * is explicit adapter input.
 */
export function readClaudePluginMetadata(env = process.env) {
    const root = env['CLAUDE_PLUGIN_ROOT'] ?? null;
    if (!root) {
        return freezePlugin({ root: null, name: 'tmb', version: null });
    }
    try {
        const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
        const name = typeof manifest.name === 'string' && manifest.name.length > 0
            ? manifest.name
            : 'tmb';
        const version = typeof manifest.version === 'string' && manifest.version.length > 0
            ? manifest.version
            : null;
        return freezePlugin({ root, name, version });
    }
    catch {
        return freezePlugin({ root, name: 'tmb', version: null });
    }
}
export function resolveClaudePluginName(env = process.env) {
    return readClaudePluginMetadata(env).name;
}
export function resolveClaudePluginVersion(env = process.env) {
    return readClaudePluginMetadata(env).version;
}
/**
 * Claude's session directory: `CLAUDE_PROJECT_DIR`, when the host sets it.
 * The DB walk starts here; the project root is the directory holding the DB
 * it resolves. Null otherwise (a bare `node dist/index.js`).
 */
export function resolveClaudeProjectRoot(env = process.env) {
    const root = env['CLAUDE_PROJECT_DIR'];
    return root && root.trim().length > 0 ? root : null;
}
/** Where the DB walk starts: `CLAUDE_PROJECT_DIR`, else `cwd`. */
export function resolveClaudeSessionDir(env = process.env, cwd = process.cwd()) {
    return resolveClaudeProjectRoot(env) ?? cwd;
}
/**
 * The trajectory DB path for Claude: the found DB (findExistingClaudeDbUp),
 * else a fresh-init path under `CLAUDE_PROJECT_DIR` (or the invocation cwd
 * when it is unset). `TRAJECTORY_DB_PATH` is returned verbatim either way.
 */
export function resolveClaudeDbPath(opts) {
    const env = opts?.env ?? process.env;
    const cwd = opts?.cwd ?? process.cwd();
    const home = opts?.home ?? homedir();
    const pluginName = resolveClaudePluginName(env);
    return resolveClaudeDbPathForPlugin(pluginName, { env, cwd, home });
}
function resolveClaudeDbPathForPlugin(pluginName, opts) {
    const { env, cwd, home } = opts;
    const override = env['TRAJECTORY_DB_PATH'];
    if (override && override.trim().length > 0)
        return override;
    const projectRoot = resolveClaudeProjectRoot(env);
    const found = findExistingClaudeDbUp(cwd, pluginName, { home, env, projectRoot });
    if (found)
        return found;
    return claudeDbLocation(projectRoot ?? cwd, pluginName);
}
/** Host state directory for Claude; Codex keeps its own (`.tmb`). */
const CLAUDE_STATE_HOST_DIR = '.claude';
function claudeDbLocation(root, pluginName) {
    return join(root, CLAUDE_STATE_HOST_DIR, pluginName, 'trajectory.db');
}
/**
 * Server logs live beside the trajectory DB, inside the project — never under
 * the user's home. An in-memory DB has no project state dir, so its logs go to
 * the OS temp dir.
 */
function claudeLogDirFor(trajectoryDb, pluginName) {
    if (trajectoryDb === ':memory:')
        return join(tmpdir(), `${pluginName}-memory-logs`);
    return join(dirname(trajectoryDb), 'logs');
}
export function resolveClaudeLogDir(opts) {
    const env = opts?.env ?? process.env;
    const cwd = opts?.cwd ?? process.cwd();
    const home = opts?.home ?? homedir();
    const pluginName = resolveClaudePluginName(env);
    return claudeLogDirFor(resolveClaudeDbPathForPlugin(pluginName, { env, cwd, home }), pluginName);
}
export function createClaudeRuntimeContext(opts) {
    const env = opts?.env ?? process.env;
    const cwd = opts?.cwd ?? process.cwd();
    const home = opts?.home ?? homedir();
    const plugin = readClaudePluginMetadata(env);
    const trajectoryDb = resolveClaudeDbPathForPlugin(plugin.name, { env, cwd, home });
    const stateDir = trajectoryDb === ':memory:' ? null : dirname(trajectoryDb);
    const paths = freezePaths({
        stateDir,
        trajectoryDb,
        logDir: claudeLogDirFor(trajectoryDb, plugin.name),
    });
    return Object.freeze({
        host: 'claude',
        cwd,
        home,
        plugin,
        paths,
    });
}
/**
 * Pure Codex path derivation. Filesystem validation and canonicalization are
 * intentionally performed by createCodexRuntimeContext instead.
 */
export function deriveCodexRuntimePaths(input) {
    if (!isAbsolute(input.projectRoot)) {
        throw new Error('Codex projectRoot must be an absolute path');
    }
    assertSafePathSegment(input.pluginName, 'Codex pluginName');
    const stateDir = join(input.projectRoot, '.tmb', input.pluginName);
    const trajectoryDb = join(stateDir, 'trajectory.db');
    return freezePaths({
        stateDir,
        trajectoryDb,
        logDir: join(stateDir, 'logs'),
    });
}
/**
 * Load a Codex runtime context from explicit adapter input.
 *
 * This function is read-only but not pure: it requires both roots to exist,
 * canonicalizes them with realpath, and rejects symlinks anywhere below the
 * canonical project root in a derived writable path. Project-root aliases are
 * resolved before this check; mutable state itself must use real directories.
 * It never reads Claude environment variables or either platform manifest.
 */
export function createCodexRuntimeContext(input) {
    assertSafePathSegment(input.pluginName, 'Codex pluginName');
    assertNonEmpty(input.pluginVersion, 'Codex pluginVersion');
    const projectRoot = canonicalDirectory(input.projectRoot, 'Codex projectRoot', UnsafeProjectWritePathError);
    const pluginRoot = canonicalDirectory(input.pluginRoot, 'Codex pluginRoot');
    const paths = deriveCodexRuntimePaths({
        projectRoot,
        pluginName: input.pluginName,
    });
    const writablePaths = [
        ['stateDir', paths.stateDir, 'directory'],
        ['trajectoryDb', paths.trajectoryDb, 'file'],
        ['logDir', paths.logDir, 'directory'],
        ['serverLog', join(paths.logDir, 'mcp-server.log'), 'file'],
        ['sqlLog', join(paths.logDir, 'sql.log'), 'file'],
    ];
    for (const [label, path, expectedKind] of writablePaths) {
        if (path !== null) {
            assertSafeProjectWritePath(projectRoot, path, `Codex ${label}`, expectedKind);
        }
    }
    const plugin = freezePlugin({
        root: pluginRoot,
        name: input.pluginName,
        version: input.pluginVersion,
    });
    return Object.freeze({
        host: 'codex',
        projectRoot,
        plugin,
        paths,
    });
}
/**
 * Revalidate a Codex write target at the point of use.
 *
 * Runtime-context creation is deliberately side-effect free, so its validation
 * cannot authorize a later filesystem write by itself. Writable consumers call
 * this immediately before opening or creating state. This closes deterministic
 * path replacement between context creation and use; it does not claim atomic
 * protection against a same-user replacement in the final syscall window.
 */
export function assertSafeProjectWritePath(projectRoot, path, label = 'Codex writable path', expectedKind = 'either') {
    if (!isAbsolute(projectRoot)) {
        throw new UnsafeProjectWritePathError(`${label} project root must be an absolute path`);
    }
    if (!isAbsolute(path)) {
        throw new UnsafeProjectWritePathError(`${label} must be an absolute path`);
    }
    let rootStat;
    try {
        rootStat = lstatSync(projectRoot);
    }
    catch {
        throw new UnsafeProjectWritePathError(`${label} project root must remain an existing directory`);
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new UnsafeProjectWritePathError(`${label} project root must remain a real directory`);
    }
    const canonicalRoot = realpathSync(projectRoot);
    if (canonicalRoot !== projectRoot) {
        throw new UnsafeProjectWritePathError(`${label} project root changed after canonicalization`);
    }
    assertPathContained(canonicalRoot, path, label);
    assertExistingAncestorContained(canonicalRoot, path, label, expectedKind);
}
/**
 * Classify a candidate DB: `current` when `tasks.prompt_bearing` exists,
 * `stale` for a legacy schema (no such column, or no tasks table), `error`
 * when the read itself fails (busy, corrupt, unreadable).
 */
export function probeClaudeDb(path) {
    let db = null;
    try {
        db = new DatabaseSync(path, { readOnly: true });
        const cols = db
            .prepare("SELECT name FROM pragma_table_info('tasks')")
            .all();
        return cols.some((c) => c.name === 'prompt_bearing') ? 'current' : 'stale';
    }
    catch {
        return 'error';
    }
    finally {
        try {
            db?.close();
        }
        catch {
            // closing a failed handle is best-effort
        }
    }
}
/** A file in a DB's state dir that makes that DB its own project (nearest one wins the walk). */
export const CLAUDE_STANDALONE_MARKER = 'standalone';
/** `<root>/.claude/<plugin>` — the state dir holding a project's trajectory DB. */
export function claudeStateDir(root, pluginName) {
    return join(root, CLAUDE_STATE_HOST_DIR, pluginName);
}
export function isStandaloneClaudeDb(dbPath) {
    return existsSync(join(dirname(dbPath), CLAUDE_STANDALONE_MARKER));
}
/**
 * Walk up from `start` to `/`, never entering `home` unless started there, no
 * `.git` stop. Every ancestor `.claude/<plugin>/trajectory.db` that is not a
 * stale schema is a candidate; a candidate whose state dir holds a
 * `standalone` marker ends the walk and wins, else the outermost wins.
 */
export function walkClaudeDbs(start, pluginName, opts) {
    const home = opts?.home ?? homedir();
    const probe = opts?.probe ?? probeClaudeDb;
    const found = [];
    for (let dir = start; dirname(dir) !== dir; dir = dirname(dir)) {
        if (dir === home && start !== home)
            break;
        const candidate = claudeDbLocation(dir, pluginName);
        if (!existsSync(candidate) || probe(candidate) === 'stale')
            continue;
        found.push(candidate);
        if (isStandaloneClaudeDb(candidate))
            break;
    }
    return { resolved: found.length === 0 ? null : found[found.length - 1], candidates: found };
}
/** `<root>` for a DB at `<root>/.claude/<plugin>/<file>`; null for `:memory:` or any other shape. */
export function claudeProjectRootOfDb(dbPath) {
    if (!dbPath || dbPath === ':memory:')
        return null;
    const hostDir = dirname(dirname(dbPath));
    return basename(hostDir) === CLAUDE_STATE_HOST_DIR ? dirname(hostDir) : null;
}
/** The physical path of an existing `path`, else `path` as given. */
export function canonicalExisting(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
/** True when `child` is `parent` or lies below it (both compared as given). */
export function isPathWithin(parent, child) {
    const rel = relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** How deep below the project root a stray DB is looked for. */
export const STRAY_DB_MAX_DEPTH = 4;
function countRows(conn, table) {
    try {
        const row = conn.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id > 0`).get();
        return row === undefined ? null : Number(row.n);
    }
    catch {
        return null;
    }
}
/**
 * Issue and task counts of a trajectory DB, read-only, leaving out the
 * schema-seeded system issue (id -1); null for a count the read could not take.
 */
export function claudeDbCounts(path) {
    let conn = null;
    try {
        conn = new DatabaseSync(path, { readOnly: true });
        return { issues: countRows(conn, 'issues'), tasks: countRows(conn, 'tasks') };
    }
    catch {
        return { issues: null, tasks: null };
    }
    finally {
        try {
            conn?.close();
        }
        catch {
            // closing a failed handle is best-effort
        }
    }
}
function claudeDbsBelow(root, pluginName, maxDepth, probe) {
    const found = [];
    let level = [root];
    for (let depth = 1; depth <= maxDepth && level.length > 0; depth += 1) {
        const next = [];
        for (const dir of level) {
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules')
                    continue;
                const child = join(dir, entry.name);
                const candidate = claudeDbLocation(child, pluginName);
                if (existsSync(candidate) && isStandaloneClaudeDb(candidate))
                    continue;
                next.push(child);
                if (existsSync(candidate) && probe(candidate) !== 'stale')
                    found.push(candidate);
            }
        }
        level = next;
    }
    return found;
}
/**
 * Every trajectory DB other than `dbPath` that a session in `sessionDir` sits
 * among: the non-stale DBs the walk-up from `sessionDir` passes (only when
 * `sessionDir` is inside the project, the walk that found `dbPath`), and the
 * DBs below the project root up to STRAY_DB_MAX_DEPTH levels, not counting a
 * `standalone` project or anything under it. Null when `dbPath` is not a project DB
 * (`<root>/.claude/<plugin>/<file>`).
 */
export function otherClaudeDbs(dbPath, opts) {
    const root = claudeProjectRootOfDb(dbPath);
    if (root === null)
        return null;
    const pluginName = basename(dirname(dbPath));
    const probe = opts.probe ?? probeClaudeDb;
    const seen = new Set([canonicalExisting(dbPath)]);
    const paths = [];
    const add = (path) => {
        const key = canonicalExisting(path);
        if (seen.has(key))
            return;
        seen.add(key);
        paths.push(path);
    };
    if (isPathWithin(canonicalExisting(root), canonicalExisting(opts.sessionDir))) {
        walkClaudeDbs(opts.sessionDir, pluginName, { home: opts.home, probe }).candidates.forEach(add);
    }
    claudeDbsBelow(root, pluginName, STRAY_DB_MAX_DEPTH, probe).forEach(add);
    return paths.map((path) => {
        const { issues, tasks } = claudeDbCounts(path);
        return { path, issues, tasks, empty: issues === 0 && tasks === 0 };
    });
}
/**
 * The one trajectory-DB location rule, shared with the hooks' `tmb_db_path`
 * (scripts/hooks/lib/query-task.sh) and documented in
 * docs/reference/TRAJECTORY_DB_LOCATION.md. Returns the existing DB, or null
 * when unresolved:
 *
 * 1. `TRAJECTORY_DB_PATH`, if set (must exist).
 * 2. Walk up from the project root (`CLAUDE_PROJECT_DIR` for Claude), else
 *    from `startDir` (walkClaudeDbs): the nearest `standalone` DB, else the
 *    outermost DB.
 * 3. Otherwise unresolved.
 *
 * Unresolved means the project is not onboarded and every hook gate allows.
 * A DB that resolves but cannot be read is an error: deny-capable gates deny.
 */
export function findExistingClaudeDbUp(startDir, pluginName, opts) {
    const env = opts?.env ?? process.env;
    const override = env['TRAJECTORY_DB_PATH'];
    if (override && override.trim().length > 0) {
        return existsSync(override) ? override : null;
    }
    const projectRoot = opts?.projectRoot !== undefined ? opts.projectRoot : resolveClaudeProjectRoot(env);
    return walkClaudeDbs(projectRoot ?? startDir, pluginName, opts).resolved;
}
function canonicalDirectory(path, label, ErrorType = Error) {
    if (!isAbsolute(path)) {
        throw new ErrorType(`${label} must be an absolute path`);
    }
    let stat;
    try {
        stat = statSync(path);
    }
    catch {
        throw new ErrorType(`${label} must be an existing directory: ${path}`);
    }
    if (!stat.isDirectory()) {
        throw new ErrorType(`${label} must be an existing directory: ${path}`);
    }
    return realpathSync(path);
}
function assertSafePathSegment(value, label) {
    if (value.length === 0 ||
        value.trim() !== value ||
        value === '.' ||
        value === '..' ||
        value.includes('/') ||
        value.includes('\\') ||
        value.includes('\0') ||
        basename(value) !== value) {
        throw new Error(`${label} must be a safe, non-empty path segment`);
    }
}
function assertNonEmpty(value, label) {
    if (value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
}
function assertPathContained(root, path, label) {
    const rel = relative(root, path);
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
        return;
    }
    throw new UnsafeProjectWritePathError(`${label} escapes the trusted project root`);
}
function assertExistingAncestorContained(root, path, label, expectedKind) {
    const rel = relative(root, path);
    const parts = rel === '' ? [] : rel.split(sep);
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
        current = join(current, parts[index]);
        let currentStat;
        try {
            currentStat = lstatSync(current);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return;
            }
            throw error;
        }
        if (currentStat.isSymbolicLink()) {
            throw new UnsafeProjectWritePathError(`${label} contains a symbolic link in writable state`);
        }
        if (index === parts.length - 1) {
            if (expectedKind === 'file' && !currentStat.isFile()) {
                throw new UnsafeProjectWritePathError(`${label} must be a regular file`);
            }
            if (expectedKind === 'directory' && !currentStat.isDirectory()) {
                throw new UnsafeProjectWritePathError(`${label} must be a directory`);
            }
            if (currentStat.isFile() && currentStat.nlink !== 1) {
                throw new UnsafeProjectWritePathError(`${label} must not be a multiply linked writable file`);
            }
        }
        if (index < parts.length - 1 && !currentStat.isDirectory()) {
            throw new UnsafeProjectWritePathError(`${label} has a non-directory ancestor`);
        }
    }
    if (parts.length > 0) {
        assertPathContained(root, realpathSync(path), label);
    }
}
function freezePlugin(plugin) {
    return Object.freeze(plugin);
}
function freezePaths(paths) {
    return Object.freeze(paths);
}
//# sourceMappingURL=platform.js.map