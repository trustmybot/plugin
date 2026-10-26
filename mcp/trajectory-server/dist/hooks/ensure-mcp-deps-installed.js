/**
 * SessionStart gate (GH 1695), the port of scripts/hooks/ensure-mcp-deps-installed.sh:
 * makes the MCP server's external @huggingface/transformers resolve, installing
 * it once, pruned, into `$CLAUDE_PLUGIN_DATA/deps/<key>/` instead of into every
 * plugin version's cache dir, and bridging the bare import there with the
 * symlink `<plugin root>/node_modules/@huggingface/transformers` →
 * `<data>/deps/<key>/node_modules/@huggingface/transformers`, the root's own
 * key, so versions pinning different transformers never share a target (GH 1717).
 *
 * Ready (the bare specifier resolves from the MCP dir to TRANSFORMERS_VERSION)
 * → exit 0, no output. Not ready and the data dir already holds a valid
 * install for the key → the bridge, no output. Otherwise the gate takes the
 * lock `<data>/deps/.install.lock`, starts `node dist/hooks.js
 * ensure-mcp-deps-installed --install` detached and prints the .sh's notice.
 * Unset CLAUDE_PLUGIN_DATA, or win32, keeps the .sh's install into the MCP dir.
 * Bypass, unset CLAUDE_PLUGIN_ROOT, no MCP package.json → exit 0, no output.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, copyFileSync, cpSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync, } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALLOW } from './gate.js';
import { TRANSFORMERS_PACKAGE, TRANSFORMERS_VERSION, pinnedTransformersVersion, runtimeDepsKey, runtimeDepsRoot, transformersEsmEntry, transformersVersion, } from '../runtime-deps.js';
export const GATE_NAME = 'ensure-mcp-deps-installed';
export const INSTALL_FLAG = '--install';
export const LOCK_TOKEN_ENV = 'TMB_MCP_DEPS_LOCK_TOKEN';
const MCP_REL = join('mcp', 'trajectory-server');
const LOCK_STALE_DEFAULT_MIN = 15;
const RECLAIM_MUTEX_STALE_MS = 30_000;
const LOCK_OWNER = 'owner';
const STAGING_STALE_MS = 60 * 60 * 1000;
const INSTALLED_AT = '.installed-at';
const STAGING_PREFIX = '.staging-';
const LEGACY_INSTALLERS = [
    { name: 'bun', args: ['install', '--production', '--ignore-scripts', '--no-save'] },
    { name: 'npm', args: ['install', '--omit=dev', '--ignore-scripts', '--no-save', '--no-audit', '--no-fund'] },
];
const DATA_INSTALLERS = [
    { name: 'bun', args: ['install', '--frozen-lockfile', '--production', '--ignore-scripts'] },
    { name: 'npm', args: ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'] },
];
function context(env) {
    if (env.TMB_SKIP_MCP_DEPS_INSTALL === '1')
        return undefined;
    const root = env.CLAUDE_PLUGIN_ROOT;
    if (!root)
        return undefined;
    const mcpDir = join(root, MCP_REL);
    if (!isFile(join(mcpDir, 'package.json')))
        return undefined;
    const dataDir = env.CLAUDE_PLUGIN_DATA ?? '';
    const legacyReason = process.platform === 'win32'
        ? 'win32 has no symlink bridge yet'
        : dataDir === '' ? 'CLAUDE_PLUGIN_DATA is unset' : '';
    return { env, root, mcpDir, legacy: legacyReason !== '', legacyReason, dataDir };
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function isRealDir(path) {
    try {
        return lstatSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function isWithin(parent, child) {
    const rel = relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function onPath(name, env) {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir)
            continue;
        const candidate = join(dir, name);
        try {
            accessSync(candidate, constants.X_OK);
            if (statSync(candidate).isFile())
                return candidate;
        }
        catch {
            continue;
        }
    }
    return undefined;
}
function findInstaller(env, installers) {
    for (const installer of installers) {
        const path = onPath(installer.name, env);
        if (path)
            return { ...installer, path };
    }
    return undefined;
}
function commandLine(installer) {
    return [installer.name, ...installer.args].join(' ');
}
function readJson(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** The version of the package the bare specifier resolves to from the MCP dir. */
function bareSpecifierVersion(mcpDir) {
    let resolved;
    try {
        resolved = createRequire(join(mcpDir, 'package.json')).resolve(TRANSFORMERS_PACKAGE);
    }
    catch {
        return undefined;
    }
    for (let dir = dirname(resolved); dirname(dir) !== dir; dir = dirname(dir)) {
        const pkg = readJson(join(dir, 'package.json'));
        if (pkg?.['name'] === TRANSFORMERS_PACKAGE) {
            return typeof pkg['version'] === 'string' ? pkg['version'] : undefined;
        }
    }
    return undefined;
}
export function isValidInstall(dir, version = TRANSFORMERS_VERSION) {
    return isFile(join(dir, INSTALLED_AT))
        && transformersVersion(dir) === version
        && transformersEsmEntry(dir) !== undefined;
}
function depsDir(dataDir) {
    return join(dataDir, 'deps');
}
/** Points `link` at `target` through a temp symlink renamed over it. */
function swapSymlink(target, link) {
    const tmp = `${link}.tmb-${process.pid}`;
    rmSync(tmp, { force: true });
    symlinkSync(target, tmp);
    renameSync(tmp, link);
}
function pointCurrent(dataDir, key) {
    const link = join(depsDir(dataDir), 'current');
    let existing;
    try {
        existing = readlinkSync(link);
    }
    catch {
        existing = undefined;
    }
    if (existing !== key)
        swapSymlink(key, link);
}
/**
 * `<root>/node_modules/@huggingface/transformers` → the data dir's install for
 * `key`, the root's own. Created when absent; an existing symlink is re-pointed
 * (under `own-symlink` only one already into `<data>/deps`, such as one to
 * `current`); a real directory, such as a dev checkout's workspace install, is
 * never replaced.
 */
