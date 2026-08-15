import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { TrajectoryDB } from './db.js';
import { GraphHolder, WorldModelGraph } from './graph-db.js';
import { createProjectLogger } from './logger.js';
import {
  createCodexRuntimeContext,
  assertSafeProjectWritePath,
  UnsafeProjectWritePathError,
  type CodexPluginMetadata,
  type CodexRuntimeContext,
} from './platform.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024;

export type RuntimeInitializeStatus = 'created' | 'reused';
export type RuntimeGraphStatus = 'deferred' | 'unavailable';

export type CodexRuntimeErrorCode =
  | 'missing_project_root'
  | 'project_root_not_absolute'
  | 'project_root_not_found'
  | 'project_root_not_directory'
  | 'project_root_not_git_toplevel'
  | 'project_state_not_ignored'
  | 'unsafe_project_state_path'
  | 'runtime_initialization_failed'
  | 'runtime_capacity_exceeded';

export interface RuntimeInitializeResult {
  readonly status: RuntimeInitializeStatus;
  readonly project_root: string;
  readonly plugin_name: string;
  readonly plugin_version: string;
  readonly state_dir: string;
  readonly trajectory_db: string;
  readonly graph_db: string;
  readonly log_dir: string;
  readonly schema_version: number;
  readonly graph_available: boolean;
  readonly graph_status: RuntimeGraphStatus;
}

interface RuntimeResources {
  readonly context: CodexRuntimeContext;
  readonly db: TrajectoryDB;
  readonly graph: GraphHolder;
  lastUsed: number;
  lastUsedOrder: number;
  closed: boolean;
}

export interface CodexProjectRootValidationOptions {
  readonly runGit?: CodexGitRunner;
}

export type CodexGitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<{ readonly ok: boolean; readonly stdout: string }>;

export interface CodexRuntimeAccess {
  readonly context: CodexRuntimeContext;
  readonly db: TrajectoryDB;
  readonly graph: GraphHolder;
}

export class CodexRuntimeError extends Error {
  constructor(
    readonly code: CodexRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRuntimeError';
  }
}

export interface CodexRuntimeManagerOptions {
  readonly plugin: CodexPluginMetadata;
  readonly capacity?: number;
  readonly now?: () => number;
  readonly graphHolderFactory?: (
    context: CodexRuntimeContext,
  ) => GraphHolder;
}

/**
 * Owns a bounded, project-keyed set of runtime resources. Canonical paths are
 * the keys, so symlink aliases cannot open the same database twice.
 */
export class CodexRuntimeManager {
  private readonly plugin: CodexPluginMetadata;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly graphHolderFactory?: (
    context: CodexRuntimeContext,
  ) => GraphHolder;
  private readonly runtimes = new Map<string, RuntimeResources>();
  private readonly requests = new Map<
    string,
    Promise<RuntimeInitializeResult>
  >();
  private readonly activeRoots = new Map<string, number>();
  private usageOrder = 0;
  private closing = false;

  constructor(opts: CodexRuntimeManagerOptions) {
    if (!Number.isSafeInteger(opts.capacity ?? 4) || (opts.capacity ?? 4) < 1) {
      throw new Error('Codex runtime capacity must be a positive integer');
    }
    this.plugin = opts.plugin;
    this.capacity = opts.capacity ?? 4;
    this.now = opts.now ?? Date.now;
    this.graphHolderFactory = opts.graphHolderFactory;
  }

  initialize(projectRootInput: unknown): Promise<RuntimeInitializeResult> {
    if (this.closing) {
      return Promise.reject(
        new CodexRuntimeError(
          'runtime_initialization_failed',
          'The Codex runtime manager is closed.',
        ),
      );
    }

    let projectRoot: string;
    try {
      projectRoot = canonicalizeProjectRootInput(projectRootInput);
    } catch (error) {
      return Promise.reject(normalizeRuntimeError(error));
    }
    return this.ensureRuntime(projectRoot);
  }

  async withRuntime<T>(
    projectRootInput: unknown,
    operation: (runtime: CodexRuntimeAccess) => Promise<T> | T,
  ): Promise<T> {
    if (this.closing) {
      throw new CodexRuntimeError(
        'runtime_initialization_failed',
        'The Codex runtime manager is closed.',
      );
    }

    let projectRoot: string;
    try {
      projectRoot = canonicalizeProjectRootInput(projectRootInput);
    } catch (error) {
      throw normalizeRuntimeError(error);
    }

    this.activeRoots.set(
      projectRoot,
      (this.activeRoots.get(projectRoot) ?? 0) + 1,
    );
    try {
      await this.ensureRuntime(projectRoot);
      const runtime = this.runtimes.get(projectRoot);
      if (!runtime || runtime.closed) {
        throw new CodexRuntimeError(
          'runtime_initialization_failed',
          'The initialized Codex runtime is unavailable.',
        );
      }
      this.touch(runtime);
      return await operation(
        Object.freeze({
          context: runtime.context,
          db: runtime.db,
          graph: runtime.graph,
        }),
      );
    } finally {
      const remaining = (this.activeRoots.get(projectRoot) ?? 1) - 1;
      if (remaining === 0) this.activeRoots.delete(projectRoot);
      else this.activeRoots.set(projectRoot, remaining);
    }
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    let firstError: unknown;
    for (const runtime of this.runtimes.values()) {
      try {
        closeRuntime(runtime);
      } catch (error) {
        firstError ??= error;
      }
    }
    this.runtimes.clear();
    if (firstError !== undefined) throw firstError;
  }

