import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  assertSafeProjectWritePath,
  resolveClaudeLogDir,
  UnsafeProjectWritePathError,
} from './platform.js';

export type ProjectLog = (entry: Record<string, unknown>) => void;

export interface ProjectLogger {
  readonly logDir: string;
  readonly serverLog: ProjectLog;
  readonly serverLogSync: ProjectLog;
  readonly sqlLog: ProjectLog;
}

export interface ProjectLoggerOptions {
  readonly logDir: string;
  readonly sqlEnabled?: boolean;
  /** Canonical project root for Codex-bound loggers. */
  readonly trustedProjectRoot?: string;
}

type AppendLogLine = (path: string, line: string) => void;

/**
 * Create a logger bound to one runtime context's log directory.
 *
 * Directory creation belongs here, not in runtime-context resolution, so
 * resolving and validating paths remains side-effect free. Each append opens
 * the leaf with no-follow protection where the host supports it and refuses
 * any leaf already identified as a symlink or non-file.
 */
export function createProjectLogger(opts: ProjectLoggerOptions): ProjectLogger {
  if (opts.trustedProjectRoot !== undefined) {
    assertSafeProjectWritePath(
      opts.trustedProjectRoot,
      opts.logDir,
      'Project log directory',
      'directory',
    );
    try {
      mkdirSync(opts.logDir, { recursive: true });
    } catch (error) {
      throw new UnsafeProjectWritePathError(
        `Project log directory could not be created safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!lstatSync(opts.logDir).isDirectory()) {
      throw new UnsafeProjectWritePathError(
        'Project log directory must be a directory',
      );
    }
    assertSafeProjectWritePath(
      opts.trustedProjectRoot,
      opts.logDir,
      'Project log directory',
      'directory',
    );
    for (const leaf of ['mcp-server.log', 'sql.log']) {
      const path = join(opts.logDir, leaf);
      assertSafeProjectWritePath(
        opts.trustedProjectRoot,
        path,
        'Project log file',
        'file',
      );
      try {
        if (!lstatSync(path).isFile()) {
          throw new UnsafeProjectWritePathError(
            'Project log file must be a regular file',
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return createLogger(opts, (path, line) => {
    if (opts.trustedProjectRoot !== undefined) {
      assertSafeProjectWritePath(
        opts.trustedProjectRoot,
        path,
        'Project log file',
        'file',
      );
    }
    appendSecureLogLine(path, line);
  });
}

function createLogger(
  opts: ProjectLoggerOptions,
  appendLine: AppendLogLine,
): ProjectLogger {
  let logDirReady = false;
  try {
    mkdirSync(opts.logDir, { recursive: true });
    logDirReady = true;
  } catch {
    // Log dir creation failed; both log functions become no-ops.
  }

  const serverLogPath = join(opts.logDir, 'mcp-server.log');
  const sqlLogPath = join(opts.logDir, 'sql.log');

  const serverLog: ProjectLog = (entry) => {
    if (!logDirReady) return;
    try {
      const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
      appendLine(serverLogPath, line);
    } catch {
      // Swallow all errors — logging must never break the server.
    }
  };

  const sqlLog: ProjectLog =
    opts.sqlEnabled === true
      ? (entry) => {
          if (!logDirReady) return;
          try {
            const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
            appendLine(sqlLogPath, line);
          } catch {
            // Swallow all errors.
          }
        }
      : () => {};

  return Object.freeze({
    logDir: opts.logDir,
    serverLog,
    serverLogSync: serverLog,
    sqlLog,
  });
}

function appendSecureLogLine(path: string, line: string): void {
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Refusing to append to unsafe log target: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    appendFileSync(fd, line, 'utf8');
  } finally {
    closeSync(fd);
  }
}

let defaultLogger: ProjectLogger | null = null;

function getDefaultLogger(): ProjectLogger {
  if (defaultLogger === null) {
    defaultLogger = createLogger(
      {
        logDir: resolveClaudeLogDir(),
        sqlEnabled: process.env['TMB_DEBUG_SQL'] === '1',
      },
      appendFileSync,
    );
  }
  return defaultLogger;
}

/**
 * Backward-compatible Claude singleton exports. The singleton is lazy so a
 * Codex caller that supplies explicit logger dependencies can import the DB
 * module without reading Claude metadata or creating ~/.claude state. It also
 * keeps Claude's historical append semantics; no-follow writes are limited to
 * explicitly bound project loggers.
 */
export function serverLog(entry: Record<string, unknown>): void {
  getDefaultLogger().serverLog(entry);
}

export const serverLogSync = serverLog;

export function sqlLog(entry: Record<string, unknown>): void {
  getDefaultLogger().sqlLog(entry);
}