export function ensureBridge(root, dataDir, rule = 'any-symlink', key = runtimeDepsKey()) {
    const link = join(root, 'node_modules', TRANSFORMERS_PACKAGE);
    const target = join(depsDir(dataDir), key, 'node_modules', TRANSFORMERS_PACKAGE);
    let existing;
    try {
        const st = lstatSync(link);
        if (!st.isSymbolicLink())
            return false;
        existing = readlinkSync(link);
    }
    catch {
        existing = undefined;
    }
    if (existing === target)
        return true;
    if (existing !== undefined && rule === 'own-symlink'
        && !isWithin(resolve(depsDir(dataDir)), resolve(dirname(link), existing))) {
        return false;
    }
    mkdirSync(dirname(link), { recursive: true });
    swapSymlink(target, link);
    return true;
}
function staleMinutes(env) {
    const raw = env.TMB_MCP_DEPS_LOCK_STALE_MIN ?? '';
    return /^[0-9]+$/.test(raw) ? Number(raw) : LOCK_STALE_DEFAULT_MIN;
}
function ageMs(path) {
    try {
        return Date.now() - statSync(path).mtimeMs;
    }
    catch {
        return undefined;
    }
}
/** A lock that is gone, or older than `staleMin` minutes. */
function isStaleLock(lock, staleMin) {
    const age = ageMs(lock);
    return age === undefined || age > staleMin * 60_000;
}
/** Creates `lock` and writes a fresh owner token into it; undefined when the lock already exists. */
function claimLock(lock) {
    try {
        mkdirSync(lock);
    }
    catch {
        return undefined;
    }
    const token = randomUUID();
    try {
        writeFileSync(join(lock, LOCK_OWNER), token);
    }
    catch {
        rmSync(lock, { recursive: true, force: true });
        return undefined;
    }
    return token;
}
/**
 * Takes over a stale lock under the mutex `<lock>.reclaim`, as dispatch.sh's
 * reclaim() does: the holder re-checks staleness, so a lock re-created
 * meanwhile is never removed. A mutex older than 30 s is dropped for the next caller.
 */
