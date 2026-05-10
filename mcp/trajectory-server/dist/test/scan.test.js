import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDB } from './helpers.js';
import { scanTools } from '../tools/scan.js';
function parse(r) {
    return JSON.parse(r.content[0].text);
}
async function call(handlers, name, args) {
    const h = handlers[name];
    assert.ok(h, `handler not found: ${name}`);
    return h(args);
}
function mkRepo(parent, name, files) {
    const root = join(parent, name);
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    for (const [path, body] of Object.entries(files)) {
        const full = join(root, path);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, body);
    }
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    return root;
}
describe('scan_run — workspace discovery + persistence', () => {
    it('discovers multiple inner repos under a non-git workspace, persists repos + file_registry', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-test-'));
        try {
            mkRepo(ws, 'app', { 'src/main.py': 'def main():\n    pass\n', 'README.md': 'app\n' });
            mkRepo(ws, 'lib', { 'core.ts': 'export const x = 1;\n' });
            const db = tempDB();
            const tools = scanTools(db);
            const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            assert.ok(!result.isError, `scan_run failed: ${JSON.stringify(result)}`);
            const repoNames = db
                .all('SELECT name FROM repos ORDER BY name')
                .map((r) => r.name);
            assert.deepEqual(repoNames, ['app', 'lib']);
            const fileCount = db.get('SELECT COUNT(*) as c FROM file_registry')?.c ?? 0;
            assert.ok(fileCount >= 3, `expected ≥3 files, got ${fileCount}`);
            const appMain = db.get(`SELECT content_md5, last_commit_sha FROM file_registry WHERE repo='app' AND path='src/main.py'`);
            assert.ok(appMain, 'src/main.py row should exist');
            assert.equal(appMain.content_md5.length, 32, 'md5 should be populated');
            assert.equal(appMain.last_commit_sha.length, 40, 'last_commit_sha should be populated');
            const auditRow = db.get(`SELECT event_type FROM audit WHERE event_type='deep_scan_completed' ORDER BY id DESC LIMIT 1`);
            assert.ok(auditRow, 'deep_scan_completed audit row should exist');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('preserves summary on rescan when md5 unchanged; clears summary when md5 changes', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-md5-'));
        try {
            const repo = mkRepo(ws, 'r', { 'a.txt': 'aaa\n' });
            const db = tempDB();
            const tools = scanTools(db);
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            // Plant a summary on the only file.
            db.run(`UPDATE file_registry SET summary='owned-by-test', summary_updated_at='2026-01-01' WHERE repo='r' AND path='a.txt'`);
            // Rescan unchanged content — summary must persist.
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            const afterClean = db.get(`SELECT summary FROM file_registry WHERE repo='r' AND path='a.txt'`);
            assert.equal(afterClean?.summary, 'owned-by-test', 'summary preserved when md5 unchanged');
            // Mutate the file. Rescan must clear the now-stale summary.
            writeFileSync(join(repo, 'a.txt'), 'bbb\n');
            execFileSync('git', ['add', '.'], { cwd: repo });
            execFileSync('git', ['commit', '-qm', 'mutate'], { cwd: repo });
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            const afterChange = db.get(`SELECT summary FROM file_registry WHERE repo='r' AND path='a.txt'`);
            assert.equal(afterChange?.summary, null, 'summary cleared when md5 changes');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('sets tmb_default_repo on first scan if not already configured', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-default-'));
        try {
            mkRepo(ws, 'plugin', { 'README.md': 'p\n' });
            const db = tempDB();
            const tools = scanTools(db);
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            const cfg = db.get(`SELECT value_json FROM plugin_config WHERE key='tmb_default_repo'`);
            assert.ok(cfg, 'tmb_default_repo should be set');
            assert.equal(cfg.value_json, '"plugin"');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('repos_list returns rows ordered by name', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-list-'));
        try {
            mkRepo(ws, 'beta', { 'a.txt': 'a\n' });
            mkRepo(ws, 'alpha', { 'a.txt': 'a\n' });
            const db = tempDB();
            const tools = scanTools(db);
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            const result = await call(tools.handlers, 'repos_list', { agent: 'bro' });
            assert.ok(!result.isError);
            const data = parse(result);
            assert.deepEqual(data.repos.map((r) => r.name), ['alpha', 'beta']);
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=scan.test.js.map