  private ensureRuntime(
    projectRoot: string,
  ): Promise<RuntimeInitializeResult> {
    const existingRequest = this.requests.get(projectRoot);
    if (existingRequest) return existingRequest;

    const request = this.initializeCanonical(projectRoot);
    this.requests.set(projectRoot, request);
    void request.finally(() => {
      if (this.requests.get(projectRoot) === request) {
        this.requests.delete(projectRoot);
      }
    }).catch(() => {});
    return request;
  }

  private async initializeCanonical(
    projectRoot: string,
  ): Promise<RuntimeInitializeResult> {
    try {
      await validateGitProjectRoot(projectRoot, runGit);
    } catch (error) {
      throw normalizeRuntimeError(error);
    }

    if (this.closing) {
      throw new CodexRuntimeError(
        'runtime_initialization_failed',
        'The Codex runtime manager is closed.',
      );
    }

    const existing = this.runtimes.get(projectRoot);
    if (existing && !existing.closed) {
      this.touch(existing);
      return resultFor(existing, 'reused');
    }

    if (
      this.runtimes.size >= this.capacity &&
      !this.findEvictionCandidate()
    ) {
      throw capacityError();
    }

    let candidate: RuntimeResources | undefined;
    try {
      candidate = openRuntime(
        projectRoot,
        this.plugin,
        this.now(),
        this.nextUsageOrder(),
        this.graphHolderFactory,
      );
      const result = resultFor(candidate, 'created');

      if (this.closing) {
        throw new CodexRuntimeError(
          'runtime_initialization_failed',
          'The Codex runtime manager closed during initialization.',
        );
      }

      if (this.runtimes.size >= this.capacity) {
        const victim = this.findEvictionCandidate();
        if (!victim) throw capacityError();
        try {
          closeRuntime(victim);
        } finally {
          this.runtimes.delete(victim.context.projectRoot);
        }
      }

      this.runtimes.set(projectRoot, candidate);
      candidate = undefined;
      return result;
    } catch (error) {
      if (candidate) closeRuntime(candidate);
      throw normalizeRuntimeError(error);
    }
  }

  private findEvictionCandidate(): RuntimeResources | undefined {
    let oldest: RuntimeResources | undefined;
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.closed ||
        (this.activeRoots.get(runtime.context.projectRoot) ?? 0) > 0
      ) {
        continue;
      }
      if (
        !oldest ||
        runtime.lastUsed < oldest.lastUsed ||
        (runtime.lastUsed === oldest.lastUsed &&
          runtime.lastUsedOrder < oldest.lastUsedOrder)
      ) {
        oldest = runtime;
      }
    }
    return oldest;
  }

  private touch(runtime: RuntimeResources): void {
    runtime.lastUsed = this.now();
    runtime.lastUsedOrder = this.nextUsageOrder();
  }

  private nextUsageOrder(): number {
    this.usageOrder += 1;
    return this.usageOrder;
  }
}

export async function validateCodexProjectRoot(
  input: unknown,
  options: CodexProjectRootValidationOptions = {},
): Promise<string> {
  let canonical: string;
  try {
    canonical = canonicalizeProjectRootInput(input);
    await validateGitProjectRoot(canonical, options.runGit ?? runGit);
  } catch (error) {
    throw normalizeRuntimeError(error);
  }
  return canonical;
}

function canonicalizeProjectRootInput(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new CodexRuntimeError(
      'missing_project_root',
      'project_root is required.',
    );
  }
  if (!isAbsolute(input)) {
    throw new CodexRuntimeError(
      'project_root_not_absolute',
      'project_root must be an absolute path.',
    );
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CodexRuntimeError(
        'project_root_not_found',
        'project_root must identify an existing path.',
      );
    }
    throw new CodexRuntimeError(
      'project_root_not_found',
      'project_root could not be inspected.',
    );
  }
  if (!stat.isDirectory()) {
    throw new CodexRuntimeError(
      'project_root_not_directory',
      'project_root must identify a directory.',
    );
  }

  let canonical: string;
  try {
    canonical = realpathSync(input);
  } catch {
    throw new CodexRuntimeError(
      'project_root_not_found',
      'project_root could not be canonicalized.',
    );
  }
  return canonical;
}