function reclaimLock(lock, staleMin) {
    const mutex = `${lock}.reclaim`;
    try {
        mkdirSync(mutex);
    }
    catch {
        const age = ageMs(mutex);
        if (age !== undefined && age > RECLAIM_MUTEX_STALE_MS)
            rmSync(mutex, { recursive: true, force: true });
        return undefined;
    }
    try {
        if (!isStaleLock(lock, staleMin))
            return undefined;
        rmSync(lock, { recursive: true, force: true });
        return claimLock(lock);
    }
    finally {
        try {
            rmdirSync(mutex);
        }
        catch {
            // dropped as stale by another caller
        }
    }
}
/** The owner token written to `<lock>/owner`, or undefined while another caller holds a lock that is not stale. */
export function takeLock(lock, staleMin) {
    try {
        mkdirSync(dirname(lock), { recursive: true });
    }
    catch {
        return undefined;
    }
    return claimLock(lock) ?? (isStaleLock(lock, staleMin) ? reclaimLock(lock, staleMin) : undefined);
}
/** Removes `lock` only when its owner file reads exactly `token`; a lock with no owner file is never removed. */
export function releaseLock(lock, token) {
    if (!token)
        return false;
    let owner;
    try {
        owner = readFileSync(join(lock, LOCK_OWNER), 'utf8');
    }
    catch {
        return false;
    }
    if (owner !== token)
        return false;
    rmSync(lock, { recursive: true, force: true });
    return true;
}
function lockPath(ctx) {
    return ctx.legacy ? join(ctx.mcpDir, '.deps-install.lock') : join(depsDir(ctx.dataDir), '.install.lock');
}
function pluginName(root) {
    const name = readJson(join(root, '.claude-plugin', 'plugin.json'))?.['name'];
    return typeof name === 'string' && name !== '' ? name : 'tmb';
}
function probeDb(db, env) {
    if (!isFile(db))
        return 'stale';
    const sqlite = onPath('sqlite3', env);
    if (!sqlite)
        return 'current';
    const r = spawnSync(sqlite, ['-readonly', '-cmd', '.timeout 1500', db, "SELECT name FROM pragma_table_info('tasks');"], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status !== 0)
        return 'error';
    return r.stdout.includes('prompt_bearing') ? 'current' : 'stale';
}
/** The trajectory DB the way lib/query-task.sh's _tmb_db_resolve finds it. */
function resolveDb(env, root) {
    const override = env.TRAJECTORY_DB_PATH;
    if (override)
        return isFile(override) ? override : undefined;
    const name = pluginName(root);
    const location = (dir) => join(dir, '.claude', name, 'trajectory.db');
    if (env.TMB_FORBID_LIVE_SYNC === '1' || env.TMB_TEST_RUN_ID) {
        if (!env.CLAUDE_PROJECT_DIR)
            return undefined;
        const candidate = location(env.CLAUDE_PROJECT_DIR);
        return isFile(candidate) ? candidate : undefined;
    }
    const start = env.CLAUDE_PROJECT_DIR || process.cwd();
    const home = env.HOME;
    let outermost;
    for (let dir = start; dir !== '' && dirname(dir) !== dir; dir = dirname(dir)) {
        if (dir === home && start !== home)
            break;
        const candidate = location(dir);
        if (!isFile(candidate) || probeDb(candidate, env) === 'stale')
            continue;
        outermost = candidate;
        if (isFile(join(dirname(candidate), 'standalone')) || isRealDir(join(dirname(candidate), 'standalone')))
            break;
    }
    return outermost;
}
function installLog(ctx) {
    const db = resolveDb(ctx.env, ctx.root);
    if (!db)
        return { env: ctx.env };
    const state = dirname(db);
    try {
        mkdirSync(join(state, 'logs'), { recursive: true });
    }
    catch {
        return { env: ctx.env };
    }
    return {
        path: join(state, 'logs', 'mcp-deps-install.log'),
        env: {
            ...ctx.env,
            BUN_INSTALL_CACHE_DIR: ctx.env.BUN_INSTALL_CACHE_DIR || join(state, 'cache', 'bun'),
            npm_config_cache: ctx.env.npm_config_cache || join(state, 'cache', 'npm'),
        },
    };
}
function notice(message) {
    const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message } };
    return { stdout: `${JSON.stringify(out)}\n`, code: 0 };
}
function noInstallerNotice(ctx, hooksEntry) {
    const manual = ctx.legacy
        ? `cd "${ctx.mcpDir}" && ${commandLine(LEGACY_INSTALLERS[0])}`
        : `CLAUDE_PLUGIN_ROOT="${ctx.root}" CLAUDE_PLUGIN_DATA="${ctx.dataDir}" node "${hooksEntry}" ${GATE_NAME} ${INSTALL_FLAG} (it installs into ${runtimeDepsRoot(ctx.dataDir)})`;
    return notice(`📦 Semantic search is degraded: the MCP server's @huggingface/transformers is not installed and neither bun nor npm is on PATH. Install one and restart Claude Code, or run: ${manual}`);
}
function startWorker(hooksEntry, log, token) {
    const fd = log.path ? openSync(log.path, 'a') : undefined;
    const stdio = fd === undefined ? 'ignore' : ['ignore', fd, fd];
    try {
        const child = spawn(process.execPath, [hooksEntry, GATE_NAME, INSTALL_FLAG], {
            detached: true,
            stdio,
            env: { ...log.env, [LOCK_TOKEN_ENV]: token },
        });
        child.on('error', () => undefined);
        child.unref();
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function ensureDeps(env) {
    const ctx = context(env);
    if (!ctx)
        return ALLOW;
    const key = runtimeDepsKey();
    const installDir = ctx.legacy ? undefined : runtimeDepsRoot(ctx.dataDir, key);
    if (bareSpecifierVersion(ctx.mcpDir) === TRANSFORMERS_VERSION) {
        if (installDir && isValidInstall(installDir))
            ensureBridge(ctx.root, ctx.dataDir, 'own-symlink', key);
        return ALLOW;
    }
    if (installDir && isValidInstall(installDir)) {
        pointCurrent(ctx.dataDir, key);
        ensureBridge(ctx.root, ctx.dataDir, 'any-symlink', key);
        return ALLOW;
    }
    const hooksEntry = resolve(process.argv[1] ?? '');
    const installer = findInstaller(env, ctx.legacy ? LEGACY_INSTALLERS : DATA_INSTALLERS);
    if (!installer)
        return noInstallerNotice(ctx, hooksEntry);
    const lock = lockPath(ctx);
    const token = takeLock(lock, staleMinutes(env));
    if (!token)
        return ALLOW;
    const log = installLog(ctx);
    try {
        startWorker(hooksEntry, log, token);
    }
    catch {
        releaseLock(lock, token);
    }
    const logNote = log.path ? ` Log: ${log.path}` : '';
    return notice(`📦 Installing the MCP server's @huggingface/transformers in the background (${installer.name}); semantic search runs on FTS until then and embeddings go live on the next Claude Code restart.${logNote}`);
}
/** Every path exits 0, as the .sh does: a filesystem error leaves the session to start degraded. */
export const ensureMcpDepsInstalled = (_payload, env) => {
    try {
        return ensureDeps(env);
    }
    catch {
        return ALLOW;
    }
};
function stdoutLogger(message) {
    writeSync(1, `[${new Date().toISOString()}] ${GATE_NAME}: ${message}\n`);
}
function treeBytes(path) {
    let st;
    try {
        st = lstatSync(path);
    }
    catch {
        return 0;
    }
    if (!st.isDirectory())
        return st.size;
    return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0);
}
function megabytes(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function packageDir(nodeModules, name) {
    try {
        return realpathSync(join(nodeModules, name));
    }
    catch {
        return undefined;
    }
}
function removeAllBut(dir, keep) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of names) {
        if (!keep.includes(name))
            rmSync(join(dir, name), { recursive: true, force: true });
    }
}
function removePackage(nodeModules, name) {
    const real = packageDir(nodeModules, name);
    if (real)
        rmSync(real, { recursive: true, force: true });
    rmSync(join(nodeModules, name), { recursive: true, force: true });
}
/**
 * Keeps only what text feature-extraction loads on this host: the onnxruntime
 * native prebuilt for `<platform>/<arch>`, no onnxruntime-web, and only the
 * node builds in transformers' dist (src/ and types/ go too, decision 205).
 */
