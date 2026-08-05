import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { TrajectoryDB } from './db.js';
import { GraphHolder, WorldModelGraph } from './graph-db.js';
import { createProjectLogger } from './logger.js';
import { createCodexRuntimeContext, assertSafeProjectWritePath, UnsafeProjectWritePathError, } from './platform.js';
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024;
export class CodexRuntimeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'CodexRuntimeError';
    }
}
/**
 * Owns a bounded, project-keyed set of runtime resources. Canonical paths are
 * the keys, so symlink aliases cannot open the same database twice.
 */
export class CodexRuntimeManager {
    plugin;
    capacity;
    now;
    graphHolderFactory;
    runtimes = new Map();
    requests = new Map();
    activeRoots = new Map();
    usageOrder = 0;
    closing = false;
    constructor(opts) {
        if (!Number.isSafeInteger(opts.capacity ?? 4) || (opts.capacity ?? 4) < 1) {
            throw new Error('Codex runtime capacity must be a positive integer');
        }
        this.plugin = opts.plugin;
        this.capacity = opts.capacity ?? 4;
        this.now = opts.now ?? Date.now;
        this.graphHolderFactory = opts.graphHolderFactory;
    }
    initialize(projectRootInput) {
        if (this.closing) {
            return Promise.reject(new CodexRuntimeError('runtime_initialization_failed', 'The Codex runtime manager is closed.'));
        }
        let projectRoot;
        try {
            projectRoot = canonicalizeProjectRootInput(projectRootInput);
        }
        catch (error) {
            return Promise.reject(normalizeRuntimeError(error));
        }
        return this.ensureRuntime(projectRoot);
    }
    async withRuntime(projectRootInput, operation) {
        if (this.closing) {
            throw new CodexRuntimeError('runtime_initialization_failed', 'The Codex runtime manager is closed.');
        }
        let projectRoot;
        try {
            projectRoot = canonicalizeProjectRootInput(projectRootInput);
        }
        catch (error) {
            throw normalizeRuntimeError(error);
        }
        this.activeRoots.set(projectRoot, (this.activeRoots.get(projectRoot) ?? 0) + 1);
        try {
            await this.ensureRuntime(projectRoot);
            const runtime = this.runtimes.get(projectRoot);
            if (!runtime || runtime.closed) {
                throw new CodexRuntimeError('runtime_initialization_failed', 'The initialized Codex runtime is unavailable.');
            }
            this.touch(runtime);
            return await operation(Object.freeze({
                context: runtime.context,
                db: runtime.db,
                graph: runtime.graph,
            }));
        }
        finally {
            const remaining = (this.activeRoots.get(projectRoot) ?? 1) - 1;
            if (remaining === 0)
                this.activeRoots.delete(projectRoot);
            else
                this.activeRoots.set(projectRoot, remaining);
        }
    }
    close() {
        if (this.closing)
            return;
        this.closing = true;
        let firstError;
        for (const runtime of this.runtimes.values()) {
            try {
                closeRuntime(runtime);
            }
            catch (error) {
                firstError ??= error;
            }
        }
        this.runtimes.clear();
        if (firstError !== undefined)
            throw firstError;
    }
    ensureRuntime(projectRoot) {
        const existingRequest = this.requests.get(projectRoot);
        if (existingRequest)
            return existingRequest;
        const request = this.initializeCanonical(projectRoot);
        this.requests.set(projectRoot, request);
        void request.finally(() => {
            if (this.requests.get(projectRoot) === request) {
                this.requests.delete(projectRoot);
            }
        }).catch(() => { });
        return request;
    }
    async initializeCanonical(projectRoot) {
        try {
            await validateGitProjectRoot(projectRoot);
        }
        catch (error) {
            throw normalizeRuntimeError(error);
        }
        if (this.closing) {
            throw new CodexRuntimeError('runtime_initialization_failed', 'The Codex runtime manager is closed.');
        }
        const existing = this.runtimes.get(projectRoot);
        if (existing && !existing.closed) {
            this.touch(existing);
            return resultFor(existing, 'reused');
        }
        if (this.runtimes.size >= this.capacity &&
            !this.findEvictionCandidate()) {
            throw capacityError();
        }
        let candidate;
        try {
            candidate = openRuntime(projectRoot, this.plugin, this.now(), this.nextUsageOrder(), this.graphHolderFactory);
            const result = resultFor(candidate, 'created');
            if (this.closing) {
                throw new CodexRuntimeError('runtime_initialization_failed', 'The Codex runtime manager closed during initialization.');
            }
            if (this.runtimes.size >= this.capacity) {
                const victim = this.findEvictionCandidate();
                if (!victim)
                    throw capacityError();
                try {
                    closeRuntime(victim);
                }
                finally {
                    this.runtimes.delete(victim.context.projectRoot);
                }
            }
            this.runtimes.set(projectRoot, candidate);
            candidate = undefined;
            return result;
        }
        catch (error) {
            if (candidate)
                closeRuntime(candidate);
            throw normalizeRuntimeError(error);
        }
    }
    findEvictionCandidate() {
        let oldest;
        for (const runtime of this.runtimes.values()) {
            if (runtime.closed ||
                (this.activeRoots.get(runtime.context.projectRoot) ?? 0) > 0) {
                continue;
            }
            if (!oldest ||
                runtime.lastUsed < oldest.lastUsed ||
                (runtime.lastUsed === oldest.lastUsed &&
                    runtime.lastUsedOrder < oldest.lastUsedOrder)) {
                oldest = runtime;
            }
        }
        return oldest;
    }
    touch(runtime) {
        runtime.lastUsed = this.now();
        runtime.lastUsedOrder = this.nextUsageOrder();
    }
    nextUsageOrder() {
        this.usageOrder += 1;
        return this.usageOrder;
    }
}
function canonicalizeProjectRootInput(input) {
    if (typeof input !== 'string' || input.length === 0) {
        throw new CodexRuntimeError('missing_project_root', 'project_root is required.');
    }
    if (!isAbsolute(input)) {
        throw new CodexRuntimeError('project_root_not_absolute', 'project_root must be an absolute path.');
    }
    let stat;
    try {
        stat = statSync(input);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            throw new CodexRuntimeError('project_root_not_found', 'project_root must identify an existing path.');
        }
        throw new CodexRuntimeError('project_root_not_found', 'project_root could not be inspected.');
    }
    if (!stat.isDirectory()) {
        throw new CodexRuntimeError('project_root_not_directory', 'project_root must identify a directory.');
    }
    let canonical;
    try {
        canonical = realpathSync(input);
    }
    catch {
        throw new CodexRuntimeError('project_root_not_found', 'project_root could not be canonicalized.');
    }
    return canonical;
}
async function validateGitProjectRoot(canonical) {
    const topLevel = await runGit(canonical, ['rev-parse', '--show-toplevel']);
    if (!topLevel.ok) {
        throw new CodexRuntimeError('project_root_not_git_toplevel', 'project_root must identify a Git worktree top level.');
    }
    let canonicalTopLevel;
    try {
        canonicalTopLevel = realpathSync(topLevel.stdout);
    }
    catch {
        throw new CodexRuntimeError('project_root_not_git_toplevel', 'Git returned an invalid worktree top level.');
    }
    if (canonicalTopLevel !== canonical) {
        throw new CodexRuntimeError('project_root_not_git_toplevel', 'project_root must be the Git worktree top level, not a nested directory.');
    }
    const ignored = await runGit(canonical, [
        'check-ignore',
        '--no-index',
        '--quiet',
        '.tmb/',
    ]);
    if (!ignored.ok) {
        throw stateNotIgnoredError();
    }
    const tracked = await runGit(canonical, ['ls-files', '-z', '--', '.tmb']);
    if (!tracked.ok || tracked.stdout.length > 0) {
        throw stateNotIgnoredError();
    }
}
function runGit(cwd, args) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    env['GIT_TERMINAL_PROMPT'] = '0';
    env['GIT_CONFIG_NOSYSTEM'] = '1';
    env['GIT_CONFIG_GLOBAL'] = '/dev/null';
    env['LC_ALL'] = 'C';
    return new Promise((resolve) => {
        execFile('git', [
            '-c',
            'core.fsmonitor=false',
            '-c',
            'core.excludesFile=/dev/null',
            '-c',
            'core.hooksPath=/dev/null',
            '-C',
            cwd,
            ...args,
        ], {
            encoding: 'utf8',
            env,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER_BYTES,
        }, (error, stdout) => {
            resolve({
                ok: error === null,
                stdout: stdout.trim(),
            });
        });
    });
}
function openRuntime(projectRoot, plugin, now, lastUsedOrder, graphHolderFactory) {
    let context;
    try {
        context = createCodexRuntimeContext({
            projectRoot,
            pluginRoot: plugin.root,
            pluginName: plugin.name,
            pluginVersion: plugin.version,
        });
        assertSafeProjectWritePath(context.projectRoot, context.paths.stateDir, 'Codex state directory', 'directory');
        mkdirSync(context.paths.stateDir, { recursive: true });
    }
    catch (error) {
        if (error instanceof UnsafeProjectWritePathError) {
            throw new CodexRuntimeError('unsafe_project_state_path', error.message);
        }
        throw error;
    }
    const logger = createProjectLogger({
        logDir: context.paths.logDir,
        trustedProjectRoot: context.projectRoot,
    });
    let db;
    try {
        db = new TrajectoryDB(context.paths.trajectoryDb, {
            pluginVersion: plugin.version,
            serverLog: logger.serverLog,
            sqlLog: logger.sqlLog,
            trustedProjectRoot: context.projectRoot,
        });
        const graph = graphHolderFactory?.(context) ??
            new GraphHolder({
                open: () => new WorldModelGraph(context.paths.graphDb, {
                    trustedProjectRoot: context.projectRoot,
                }),
                log: (entry) => logger.serverLogSync({ ...entry, path: context.paths.graphDb }),
            });
        return {
            context,
            db,
            graph,
            lastUsed: now,
            lastUsedOrder,
            closed: false,
        };
    }
    catch (error) {
        try {
            db?.close();
        }
        catch {
            // Preserve the initialization error.
        }
        if (error instanceof UnsafeProjectWritePathError) {
            throw new CodexRuntimeError('unsafe_project_state_path', error.message);
        }
        throw error;
    }
}
function resultFor(runtime, status) {
    const row = runtime.db.get('SELECT schema_version FROM plugin_meta WHERE id = 1');
    if (!row) {
        throw new CodexRuntimeError('runtime_initialization_failed', 'The initialized trajectory database has no schema metadata.');
    }
    return Object.freeze({
        status,
        project_root: runtime.context.projectRoot,
        plugin_name: runtime.context.plugin.name,
        plugin_version: runtime.context.plugin.version,
        state_dir: runtime.context.paths.stateDir,
        trajectory_db: runtime.context.paths.trajectoryDb,
        graph_db: runtime.context.paths.graphDb,
        log_dir: runtime.context.paths.logDir,
        schema_version: row.schema_version,
        graph_available: graphDependencyAvailable(),
        graph_status: graphDependencyAvailable() ? 'deferred' : 'unavailable',
    });
}
function closeRuntime(runtime) {
    if (runtime.closed)
        return;
    runtime.closed = true;
    try {
        runtime.graph.graph?.close();
    }
    finally {
        runtime.db.close();
    }
}
function normalizeRuntimeError(error) {
    if (error instanceof CodexRuntimeError)
        return error;
    if (error instanceof UnsafeProjectWritePathError) {
        return new CodexRuntimeError('unsafe_project_state_path', error.message);
    }
    return new CodexRuntimeError('runtime_initialization_failed', error instanceof Error ? error.message : String(error));
}
function stateNotIgnoredError() {
    return new CodexRuntimeError('project_state_not_ignored', 'The project must ignore .tmb/ and must not track files below it.');
}
function capacityError() {
    return new CodexRuntimeError('runtime_capacity_exceeded', 'No Codex runtime capacity is available for this initialization.');
}
function graphDependencyAvailable() {
    try {
        createRequire(import.meta.url).resolve('kuzu');
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=codex-runtime.js.map