async function validateGitProjectRoot(
  canonical: string,
  git: CodexGitRunner,
): Promise<void> {
  const topLevel = await git(canonical, ['rev-parse', '--show-toplevel']);
  if (!topLevel.ok) {
    throw new CodexRuntimeError(
      'project_root_not_git_toplevel',
      'project_root must identify a Git worktree top level.',
    );
  }

  let canonicalTopLevel: string;
  try {
    canonicalTopLevel = realpathSync(topLevel.stdout);
  } catch {
    throw new CodexRuntimeError(
      'project_root_not_git_toplevel',
      'Git returned an invalid worktree top level.',
    );
  }
  if (canonicalTopLevel !== canonical) {
    throw new CodexRuntimeError(
      'project_root_not_git_toplevel',
      'project_root must be the Git worktree top level, not a nested directory.',
    );
  }

  const ignored = await git(canonical, [
    'check-ignore',
    '--no-index',
    '--quiet',
    '.tmb/',
  ]);
  if (!ignored.ok) {
    throw stateNotIgnoredError();
  }

  const tracked = await git(canonical, ['ls-files', '-z', '--', '.tmb']);
  if (!tracked.ok || tracked.stdout.length > 0) {
    throw stateNotIgnoredError();
  }
}

const runGit: CodexGitRunner = (
  cwd: string,
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly stdout: string }> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  env['LC_ALL'] = 'C';

  return new Promise((resolve) => {
    execFile(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.excludesFile=/dev/null',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        cwd,
        ...args,
      ],
      {
        encoding: 'utf8',
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      },
      (error, stdout) => {
        resolve({
          ok: error === null,
          stdout: stdout.trim(),
        });
      },
    );
  });
};

function openRuntime(
  projectRoot: string,
  plugin: CodexPluginMetadata,
  now: number,
  lastUsedOrder: number,
  graphHolderFactory?: (
    context: CodexRuntimeContext,
  ) => GraphHolder,
): RuntimeResources {
  let context: CodexRuntimeContext;
  try {
    context = createCodexRuntimeContext({
      projectRoot,
      pluginRoot: plugin.root,
      pluginName: plugin.name,
      pluginVersion: plugin.version,
    });
    assertSafeProjectWritePath(
      context.projectRoot,
      context.paths.stateDir,
      'Codex state directory',
      'directory',
    );
    mkdirSync(context.paths.stateDir, { recursive: true });
  } catch (error) {
    if (error instanceof UnsafeProjectWritePathError) {
      throw new CodexRuntimeError(
        'unsafe_project_state_path',
        error.message,
      );
    }
    throw error;
  }

  const logger = createProjectLogger({
    logDir: context.paths.logDir,
    trustedProjectRoot: context.projectRoot,
  });
  let db: TrajectoryDB | undefined;
  try {
    db = new TrajectoryDB(context.paths.trajectoryDb, {
      pluginVersion: plugin.version,
      serverLog: logger.serverLog,
      sqlLog: logger.sqlLog,
      trustedProjectRoot: context.projectRoot,
    });
    const graph = graphHolderFactory?.(context) ??
      new GraphHolder({
        open: () =>
          new WorldModelGraph(context.paths.graphDb, {
            trustedProjectRoot: context.projectRoot,
          }),
        log: (entry) =>
          logger.serverLogSync({ ...entry, path: context.paths.graphDb }),
      });

    return {
      context,
      db,
      graph,
      lastUsed: now,
      lastUsedOrder,
      closed: false,
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the initialization error.
    }
    if (error instanceof UnsafeProjectWritePathError) {
      throw new CodexRuntimeError(
        'unsafe_project_state_path',
        error.message,
      );
    }
    throw error;
  }
}

function resultFor(
  runtime: RuntimeResources,
  status: RuntimeInitializeStatus,
): RuntimeInitializeResult {
  const row = runtime.db.get<{ schema_version: number }>(
    'SELECT schema_version FROM plugin_meta WHERE id = 1',
  );
  if (!row) {
    throw new CodexRuntimeError(
      'runtime_initialization_failed',
      'The initialized trajectory database has no schema metadata.',
    );
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

function closeRuntime(runtime: RuntimeResources): void {
  if (runtime.closed) return;
  runtime.closed = true;
  try {
    runtime.graph.graph?.close();
  } finally {
    runtime.db.close();
  }
}

function normalizeRuntimeError(error: unknown): CodexRuntimeError {
  if (error instanceof CodexRuntimeError) return error;
  if (error instanceof UnsafeProjectWritePathError) {
    return new CodexRuntimeError('unsafe_project_state_path', error.message);
  }
  return new CodexRuntimeError(
    'runtime_initialization_failed',
    error instanceof Error ? error.message : String(error),
  );
}

function stateNotIgnoredError(): CodexRuntimeError {
  return new CodexRuntimeError(
    'project_state_not_ignored',
    'The project must ignore .tmb/ and must not track files below it.',
  );
}

function capacityError(): CodexRuntimeError {
  return new CodexRuntimeError(
    'runtime_capacity_exceeded',
    'No Codex runtime capacity is available for this initialization.',
  );
}

function graphDependencyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('kuzu');
    return true;
  } catch {
    return false;
  }
}
