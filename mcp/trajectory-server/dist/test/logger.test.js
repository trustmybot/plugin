import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, chmodSync, mkdirSync, rmdirSync, rmSync, } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
describe('logger', () => {
    it('does not create Claude state when the module is only imported', async () => {
        const tmpHome = mkdtempSync(join(tmpdir(), 'tmb-lazy-logger-'));
        const savedHome = process.env['HOME'];
        try {
            process.env['HOME'] = tmpHome;
            await import(`../logger.js?lazy-${Date.now()}`);
            assert.ok(!existsSync(join(tmpHome, '.claude')), 'import-only callers must not create Claude state');
        }
        finally {
            if (savedHome === undefined) {
                delete process.env['HOME'];
            }
            else {
                process.env['HOME'] = savedHome;
            }
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
            const serverEntry = JSON.parse(readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim());
            const sqlEntry = JSON.parse(readFileSync(join(logDir, 'sql.log'), 'utf8').trim());
            assert.equal(serverEntry.kind, 'server-test');
            assert.equal(sqlEntry.kind, 'sql-test');
            assert.equal(sqlEntry.ok, true);
            assert.match(serverEntry.ts, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(sqlEntry.ts, /^\d{4}-\d{2}-\d{2}T/);
        }
        finally {
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
        }
        finally {
            if (savedHome === undefined) {
                delete process.env['HOME'];
            }
            else {
                process.env['HOME'] = savedHome;
            }
            if (savedSql === undefined) {
                delete process.env['TMB_DEBUG_SQL'];
            }
            else {
                process.env['TMB_DEBUG_SQL'] = savedSql;
            }
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
        }
        finally {
            if (savedHome === undefined) {
                delete process.env['HOME'];
            }
            else {
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
        }
        finally {
            try {
                const logsDir = join(tmpHome, '.claude', 'tmb', 'logs');
                chmodSync(logsDir, 0o755);
                rmdirSync(logsDir);
            }
            catch {
                // best-effort cleanup
            }
            if (savedHome === undefined) {
                delete process.env['HOME'];
            }
            else {
                process.env['HOME'] = savedHome;
            }
        }
    });
});
//# sourceMappingURL=logger.test.js.map