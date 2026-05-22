import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tempDB } from './helpers.js';
import { fileRegistryTools } from '../tools/file-registry.js';
async function call(handlers, name, args) {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    const argsWithAgent = 'agent' in args ? args : { agent: 'bro', ...args };
    return handler(argsWithAgent);
}
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
describe('fileRegistryTools', () => {
    describe('file_registry_upsert', () => {
        it('upsert a minimal row and get it back', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_upsert', {
                path: 'src/index.ts',
                type: 'source',
            });
            assert.ok(!result.isError);
            const row = parseResult(result);
            assert.equal(row.path, 'src/index.ts');
            assert.equal(row.type, 'source');
            db.close();
        });
        it('upsert is idempotent: calling twice with same path replaces without error', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            await call(tools.handlers, 'file_registry_upsert', {
                path: 'src/index.ts',
                type: 'source',
            });
            const result = await call(tools.handlers, 'file_registry_upsert', {
                path: 'src/index.ts',
                type: 'test',
            });
            assert.ok(!result.isError);
            const row = parseResult(result);
            assert.equal(row.type, 'test', 'second upsert should update type');
            const count = db.get('SELECT COUNT(*) AS n FROM file_registry');
            assert.equal(count?.n, 1, 'must remain 1 row after two upserts of same path');
            db.close();
        });
        it('upsert does not clobber content_md5 or summary written by file_registry_update_summaries', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'fru-'));
            const cwdPrev = process.cwd();
            process.chdir(dir);
            try {
                writeFileSync(join(dir, 'preserve.ts'), 'export const x = 1;\n');
                const db = tempDB();
                const tools = fileRegistryTools(db);
                const summaryResult = await call(tools.handlers, 'file_registry_update_summaries', {
                    updates: [{ path: 'preserve.ts', summary: 'seed-summary' }],
                });
                assert.ok(!summaryResult.isError);
                const summaryData = parseResult(summaryResult);
                assert.equal(summaryData.updated, 1);
                const seededRow = db.get(`SELECT content_md5, summary, summary_updated_at FROM file_registry WHERE path = ?`, ['preserve.ts']);
                assert.ok(seededRow, 'row should exist after update_summaries');
                const seededMd5 = seededRow.content_md5;
                assert.ok(typeof seededMd5 === 'string' && seededMd5.length > 0, 'content_md5 should be set');
                await call(tools.handlers, 'file_registry_upsert', {
                    path: 'preserve.ts',
                    type: 'source',
                    language: 'typescript',
                    metadata: { touched: true },
                });
                const afterRow = db.get(`SELECT content_md5, summary, summary_updated_at FROM file_registry WHERE path = ?`, ['preserve.ts']);
                assert.ok(afterRow, 'row should still exist after upsert');
                assert.equal(afterRow.content_md5, seededMd5, 'content_md5 must not be clobbered by upsert');
                assert.equal(afterRow.summary, 'seed-summary', 'summary must not be clobbered by upsert');
                assert.ok(afterRow.summary_updated_at !== null, 'summary_updated_at must remain non-null');
                db.close();
            }
            finally {
                process.chdir(cwdPrev);
            }
        });
    });
    describe('file_registry_upsert validation', () => {
        it('rejects missing path', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_upsert', { type: 'source' });
            assert.ok(result.isError);
            assert.match(parseResult(result).error, /path/i);
            db.close();
        });
        it('rejects empty path', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_upsert', { path: '', type: 'source' });
            assert.ok(result.isError);
            assert.match(parseResult(result).error, /path/i);
            db.close();
        });
        it('rejects path exceeding 1024 chars', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_upsert', {
                path: 'a'.repeat(1025),
                type: 'source',
            });
            assert.ok(result.isError);
            assert.match(parseResult(result).error, /1024/);
            db.close();
        });
        it('accepts path exactly 1024 chars', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_upsert', {
                path: 'a'.repeat(1024),
                type: 'source',
            });
            assert.ok(!result.isError);
            db.close();
        });
        it('rejects path with .. traversal segment', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_upsert', {
                path: 'src/../etc/passwd',
                type: 'source',
            });
            assert.ok(result.isError);
            assert.match(parseResult(result).error, /traversal/i);
            db.close();
        });
        it('rejects invalid type', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_upsert', {
                path: 'src/x.ts',
                type: 'binary',
            });
            assert.ok(result.isError);
            assert.match(parseResult(result).error, /Invalid type/);
            db.close();
        });
        it('accepts all valid types', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            for (const type of ['source', 'test', 'config', 'doc', 'unknown']) {
                const result = await call(tools.handlers, 'file_registry_upsert', {
                    path: `file-${type}.ts`,
                    type,
                });
                assert.ok(!result.isError, `type ${type} should be valid`);
            }
            db.close();
        });
    });
    describe('file_registry_list', () => {
        it('list with no filters returns all rows', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            await call(tools.handlers, 'file_registry_upsert', { path: 'a.ts', type: 'source' });
            await call(tools.handlers, 'file_registry_upsert', { path: 'b.test.ts', type: 'test' });
            await call(tools.handlers, 'file_registry_upsert', { path: 'tsconfig.json', type: 'config' });
            const result = await call(tools.handlers, 'file_registry_list', {});
            assert.ok(!result.isError);
            const data = parseResult(result);
            assert.equal(data.count, 3);
            assert.equal(data.total, 3);
            assert.equal(data.rows.length, 3);
            db.close();
        });
        it('list with type=source returns only source rows', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            await call(tools.handlers, 'file_registry_upsert', { path: 'a.ts', type: 'source' });
            await call(tools.handlers, 'file_registry_upsert', { path: 'b.test.ts', type: 'test' });
            await call(tools.handlers, 'file_registry_upsert', { path: 'c.ts', type: 'source' });
            const result = await call(tools.handlers, 'file_registry_list', { type: 'source' });
            assert.ok(!result.isError);
            const data = parseResult(result);
            assert.equal(data.count, 2);
            assert.equal(data.total, 2);
            assert.ok(data.rows.every((r) => r.type === 'source'));
            db.close();
        });
        it('list with limit paginates correctly', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            for (let i = 0; i < 5; i++) {
                await call(tools.handlers, 'file_registry_upsert', { path: `file${i}.ts`, type: 'source' });
            }
            const result = await call(tools.handlers, 'file_registry_list', { limit: 2, offset: 0 });
            assert.ok(!result.isError);
            const data = parseResult(result);
            assert.equal(data.count, 2);
            assert.equal(data.total, 5);
            db.close();
        });
        it('list with offset skips rows', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            for (let i = 0; i < 3; i++) {
                await call(tools.handlers, 'file_registry_upsert', { path: `f${i}.ts`, type: 'source' });
            }
            const result = await call(tools.handlers, 'file_registry_list', { limit: 10, offset: 2 });
            assert.ok(!result.isError);
            const data = parseResult(result);
            assert.equal(data.count, 1);
            assert.equal(data.total, 3);
            db.close();
        });
        it('list on empty table returns empty rows with count=0', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_list', {});
            assert.ok(!result.isError);
            const data = parseResult(result);
            assert.equal(data.count, 0);
            assert.equal(data.total, 0);
            assert.deepEqual(data.rows, []);
            db.close();
        });
        it('list rejects invalid type filter', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_list', { type: 'invalid' });
            assert.ok(result.isError);
            assert.match(parseResult(result).error, /Invalid type/);
            db.close();
        });
        it('list clamps limit to MAX_LIMIT (5000)', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_list', { limit: 99999 });
            assert.ok(!result.isError);
            db.close();
        });
    });
    describe('file_registry_delete', () => {
        it('delete returns { deleted: 0 } for non-existent path', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_delete', { path: 'nonexistent.ts' });
            assert.ok(!result.isError);
            assert.deepEqual(parseResult(result), { deleted: 0 });
            db.close();
        });
        it('delete returns { deleted: 1 } after successful upsert then delete', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            await call(tools.handlers, 'file_registry_upsert', { path: 'to-delete.ts', type: 'source' });
            const result = await call(tools.handlers, 'file_registry_delete', { path: 'to-delete.ts' });
            assert.ok(!result.isError);
            assert.deepEqual(parseResult(result), { deleted: 1 });
            const row = db.get('SELECT * FROM file_registry WHERE path = ?', ['to-delete.ts']);
            assert.equal(row, undefined, 'row must be gone after delete');
            db.close();
        });
        it('delete then list shows row is gone', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            await call(tools.handlers, 'file_registry_upsert', { path: 'keep.ts', type: 'source' });
            await call(tools.handlers, 'file_registry_upsert', { path: 'gone.ts', type: 'test' });
            await call(tools.handlers, 'file_registry_delete', { path: 'gone.ts' });
            const result = await call(tools.handlers, 'file_registry_list', {});
            const data = parseResult(result);
            assert.equal(data.count, 1);
            assert.equal(data.rows[0].path, 'keep.ts');
            db.close();
        });
        it('delete rejects empty path', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_delete', { path: '' });
            assert.ok(result.isError);
            assert.match(parseResult(result).error, /path/i);
            db.close();
        });
        it('delete rejects path with .. traversal', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_delete', { path: '../etc/shadow' });
            assert.ok(result.isError);
            assert.match(parseResult(result).error, /traversal/i);
            db.close();
        });
        it('rename is delete old + upsert new', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            await call(tools.handlers, 'file_registry_upsert', {
                path: 'old-name.ts',
                type: 'source',
            });
            await call(tools.handlers, 'file_registry_delete', { path: 'old-name.ts' });
            await call(tools.handlers, 'file_registry_upsert', {
                path: 'new-name.ts',
                type: 'source',
            });
            const result = await call(tools.handlers, 'file_registry_list', {});
            const data = parseResult(result);
            assert.equal(data.count, 1);
            assert.equal(data.rows[0].path, 'new-name.ts');
            db.close();
        });
    });
    describe('file_registry_verify (#45)', () => {
        it('returns "match" for a row whose md5 matches disk', async () => {
            const { mkdtempSync, writeFileSync } = await import('node:fs');
            const { tmpdir } = await import('node:os');
            const { join } = await import('node:path');
            const dir = mkdtempSync(join(tmpdir(), 'frv-'));
            const cwdPrev = process.cwd();
            process.chdir(dir);
            try {
                writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
                const db = tempDB();
                const tools = fileRegistryTools(db);
                await call(tools.handlers, 'file_registry_update_summaries', {
                    updates: [{ path: 'a.ts', summary: 'one export' }],
                });
                const result = await call(tools.handlers, 'file_registry_verify', {});
                assert.ok(!result.isError);
                const data = parseResult(result);
                assert.equal(data.verdicts.length, 1);
                assert.equal(data.verdicts[0].path, 'a.ts');
                assert.equal(data.verdicts[0].verdict, 'match');
                db.close();
            }
            finally {
                process.chdir(cwdPrev);
            }
        });
        it('returns "mismatch" when disk content drifts from stored md5', async () => {
            const { mkdtempSync, writeFileSync } = await import('node:fs');
            const { tmpdir } = await import('node:os');
            const { join } = await import('node:path');
            const dir = mkdtempSync(join(tmpdir(), 'frv-'));
            const cwdPrev = process.cwd();
            process.chdir(dir);
            try {
                writeFileSync(join(dir, 'a.ts'), 'v1');
                const db = tempDB();
                const tools = fileRegistryTools(db);
                await call(tools.handlers, 'file_registry_update_summaries', {
                    updates: [{ path: 'a.ts', summary: 's' }],
                });
                writeFileSync(join(dir, 'a.ts'), 'v2-different');
                const result = await call(tools.handlers, 'file_registry_verify', {});
                const data = parseResult(result);
                assert.equal(data.verdicts[0].verdict, 'mismatch');
                assert.ok(typeof data.verdicts[0].current_md5 === 'string');
                db.close();
            }
            finally {
                process.chdir(cwdPrev);
            }
        });
        it('returns "missing" when registry row exists but file is gone', async () => {
            const { mkdtempSync, writeFileSync, unlinkSync } = await import('node:fs');
            const { tmpdir } = await import('node:os');
            const { join } = await import('node:path');
            const dir = mkdtempSync(join(tmpdir(), 'frv-'));
            const cwdPrev = process.cwd();
            process.chdir(dir);
            try {
                writeFileSync(join(dir, 'a.ts'), 'x');
                const db = tempDB();
                const tools = fileRegistryTools(db);
                await call(tools.handlers, 'file_registry_update_summaries', {
                    updates: [{ path: 'a.ts', summary: 's' }],
                });
                unlinkSync(join(dir, 'a.ts'));
                const result = await call(tools.handlers, 'file_registry_verify', {});
                const data = parseResult(result);
                assert.equal(data.verdicts[0].verdict, 'missing');
                db.close();
            }
            finally {
                process.chdir(cwdPrev);
            }
        });
        it('returns "new" when input paths include a file not in registry', async () => {
            const { mkdtempSync, writeFileSync } = await import('node:fs');
            const { tmpdir } = await import('node:os');
            const { join } = await import('node:path');
            const dir = mkdtempSync(join(tmpdir(), 'frv-'));
            const cwdPrev = process.cwd();
            process.chdir(dir);
            try {
                writeFileSync(join(dir, 'a.ts'), 'x');
                writeFileSync(join(dir, 'b.ts'), 'y');
                const db = tempDB();
                const tools = fileRegistryTools(db);
                await call(tools.handlers, 'file_registry_update_summaries', {
                    updates: [{ path: 'a.ts', summary: 's' }],
                });
                const result = await call(tools.handlers, 'file_registry_verify', {
                    paths: ['a.ts', 'b.ts'],
                });
                const data = parseResult(result);
                const byPath = Object.fromEntries(data.verdicts.map((v) => [v.path, v.verdict]));
                assert.equal(byPath['a.ts'], 'match');
                assert.equal(byPath['b.ts'], 'new');
                db.close();
            }
            finally {
                process.chdir(cwdPrev);
            }
        });
    });
    describe('file_registry_update_summaries multi-repo path resolution', () => {
        it('update_summaries with repo resolves path under named repo root and writes non-empty repo to DB', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'frmr-'));
            const appDir = join(tmpDir, 'app');
            const serviceDir = join(tmpDir, 'service');
            execFileSync('mkdir', ['-p', join(appDir, 'src')]);
            execFileSync('mkdir', ['-p', serviceDir]);
            writeFileSync(join(appDir, 'src', 'index.ts'), 'export const x = 1;\n');
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [appDir]);
            db.run(`INSERT INTO repos (name, path) VALUES ('service', ?)`, [serviceDir]);
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_update_summaries', {
                updates: [{ path: 'src/index.ts', summary: 'app index', repo: 'app' }],
            });
            assert.ok(!result.isError);
            const data = parseResult(result);
            assert.equal(data.updated, 1);
            assert.deepEqual(data.errors, []);
            const row = db.get(`SELECT repo, path, summary FROM file_registry WHERE summary = 'app index'`);
            assert.ok(row, 'row must exist in file_registry');
            assert.equal(row.repo, 'app', 'repo column must be non-empty and match the named repo');
            assert.equal(row.path, 'src/index.ts');
            db.close();
        });
        it('update_summaries with omitted repo and tmb_default_repo set resolves via default repo', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'frmr-'));
            const appDir = join(tmpDir, 'app');
            const serviceDir = join(tmpDir, 'service');
            execFileSync('mkdir', ['-p', appDir]);
            execFileSync('mkdir', ['-p', join(serviceDir, 'lib')]);
            writeFileSync(join(serviceDir, 'lib', 'core.ts'), 'export const core = true;\n');
            const dbPath = join(tmpDir, '.claude', 'tmb', 'trajectory.db');
            execFileSync('mkdir', ['-p', join(tmpDir, '.claude', 'tmb')]);
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [appDir]);
            db.run(`INSERT INTO repos (name, path) VALUES ('service', ?)`, [serviceDir]);
            db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"service"')`);
            const tools = fileRegistryTools(db, dbPath);
            const result = await call(tools.handlers, 'file_registry_update_summaries', {
                updates: [{ path: 'lib/core.ts', summary: 'core service module' }],
            });
            assert.ok(!result.isError);
            const data = parseResult(result);
            assert.equal(data.updated, 1);
            assert.deepEqual(data.errors, []);
            const row = db.get(`SELECT repo, path, summary FROM file_registry WHERE summary = 'core service module'`);
            assert.ok(row, 'row must exist in file_registry');
            assert.equal(row.repo, 'service', 'repo must match tmb_default_repo');
            db.close();
        });
        it('update_summaries with omitted repo and unset tmb_default_repo returns clear error naming both options', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'frmr-'));
            const appDir = join(tmpDir, 'app');
            const serviceDir = join(tmpDir, 'service');
            execFileSync('mkdir', ['-p', appDir]);
            execFileSync('mkdir', ['-p', serviceDir]);
            const dbPath = join(tmpDir, '.claude', 'tmb', 'trajectory.db');
            execFileSync('mkdir', ['-p', join(tmpDir, '.claude', 'tmb')]);
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [appDir]);
            db.run(`INSERT INTO repos (name, path) VALUES ('service', ?)`, [serviceDir]);
            const tools = fileRegistryTools(db, dbPath);
            const result = await call(tools.handlers, 'file_registry_update_summaries', {
                updates: [{ path: 'src/missing.ts', summary: 'something' }],
            });
            assert.ok(!result.isError, 'tool itself should not error — errors surface in the errors array');
            const data = parseResult(result);
            assert.equal(data.updated, 0);
            assert.equal(data.errors.length, 1);
            assert.match(data.errors[0].error, /tmb_default_repo/i, 'error must mention tmb_default_repo');
            assert.match(data.errors[0].error, /repo/i, 'error must mention the repo param option');
            db.close();
        });
    });
    describe('file_registry_update_summaries workspace-pattern regression (#177)', () => {
        it('resolves relative paths via tmb_default_repo when dbPath is provided (workspace pattern)', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'frws-'));
            const appDir = join(tmpDir, 'app');
            const fooDir = join(appDir, 'foo');
            execFileSync('mkdir', ['-p', fooDir]);
            writeFileSync(join(fooDir, 'bar.txt'), 'workspace-content\n');
            const dbPath = join(tmpDir, '.claude', 'tmb', 'trajectory.db');
            execFileSync('mkdir', ['-p', join(tmpDir, '.claude', 'tmb')]);
            const db = tempDB();
            db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"app"')`);
            const tools = fileRegistryTools(db, dbPath);
            const result = await call(tools.handlers, 'file_registry_update_summaries', {
                updates: [{ path: 'foo/bar.txt', summary: 'test' }],
            });
            assert.ok(!result.isError);
            const data = parseResult(result);
            assert.equal(data.updated, 1);
            assert.deepEqual(data.errors, []);
            db.close();
        });
    });
    describe('file_registry_update_summaries (#45)', () => {
        it('writes content_md5 + summary + summary_updated_at and advances last_verified_sha', async () => {
            const { mkdtempSync, writeFileSync } = await import('node:fs');
            const { tmpdir } = await import('node:os');
            const { join } = await import('node:path');
            const dir = mkdtempSync(join(tmpdir(), 'frus-'));
            const cwdPrev = process.cwd();
            process.chdir(dir);
            try {
                writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
                const db = tempDB();
                const tools = fileRegistryTools(db);
                const result = await call(tools.handlers, 'file_registry_update_summaries', {
                    updates: [{ path: 'a.ts', summary: 'one export' }],
                    advance_verified_sha: 'abc123',
                });
                assert.ok(!result.isError);
                const data = parseResult(result);
                assert.equal(data.updated, 1);
                assert.equal(data.advance_verified_sha, 'abc123');
                const row = db.get('SELECT content_md5, summary, summary_updated_at FROM file_registry WHERE path = ?', ['a.ts']);
                assert.ok(row);
                assert.ok(row.content_md5.length === 32);
                assert.equal(row.summary, 'one export');
                const cfg = db.get("SELECT value_json FROM plugin_config WHERE key = 'last_verified_sha'");
                assert.equal(cfg?.value_json, '"abc123"');
                db.close();
            }
            finally {
                process.chdir(cwdPrev);
            }
        });
        it('is forbidden for non-bro agents (pr-reviewer + swe — #181 reassigned ownership to bro alone)', async () => {
            for (const agent of ['pr-reviewer', 'swe']) {
                const db = tempDB();
                const tools = fileRegistryTools(db);
                const result = await call(tools.handlers, 'file_registry_update_summaries', {
                    agent,
                    updates: [{ path: 'a.ts', summary: 'x' }],
                });
                assert.ok(result.isError, `${agent} should be forbidden`);
                assert.match(parseResult(result).error, /forbidden/i);
                db.close();
            }
        });
        it('reads md5 from git commit when file lives in a worktree (not at project root)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'frus-wt-'));
            const cwdPrev = process.cwd();
            process.chdir(dir);
            try {
                execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
                execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: dir });
                execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
                writeFileSync(join(dir, 'README.md'), 'init\n');
                execFileSync('git', ['add', '.'], { cwd: dir });
                execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
                const wtDir = join(dir, '.claude', 'worktrees', 'task-99');
                execFileSync('git', ['branch', 'fix/wt-task', 'HEAD'], { cwd: dir });
                execFileSync('git', ['worktree', 'add', wtDir, 'fix/wt-task'], { cwd: dir });
                const wtSrc = join(wtDir, 'src');
                execFileSync('mkdir', ['-p', wtSrc]);
                const fileContents = 'export const note = "from-worktree";\n';
                writeFileSync(join(wtSrc, 'foo.ts'), fileContents);
                execFileSync('git', ['add', '.'], { cwd: wtDir });
                execFileSync('git', ['commit', '-qm', 'feat: add foo'], { cwd: wtDir });
                const commitSha = execFileSync('git', ['-C', wtDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
                const db = tempDB();
                const tools = fileRegistryTools(db);
                const result = await call(tools.handlers, 'file_registry_update_summaries', {
                    updates: [{ path: 'src/foo.ts', summary: 'note constant' }],
                    advance_verified_sha: commitSha,
                });
                assert.ok(!result.isError);
                const data = parseResult(result);
                assert.equal(data.updated, 1, 'should have updated 1 row');
                assert.deepEqual(data.errors, [], 'no errors expected');
                const row = db.get('SELECT content_md5, summary FROM file_registry WHERE path = ?', ['src/foo.ts']);
                assert.ok(row, 'row should exist');
                assert.equal(row.content_md5.length, 32, 'md5 should be populated');
                assert.equal(row.content_md5, createHash('md5').update(fileContents).digest('hex'), 'md5 should match worktree-committed content');
                assert.equal(row.summary, 'note constant');
                db.close();
            }
            finally {
                process.chdir(cwdPrev);
            }
        });
        it('reports error when file is in neither disk nor commit', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'frus-miss-'));
            const cwdPrev = process.cwd();
            process.chdir(dir);
            try {
                execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
                execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: dir });
                execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
                writeFileSync(join(dir, 'README.md'), 'init\n');
                execFileSync('git', ['add', '.'], { cwd: dir });
                execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
                const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
                const db = tempDB();
                const tools = fileRegistryTools(db);
                const result = await call(tools.handlers, 'file_registry_update_summaries', {
                    updates: [{ path: 'src/nonexistent.ts', summary: 'x' }],
                    advance_verified_sha: headSha,
                });
                assert.ok(!result.isError);
                const data = parseResult(result);
                assert.equal(data.updated, 0, 'no rows inserted');
                assert.equal(data.errors.length, 1);
                assert.match(data.errors[0].error, /not found.*commit/i);
                db.close();
            }
            finally {
                process.chdir(cwdPrev);
            }
        });
    });
    describe('file_registry_update_summaries absolute path normalization', () => {
        it('normalizes absolute path to relative when matching repo exists', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'frab-'));
            const repoRoot = join(tmpDir, 'myrepo');
            execFileSync('mkdir', ['-p', join(repoRoot, 'src')]);
            writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const x = 1;\n');
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path) VALUES ('myrepo', ?)`, [repoRoot]);
            const tools = fileRegistryTools(db);
            const absPath = join(repoRoot, 'src', 'index.ts');
            const result = await call(tools.handlers, 'file_registry_update_summaries', {
                updates: [{ path: absPath, summary: 'absolute path test', repo: 'myrepo' }],
            });
            assert.ok(!result.isError, `expected ok, got: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.equal(data.updated, 1);
            assert.deepEqual(data.errors, []);
            const row = db.get(`SELECT path, summary FROM file_registry WHERE summary = 'absolute path test'`);
            assert.ok(row, 'row must exist');
            assert.equal(row.path, 'src/index.ts', 'absolute path must be normalized to relative');
            db.close();
        });
        it('keeps absolute path as-is when no repo matches (logs warning)', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'frab-nomatch-'));
            const repoRoot = join(tmpDir, 'myrepo');
            execFileSync('mkdir', ['-p', repoRoot]);
            const unrelatedRoot = join(tmpDir, 'other');
            execFileSync('mkdir', ['-p', join(unrelatedRoot, 'src')]);
            writeFileSync(join(unrelatedRoot, 'src', 'file.ts'), 'content\n');
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path) VALUES ('myrepo', ?)`, [repoRoot]);
            const tools = fileRegistryTools(db, join(tmpDir, 'trajectory.db'));
            db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"myrepo"')`);
            const absPath = join(unrelatedRoot, 'src', 'file.ts');
            const result = await call(tools.handlers, 'file_registry_update_summaries', {
                updates: [{ path: absPath, summary: 'unmatched abs path', repo: 'myrepo' }],
            });
            assert.ok(!result.isError, `expected ok, got: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.equal(data.updated, 1);
            const row = db.get(`SELECT path, summary FROM file_registry WHERE summary = 'unmatched abs path'`);
            assert.ok(row, 'row must exist');
            assert.equal(row.path, absPath, 'unmatched absolute path kept as-is');
            db.close();
        });
        it('relative path passes through unchanged', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'frab-rel-'));
            const repoRoot = join(tmpDir, 'myrepo');
            execFileSync('mkdir', ['-p', join(repoRoot, 'src')]);
            writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const x = 1;\n');
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path) VALUES ('myrepo', ?)`, [repoRoot]);
            const tools = fileRegistryTools(db);
            const result = await call(tools.handlers, 'file_registry_update_summaries', {
                updates: [{ path: 'src/index.ts', summary: 'relative path test', repo: 'myrepo' }],
            });
            assert.ok(!result.isError, `expected ok, got: ${JSON.stringify(parseResult(result))}`);
            const data = parseResult(result);
            assert.equal(data.updated, 1);
            const row = db.get(`SELECT path, summary FROM file_registry WHERE summary = 'relative path test'`);
            assert.ok(row, 'row must exist');
            assert.equal(row.path, 'src/index.ts', 'relative path must remain unchanged');
            db.close();
        });
    });
    describe('multi-repo isolation (repo filter on delete + verify)', () => {
        it('file_registry_delete with repo=repoA does not affect row with repo=repoB and same path', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            await call(tools.handlers, 'file_registry_upsert', { path: 'shared.ts', type: 'source', repo: 'repoA' });
            await call(tools.handlers, 'file_registry_upsert', { path: 'shared.ts', type: 'source', repo: 'repoB' });
            const deleteResult = await call(tools.handlers, 'file_registry_delete', { path: 'shared.ts', repo: 'repoA' });
            assert.ok(!deleteResult.isError);
            assert.deepEqual(parseResult(deleteResult), { deleted: 1 });
            const rowA = db.get(`SELECT repo, path FROM file_registry WHERE repo = 'repoA' AND path = 'shared.ts'`);
            assert.equal(rowA, undefined, 'repoA row must be deleted');
            const rowB = db.get(`SELECT repo, path FROM file_registry WHERE repo = 'repoB' AND path = 'shared.ts'`);
            assert.ok(rowB !== undefined, 'repoB row must survive');
            assert.equal(rowB?.path, 'shared.ts');
            db.close();
        });
        it('file_registry_verify with repo filter returns only results for that repo', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            db.run(`INSERT INTO file_registry (repo, path, type, content_md5, summary, summary_updated_at)
         VALUES ('repoA', 'src/a.ts', 'source', NULL, NULL, NULL)`);
            db.run(`INSERT INTO file_registry (repo, path, type, content_md5, summary, summary_updated_at)
         VALUES ('repoB', 'src/b.ts', 'source', NULL, NULL, NULL)`);
            const verifyResult = await call(tools.handlers, 'file_registry_verify', { repo: 'repoA' });
            assert.ok(!verifyResult.isError, `Expected no error: ${JSON.stringify(parseResult(verifyResult))}`);
            const data = parseResult(verifyResult);
            assert.equal(data.count, 1, 'verify with repo=repoA must return 1 verdict');
            assert.equal(data.verdicts[0].repo, 'repoA');
            assert.equal(data.verdicts[0].path, 'src/a.ts');
            db.close();
        });
        it('file_registry_verify without repo filter returns results keyed by repo', async () => {
            const db = tempDB();
            const tools = fileRegistryTools(db);
            db.run(`INSERT INTO file_registry (repo, path, type, content_md5, summary, summary_updated_at)
         VALUES ('repoA', 'src/a.ts', 'source', NULL, NULL, NULL)`);
            db.run(`INSERT INTO file_registry (repo, path, type, content_md5, summary, summary_updated_at)
         VALUES ('repoB', 'src/b.ts', 'source', NULL, NULL, NULL)`);
            const verifyResult = await call(tools.handlers, 'file_registry_verify', {});
            assert.ok(!verifyResult.isError);
            const data = parseResult(verifyResult);
            assert.equal(data.count, 2, 'verify without repo filter must return verdicts for all repos');
            const repos = data.verdicts.map((v) => v.repo);
            assert.ok(repos.includes('repoA'), 'must include repoA');
            assert.ok(repos.includes('repoB'), 'must include repoB');
            db.close();
        });
    });
});
//# sourceMappingURL=file-registry.test.js.map