export function pruneRuntimeDeps(root, platform, arch) {
    const nodeModules = join(root, 'node_modules');
    const ort = packageDir(nodeModules, 'onnxruntime-node');
    if (ort) {
        const napi = join(ort, 'bin', 'napi-v3');
        removeAllBut(napi, [platform]);
        removeAllBut(join(napi, platform), [arch]);
    }
    removePackage(nodeModules, 'onnxruntime-web');
    const transformers = packageDir(nodeModules, TRANSFORMERS_PACKAGE);
    if (transformers) {
        removeAllBut(join(transformers, 'dist'), ['transformers.node.mjs', 'transformers.node.cjs']);
        rmSync(join(transformers, 'src'), { recursive: true, force: true });
        rmSync(join(transformers, 'types'), { recursive: true, force: true });
    }
}
/** bun resolves the manifest's sharp override but links nothing, and transformers imports sharp statically. */
function writeSharpStub(root) {
    const sharp = join(root, 'node_modules', 'sharp');
    rmSync(sharp, { recursive: true, force: true });
    mkdirSync(sharp, { recursive: true });
    for (const file of ['package.json', 'index.js'])
        copyFileSync(join(root, 'sharp-stub', file), join(sharp, file));
}
function installProblem(dir, env, stdio) {
    const entry = transformersEsmEntry(dir);
    if (!entry)
        return `${TRANSFORMERS_PACKAGE} has no ESM entry under ${dir}`;
    const version = transformersVersion(dir);
    if (version !== TRANSFORMERS_VERSION)
        return `${TRANSFORMERS_PACKAGE} is ${version}, expected ${TRANSFORMERS_VERSION}`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(entry).href)});`], {
        env,
        stdio,
    });
    if (r.error)
        return `import check failed: ${r.error.message}`;
    return r.status === 0 ? undefined : `import check exited ${r.status ?? r.signal}`;
}
function installedAtMs(dir) {
    try {
        const ms = Date.parse(readFileSync(join(dir, INSTALLED_AT), 'utf8').trim());
        return Number.isNaN(ms) ? 0 : ms;
    }
    catch {
        return 0;
    }
}
/** Renames `staging` to `final`; an existing `final` is moved aside first and removed after. */
function promote(staging, final) {
    const aside = `${staging}-old`;
    const hadFinal = isRealDir(final);
    if (hadFinal)
        renameSync(final, aside);
    try {
        renameSync(staging, final);
    }
    catch (err) {
        if (hadFinal)
            renameSync(aside, final);
        throw err;
    }
    if (hadFinal)
        rmSync(aside, { recursive: true, force: true });
}
/** `…/plugins/cache/<marketplace>/<plugin>` when `root` is a version dir under it. */
function cacheParent(root) {
    const parent = dirname(resolve(root));
    const cache = dirname(dirname(parent));
    return basename(cache) === 'cache' && basename(dirname(cache)) === 'plugins' ? parent : undefined;
}
/** The version dirs beside `root` under its plugin cache parent, `root` included; none outside a cache. */
function versionDirs(root) {
    const parent = cacheParent(root);
    if (!parent)
        return [];
    return readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(parent, e.name));
}
/** The key dirs under `deps` that `current` or a version dir's bridge resolves into. */
function referencedKeys(deps, root) {
    const keys = new Set();
    const realDeps = realpathSync(deps);
    const links = [join(deps, 'current'), ...versionDirs(root).map((v) => join(v, 'node_modules', TRANSFORMERS_PACKAGE))];
    for (const link of links) {
        let real;
        try {
            real = realpathSync(link);
        }
        catch {
            continue;
        }
        if (!isWithin(realDeps, real))
            continue;
        const first = relative(realDeps, real).split(sep)[0];
        if (first)
            keys.add(first);
    }
    return keys;
}
/**
 * Keeps `key`, the newest other key by `.installed-at` and every key still
 * referenced by `current` or a version dir's bridge; drops other keys and
 * `.staging-*` older than 1 h.
 */
function collectGarbage(deps, key, root, log) {
    const entries = readdirSync(deps, { withFileTypes: true });
    const referenced = referencedKeys(deps, root);
    const others = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== key)
        .map((e) => ({ name: e.name, at: installedAtMs(join(deps, e.name)) }))
        .sort((a, b) => b.at - a.at);
    for (const old of others.slice(1)) {
        if (referenced.has(old.name))
            continue;
        rmSync(join(deps, old.name), { recursive: true, force: true });
        log(`removed old key ${old.name}`);
    }
    for (const e of entries) {
        if (!e.name.startsWith(STAGING_PREFIX))
            continue;
        const path = join(deps, e.name);
        try {
            if (Date.now() - lstatSync(path).mtimeMs <= STAGING_STALE_MS)
                continue;
        }
        catch {
            continue;
        }
        rmSync(path, { recursive: true, force: true });
        log(`removed stale ${e.name}`);
    }
}
function onlyEntry(dir, name) {
    if (!isRealDir(dir))
        return false;
    const entries = readdirSync(dir);
    return entries.length === 1 && entries[0] === name;
}
/**
 * A `node_modules` holding exactly the layout ensureBridge writes:
 * `@huggingface/transformers` as a symlink into `<data>/deps`, dangling or not.
 */
function isBridgeOnly(nodeModules, dataDir) {
    const [scope, name] = TRANSFORMERS_PACKAGE.split('/');
    const link = join(nodeModules, scope, name);
    try {
        if (!onlyEntry(nodeModules, scope) || !onlyEntry(join(nodeModules, scope), name))
            return false;
        if (!lstatSync(link).isSymbolicLink())
            return false;
        return isWithin(resolve(depsDir(dataDir)), resolve(dirname(link), readlinkSync(link)));
    }
    catch {
        return false;
    }
}
function linkTarget(link) {
    try {
        return readlinkSync(link);
    }
    catch {
        return undefined;
    }
}
/**
 * Replaces the hook-installed node_modules of the other version dirs beside
 * `root` with a bridge to the key the sibling's own runtime-deps manifest pins
 * on `platform`/`arch`, when that key is a valid install; otherwise the sibling
 * is left unbridged for its own gate to install. A root node_modules already
 * holding only the bridge is kept: its link is re-pointed to the pinned key
 * when that key is valid, and left as it is otherwise (GH 1716).
 */
function cleanupSiblings(root, dataDir, platform, arch, log) {
    const self = resolve(root);
    for (const version of versionDirs(root)) {
        if (version === self)
            continue;
        const rootNodeModules = join(version, 'node_modules');
        const bridgeOnly = isBridgeOnly(rootNodeModules, dataDir);
        let replaced = false;
        for (const nodeModules of [rootNodeModules, join(version, MCP_REL, 'node_modules')]) {
            if (bridgeOnly && nodeModules === rootNodeModules)
                continue;
            if (!isRealDir(nodeModules))
                continue;
            rmSync(nodeModules, { recursive: true, force: true });
            log(`removed ${nodeModules}`);
            replaced = true;
        }
        if (!replaced && !bridgeOnly)
            continue;
        const pin = pinnedTransformersVersion(join(version, MCP_REL, 'runtime-deps'));
        const key = pin === undefined ? '' : runtimeDepsKey(platform, arch, pin);
        if (pin === undefined || !isValidInstall(join(depsDir(dataDir), key), pin)) {
            const state = bridgeOnly ? 'with its bridge as is' : 'unbridged';
            log(`left ${version} ${state}: no valid install for its pin ${pin ?? '(unreadable)'}`);
            continue;
        }
        if (!bridgeOnly) {
            if (ensureBridge(version, dataDir, 'any-symlink', key))
                log(`bridged ${version} → ${key}`);
            continue;
        }
        const link = join(rootNodeModules, TRANSFORMERS_PACKAGE);
        const before = linkTarget(link);
        if (ensureBridge(version, dataDir, 'own-symlink', key) && linkTarget(link) !== before) {
            log(`re-pointed ${version} → ${key}`);
        }
    }
}
/** The worker: installs, prunes and checks the key in staging, then promotes it (decision 207). */
export function installRuntimeDeps(opts) {
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    const log = opts.log ?? stdoutLogger;
    const stdio = ['ignore', opts.stdio ?? 'inherit', opts.stdio ?? 'inherit'];
    const key = runtimeDepsKey(platform, arch);
    const deps = depsDir(opts.dataDir);
    const staging = join(deps, `${STAGING_PREFIX}${key}-${process.pid}`);
    const manifest = join(opts.root, MCP_REL, 'runtime-deps');
    let rc = 1;
    try {
        mkdirSync(deps, { recursive: true });
        rmSync(staging, { recursive: true, force: true });
        cpSync(manifest, staging, { recursive: true });
        log(`staged ${manifest} in ${staging}`);
        const installer = findInstaller(opts.env, DATA_INSTALLERS);
        if (!installer)
            throw new Error('neither bun nor npm is on PATH');
        log(`${commandLine(installer)} in ${staging}`);
        const r = spawnSync(installer.path, installer.args, { cwd: staging, env: opts.env, stdio });
        log(`${installer.name} exit ${r.status ?? r.signal}`);
        if (r.error || r.status !== 0)
            throw new Error(`${installer.name} install failed${r.error ? `: ${r.error.message}` : ''}`);
        writeSharpStub(staging);
        log(`wrote the sharp stub; node_modules ${megabytes(treeBytes(join(staging, 'node_modules')))} before prune`);
        pruneRuntimeDeps(staging, platform, arch);
        log(`pruned to ${platform}/${arch}; node_modules ${megabytes(treeBytes(join(staging, 'node_modules')))}`);
        const problem = installProblem(staging, opts.env, stdio);
        if (problem)
            throw new Error(problem);
        log(`checked ${TRANSFORMERS_PACKAGE}@${TRANSFORMERS_VERSION}`);
        writeFileSync(join(staging, INSTALLED_AT), `${(opts.now ?? (() => new Date()))().toISOString()}\n`);
        promote(staging, join(deps, key));
        log(`installed ${join(deps, key)}`);
        pointCurrent(opts.dataDir, key);
        log(`current → ${key}`);
        if (ensureBridge(opts.root, opts.dataDir, 'any-symlink', key))
            log(`bridged ${opts.root} → ${key}`);
        cleanupSiblings(opts.root, opts.dataDir, platform, arch, log);
        collectGarbage(deps, key, opts.root, log);
        rc = 0;
    }
    catch (err) {
        log(`failed: ${err instanceof Error ? err.message : String(err)}`);
        rmSync(staging, { recursive: true, force: true });
    }
    log(`exit ${rc}`);
    return rc;
}
function legacyInstall(ctx, log) {
    log(`${ctx.legacyReason}: installing into ${ctx.mcpDir}`);
    const installer = findInstaller(ctx.env, LEGACY_INSTALLERS);
    if (!installer) {
        log('neither bun nor npm is on PATH');
        return 1;
    }
    log(`${commandLine(installer)} in ${ctx.mcpDir}`);
    const r = spawnSync(installer.path, installer.args, { cwd: ctx.mcpDir, env: ctx.env, stdio: ['ignore', 'inherit', 'inherit'] });
    const rc = r.status ?? 1;
    log(`exit ${rc}`);
    return rc;
}
/**
 * `node dist/hooks.js ensure-mcp-deps-installed --install`: the detached
 * worker. Spawned by the gate, it releases the gate's lock only while it still
 * owns it; run by hand, it takes the lock itself and refuses while another
 * install holds it.
 */
export function runInstallWorker(env) {
    const ctx = context(env);
    if (!ctx)
        return 0;
    const lock = lockPath(ctx);
    const token = env[LOCK_TOKEN_ENV] || takeLock(lock, staleMinutes(env));
    if (!token) {
        stdoutLogger(`another install holds ${lock}; not installing`);
        return 1;
    }
    try {
        return ctx.legacy
            ? legacyInstall(ctx, stdoutLogger)
            : installRuntimeDeps({ root: ctx.root, dataDir: ctx.dataDir, env });
    }
    finally {
        releaseLock(lock, token);
    }
}
//# sourceMappingURL=ensure-mcp-deps-installed.js.map