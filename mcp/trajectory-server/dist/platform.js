import { existsSync, readFileSync, realpathSync, statSync, } from 'node:fs';
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
    const override = env['TRAJECTORY_DB_PATH'];
    if (override && override.trim().length > 0)
        return override;
    const pluginName = resolveClaudePluginName(env);
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
    const trajectoryDb = resolveClaudeDbPath({ env, cwd, home });
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
 * canonicalizes them with realpath, and rejects existing symlink ancestors
 * that would move derived project state outside the trusted project root.
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
    for (const [label, path] of Object.entries(paths)) {
        if (path !== null) {
            assertPathContained(projectRoot, path, `Codex ${label}`);
            assertExistingAncestorContained(projectRoot, path, `Codex ${label}`);
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
 * a graph accidentally.
 */
export function resolveGraphDbPath(trajectoryDbPath) {
    if (trajectoryDbPath === ':memory:')
        return ':memory:';
    const dbName = basename(trajectoryDbPath);
    const graphName = dbName === 'trajectory.db'
        ? 'world-model.kuzu'
        : `${dbName}.world-model.kuzu`;
    return join(dirname(trajectoryDbPath), graphName);
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
    let ancestor = path;
    while (!existsSync(ancestor)) {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
            throw new Error(`${label} has no existing ancestor`);
        }
        ancestor = parent;
    }
    const canonicalAncestor = realpathSync(ancestor);
    assertPathContained(root, canonicalAncestor, label);
}
function freezePlugin(plugin) {
    return Object.freeze(plugin);
}
function freezePaths(paths) {
    return Object.freeze(paths);
}
//# sourceMappingURL=platform.js.map