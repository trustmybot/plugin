import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  chmodSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('logger', () => {
  it('does not create Claude state when the module is only imported', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'tmb-lazy-logger-'));
    const savedHome = process.env['HOME'];
    try {
      process.env['HOME'] = tmpHome;
      await import(`../logger.js?lazy-${Date.now()}`);
      assert.ok(
        !existsSync(join(tmpHome, '.claude')),
        'import-only callers must not create Claude state',
      );
    } finally {
      if (savedHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = savedHome;
      }
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('does not create Claude state when the DB module is imported in a fresh process', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'tmb-lazy-db-'));
    try {
      const dbModuleUrl = new URL('../db.js', import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-sqlite',
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(dbModuleUrl)})`,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, HOME: tmpHome },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        existsSync(join(tmpHome, '.claude')),
        false,
        'importing db.js must not create Claude state',
      );
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('createProjectLogger binds server and SQL logs to an explicit project path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmb-project-logger-'));
    const logDir = join(root, '.tmb', 'tmb', 'logs');
    try {
      const { createProjectLogger } = await import('../logger.js');
      const logger = createProjectLogger({ logDir, sqlEnabled: true });

      logger.serverLog({ kind: 'server-test' });
      logger.sqlLog({ kind: 'sql-test', ok: true });

      assert.equal(logger.logDir, logDir);
      const serverEntry = JSON.parse(
        readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim(),
      ) as { kind: string; ts: string };
      const sqlEntry = JSON.parse(
        readFileSync(join(logDir, 'sql.log'), 'utf8').trim(),
      ) as { kind: string; ok: boolean; ts: string };
      assert.equal(serverEntry.kind, 'server-test');
      assert.equal(sqlEntry.kind, 'sql-test');
      assert.equal(sqlEntry.ok, true);
      assert.match(serverEntry.ts, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(sqlEntry.ts, /^\d{4}-\d{2}-\d{2}T/);
      if (process.platform !== 'win32') {
        assert.equal(statSync(join(logDir, 'mcp-server.log')).mode & 0o777, 0o600);
        assert.equal(statSync(join(logDir, 'sql.log')).mode & 0o777, 0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sqlLog is a no-op when TMB_DEBUG_SQL is unset', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'tmb-logger-test-'));
    const savedHome = process.env['HOME'];
    const savedSql = process.env['TMB_DEBUG_SQL'];
    try {
      process.env['HOME'] = tmpHome;
      delete process.env['TMB_DEBUG_SQL'];

      const { sqlLog } = await import(`../logger.js?noop-${Date.now()}`);
      sqlLog({ kind: 'test', msg: 'should not appear' });

      const sqlLogPath = join(tmpHome, '.claude', 'tmb', 'logs', 'sql.log');
      assert.ok(!existsSync(sqlLogPath), 'sql.log must not exist when TMB_DEBUG_SQL is unset');
    } finally {
      if (savedHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = savedHome;
      }
      if (savedSql === undefined) {
        delete process.env['TMB_DEBUG_SQL'];
      } else {
        process.env['TMB_DEBUG_SQL'] = savedSql;
      }
    }
  });

  it('never follows project log leaf symlinks outside the log directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmb-log-symlink-'));
    try {
      const logDir = join(root, 'project', '.tmb', 'tmb', 'logs');
      const outside = join(root, 'outside');
      mkdirSync(logDir, { recursive: true });
      mkdirSync(outside);
      const serverTarget = join(outside, 'server.log');
      const sqlTarget = join(outside, 'sql.log');
      writeFileSync(serverTarget, 'server-sentinel');
      symlinkSync(serverTarget, join(logDir, 'mcp-server.log'), 'file');
      symlinkSync(sqlTarget, join(logDir, 'sql.log'), 'file');

      const { createProjectLogger } = await import('../logger.js');
      const logger = createProjectLogger({ logDir, sqlEnabled: true });

      assert.doesNotThrow(() => logger.serverLog({ kind: 'server-test' }));
      assert.doesNotThrow(() => logger.sqlLog({ kind: 'sql-test' }));
      assert.equal(readFileSync(serverTarget, 'utf8'), 'server-sentinel');
      assert.equal(existsSync(sqlTarget), false, 'dangling SQL-log target must stay absent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops project logging if an ancestor is replaced after logger creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmb-log-ancestor-swap-'));
    try {
      const projectRoot = join(root, 'project');
      const outside = join(root, 'outside');
      mkdirSync(projectRoot);
      mkdirSync(outside);
      const canonicalProjectRoot = realpathSync(projectRoot);
      const logDir = join(canonicalProjectRoot, '.tmb', 'tmb', 'logs');

      const { createProjectLogger } = await import('../logger.js');
      const logger = createProjectLogger({
        logDir,
        sqlEnabled: true,
        trustedProjectRoot: canonicalProjectRoot,
      });
      rmSync(join(canonicalProjectRoot, '.tmb'), { recursive: true });
      symlinkSync(outside, join(canonicalProjectRoot, '.tmb'), 'dir');

      assert.doesNotThrow(() => logger.serverLog({ kind: 'server-test' }));
      assert.doesNotThrow(() => logger.sqlLog({ kind: 'sql-test' }));
      assert.equal(existsSync(join(outside, 'tmb')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the existing Claude singleton append behavior separate from secure project loggers', () => {
    if (process.platform === 'win32') return;
    const tmpHome = mkdtempSync(join(tmpdir(), 'tmb-legacy-logger-'));
    try {
      const logDir = join(tmpHome, '.claude', 'tmb', 'logs');
      const target = join(tmpHome, 'legacy-server.log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(target, 'legacy-sentinel\n');
      symlinkSync(target, join(logDir, 'mcp-server.log'), 'file');

      const loggerModuleUrl = new URL('../logger.js', import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { serverLog } = await import(${JSON.stringify(loggerModuleUrl)}); serverLog({ kind: 'legacy-symlink' });`,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, HOME: tmpHome, CLAUDE_PLUGIN_ROOT: '' },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      const written = readFileSync(target, 'utf8');
      assert.match(written, /^legacy-sentinel\n/);
      assert.match(written, /"kind":"legacy-symlink"/);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('serverLog writes valid JSONL with payload and auto-ts', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'tmb-logger-test-'));
    const savedHome = process.env['HOME'];
    try {
      process.env['HOME'] = tmpHome;

      const { serverLog } = await import(`../logger.js?server-${Date.now()}`);
      serverLog({ kind: 'test', value: 42 });

      const serverLogPath = join(tmpHome, '.claude', 'tmb', 'logs', 'mcp-server.log');
      assert.ok(existsSync(serverLogPath), 'mcp-server.log must exist after serverLog call');

      const raw = readFileSync(serverLogPath, 'utf8').trim();
      assert.ok(raw.length > 0, 'log file must not be empty');

      const parsed = JSON.parse(raw);
      assert.equal(parsed.kind, 'test');
      assert.equal(parsed.value, 42);
      assert.ok(typeof parsed.ts === 'string', 'ts field must be present');
      assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      if (savedHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = savedHome;
      }
    }
  });

  it('logger does not throw when log dir is unwriteable', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'tmb-logger-test-'));
    const savedHome = process.env['HOME'];
    try {
      process.env['HOME'] = tmpHome;

      const logsParent = join(tmpHome, '.claude', 'tmb');
      mkdirSync(logsParent, { recursive: true });
      const logsDir = join(logsParent, 'logs');
      mkdirSync(logsDir, { recursive: true });
      chmodSync(logsDir, 0o444);

      const { serverLog } = await import(`../logger.js?unwriteable-${Date.now()}`);

      assert.doesNotThrow(() => {
        serverLog({ kind: 'test' });
      });
    } finally {
      try {
        const logsDir = join(tmpHome, '.claude', 'tmb', 'logs');
        chmodSync(logsDir, 0o755);
        rmdirSync(logsDir);
      } catch {
        // best-effort cleanup
      }
      if (savedHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = savedHome;
      }
    }
  });

  it('makes both project loggers no-ops when log-dir creation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmb-project-logger-failure-'));
    try {
      const logDir = join(root, 'not-a-directory');
      writeFileSync(logDir, 'sentinel');
      const { createProjectLogger } = await import('../logger.js');
      const logger = createProjectLogger({ logDir, sqlEnabled: true });

      assert.doesNotThrow(() => logger.serverLog({ kind: 'server-test' }));
      assert.doesNotThrow(() => logger.sqlLog({ kind: 'sql-test' }));
      assert.equal(readFileSync(logDir, 'utf8'), 'sentinel');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
