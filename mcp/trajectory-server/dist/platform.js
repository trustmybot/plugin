import { existsSync, lstatSync, readFileSync, realpathSync, statSync, } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep, } from 'node:path';
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
 * Preserve the shipped Claude DB rules exactly: explicit override, bounded
 * upward discovery, then invocation-cwd fallback.
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
    const found = findExistingClaudeDbUp(cwd, pluginName, { home });
    if (found)
        return found;
    return join(cwd, '.claude', pluginName, 'trajectory.db');
}
export function resolveClaudeLogDir(opts) {
    const env = opts?.env ?? process.env;
    const home = opts?.home ?? homedir();
    return join(home, '.claude', resolveClaudePluginName(env), 'logs');
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
        graphDb: resolveGraphDbPath(trajectoryDb),
        logDir: join(home, '.claude', plugin.name, 'logs'),
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
        graphDb: resolveGraphDbPath(trajectoryDb),
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
    const projectRoot = canonicalDirectory(input.projectRoot, 'Codex projectRoot');
    const pluginRoot = canonicalDirectory(input.pluginRoot, 'Codex pluginRoot');
    const paths = deriveCodexRuntimePaths({
        projectRoot,
        pluginName: input.pluginName,
    });
    const writablePaths = {
        ...paths,
        serverLog: join(paths.logDir, 'mcp-server.log'),
        sqlLog: join(paths.logDir, 'sql.log'),
    };
    for (const [label, path] of Object.entries(writablePaths)) {
        if (path !== null) {
            assertSafeProjectWritePath(projectRoot, path, `Codex ${label}`);
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
 * Keep each SQLite file paired with exactly one graph directory.
 *
 * The standard trajectory.db retains its historical sibling name. Custom DB
 * names include their basename so two overrides in one directory cannot share
 * a graph accidentally. Graph-shaped DB filenames are reserved so one
 * runtime's graph output cannot also be another runtime's SQLite input.
 */
export function resolveGraphDbPath(trajectoryDbPath) {
    if (trajectoryDbPath === ':memory:')
        return ':memory:';
    const dbName = basename(trajectoryDbPath);
    const normalizedDbName = dbName.toLowerCase();
    if (normalizedDbName === 'world-model.kuzu' ||
        normalizedDbName.endsWith('.world-model.kuzu')) {
        throw new Error(`Trajectory DB filename "${dbName}" is reserved for graph storage`);
    }
    const graphName = dbName === 'trajectory.db'
        ? 'world-model.kuzu'
        : `${dbName}.world-model.kuzu`;
    return join(dirname(trajectoryDbPath), graphName);
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
export function assertSafeProjectWritePath(projectRoot, path, label = 'Codex writable path') {
    if (!isAbsolute(projectRoot)) {
        throw new Error(`${label} project root must be an absolute path`);
    }
    if (!isAbsolute(path)) {
        throw new Error(`${label} must be an absolute path`);
    }
    let rootStat;
    try {
        rootStat = lstatSync(projectRoot);
    }
    catch {
        throw new Error(`${label} project root must remain an existing directory`);
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error(`${label} project root must remain a real directory`);
    }
    const canonicalRoot = realpathSync(projectRoot);
    if (canonicalRoot !== projectRoot) {
        throw new Error(`${label} project root changed after canonicalization`);
    }
    assertPathContained(canonicalRoot, path, label);
    assertExistingAncestorContained(canonicalRoot, path, label);
}
function findExistingClaudeDbUp(startDir, pluginName, opts) {
    const home = opts?.home ?? homedir();
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
        if (dir === home && startDir !== home)
            return null;
        const candidate = join(dir, '.claude', pluginName, 'trajectory.db');
        if (existsSync(candidate))
            return candidate;
        if (existsSync(join(dir, '.git')))
            break;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
function canonicalDirectory(path, label) {
    if (!isAbsolute(path)) {
        throw new Error(`${label} must be an absolute path`);
    }
    let stat;
    try {
        stat = statSync(path);
    }
    catch {
        throw new Error(`${label} must be an existing directory: ${path}`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`${label} must be an existing directory: ${path}`);
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
    throw new Error(`${label} escapes the trusted project root`);
}
function assertExistingAncestorContained(root, path, label) {
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
            throw new Error(`${label} contains a symbolic link in writable state`);
        }
        if (index < parts.length - 1 && !currentStat.isDirectory()) {
            throw new Error(`${label} has a non-directory ancestor`);
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