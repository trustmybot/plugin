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
    it('discovers multiple inner repos under a non-git workspace, persists repos + directories', async () => {
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
            const dirCount = db.get('SELECT COUNT(*) as c FROM directories')?.c ?? 0;
            assert.ok(dirCount >= 2, `expected ≥2 directory rows (one per repo root), got ${dirCount}`);
            const appRoot = db.get(`SELECT summary, summary_source FROM directories WHERE repo='app' AND path=''`);
            assert.ok(appRoot, 'app repo root directory row should exist');
            assert.equal(appRoot.summary_source, 'readme', 'app README.md should drive summary');
            assert.ok(appRoot.summary?.includes('app'), 'app summary should reflect README content');
            const auditRow = db.get(`SELECT event_type FROM audit WHERE event_type='deep_scan_completed' ORDER BY id DESC LIMIT 1`);
            assert.ok(auditRow, 'deep_scan_completed audit row should exist');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('preserves dir summary on rescan when README unchanged; refreshes when README changes', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-md5-'));
        try {
            const repo = mkRepo(ws, 'r', { 'a.txt': 'aaa\n', 'README.md': 'first version\n' });
            const db = tempDB();
            const tools = scanTools(db);
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            const firstSummary = db.get(`SELECT summary FROM directories WHERE repo='r' AND path=''`)?.summary;
            assert.ok(firstSummary?.includes('first version'), 'first summary from README');
            // Re-scan unchanged content — summary stays.
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            const afterClean = db.get(`SELECT summary FROM directories WHERE repo='r' AND path=''`);
            assert.ok(afterClean?.summary?.includes('first version'), 'summary preserved when README unchanged');
            // Mutate README. Re-scan must refresh dir summary.
            writeFileSync(join(repo, 'README.md'), 'second version\n');
            execFileSync('git', ['add', '.'], { cwd: repo });
            execFileSync('git', ['commit', '-qm', 'mutate'], { cwd: repo });
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            const afterChange = db.get(`SELECT summary FROM directories WHERE repo='r' AND path=''`);
            assert.ok(afterChange?.summary?.includes('second version'), 'summary refreshed from new README');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('sets tmb_default_repo on first scan if not already configured', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-default-'));
        try {
            mkRepo(ws, 'repo-c', { 'README.md': 'p\n' });
            const db = tempDB();
            const tools = scanTools(db);
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            const cfg = db.get(`SELECT value_json FROM plugin_config WHERE key='tmb_default_repo'`);
            assert.ok(cfg, 'tmb_default_repo should be set');
            assert.equal(cfg.value_json, "\"repo-c\"");
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    // #2885: workspace-pattern with multiple sibling repos. Old behaviour picked
    // repos[0] alphabetically, so a user launching from ~/Git/GitHub/TMB/plugin
    // got tmb_default_repo='repo-a' just because it sorted first. New
    // behaviour: prefer the repo whose path encloses session_dir.
    it('prefers the cwd-enclosing repo as tmb_default_repo, not alphabetical-first (#2885)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-prefer-'));
        try {
            // Three sibling repos. Alphabetical-first is 'repo-a' (placeholder names — must be sorted alphabetically to test the bug correctly).
            mkRepo(ws, 'repo-a', { 'README.md': 'e\n' });
            mkRepo(ws, 'repo-b', { 'README.md': 'm\n' });
            mkRepo(ws, 'repo-c', { 'README.md': 'p\n' });
            const db = tempDB();
            const tools = scanTools(db);
            // Scan from inside the 'repo-c' subdir — user clearly working there.
            await call(tools.handlers, 'scan_run', {
                agent: 'bro',
                session_dir: join(ws, 'repo-c'),
            });
            const cfg = db.get(`SELECT value_json FROM plugin_config WHERE key='tmb_default_repo'`);
            assert.ok(cfg, 'tmb_default_repo should be set');
            assert.equal(cfg.value_json, '"repo-c"', 'cwd-enclosing repo wins over alphabetical-first');
            db.close();
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
    it('falls back to alphabetical when session_dir encloses no repo (#2885 edge case)', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'scan-fallback-'));
        try {
            mkRepo(ws, 'repo-a', { 'README.md': 'e\n' });
            mkRepo(ws, 'repo-c', { 'README.md': 'p\n' });
            const db = tempDB();
            const tools = scanTools(db);
            // Scan from the workspace ROOT (above both repos). No enclosing repo —
            // alphabetical fallback applies.
            await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
            const cfg = db.get(`SELECT value_json FROM plugin_config WHERE key='tmb_default_repo'`);
            assert.ok(cfg);
            assert.equal(cfg.value_json, '"repo-a"');
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
    // #2881: scan_run accepts a `source` arg + enriches the deep_scan_completed
    // audit content_json with source / structural_change / repos_seen / top_dirs.
    describe('scan_run source + audit enrichment (#2881)', () => {
        it('persists source=user_manual in audit content_json when caller passes it', async () => {
            const ws = mkdtempSync(join(tmpdir(), 'scan-src-'));
            try {
                mkRepo(ws, 'app', { 'a.txt': 'a\n' });
                const db = tempDB();
                const tools = scanTools(db);
                const result = await call(tools.handlers, 'scan_run', {
                    agent: 'bro',
                    session_dir: ws,
                    source: 'user_manual',
                });
                assert.ok(!result.isError);
                const data = parse(result);
                assert.equal(data.source, 'user_manual');
                const audit = db.get(`SELECT content_json FROM audit WHERE event_type = 'deep_scan_completed' ORDER BY id DESC LIMIT 1`);
                assert.ok(audit);
                const parsedAudit = JSON.parse(audit.content_json);
                assert.equal(parsedAudit.source, 'user_manual');
                assert.ok(Array.isArray(parsedAudit.repos_seen));
                assert.ok(Array.isArray(parsedAudit.top_dirs));
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('defaults source to bro_auto_initial when caller omits it', async () => {
            const ws = mkdtempSync(join(tmpdir(), 'scan-src-default-'));
            try {
                mkRepo(ws, 'app', { 'a.txt': 'a\n' });
                const db = tempDB();
                const tools = scanTools(db);
                const result = await call(tools.handlers, 'scan_run', {
                    agent: 'bro',
                    session_dir: ws,
                });
                const data = parse(result);
                assert.equal(data.source, 'bro_auto_initial');
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('rejects unknown source value by falling back to bro_auto_initial', async () => {
            const ws = mkdtempSync(join(tmpdir(), 'scan-src-bad-'));
            try {
                mkRepo(ws, 'app', { 'a.txt': 'a\n' });
                const db = tempDB();
                const tools = scanTools(db);
                const result = await call(tools.handlers, 'scan_run', {
                    agent: 'bro',
                    session_dir: ws,
                    source: 'definitely-not-a-real-value',
                });
                const data = parse(result);
                assert.equal(data.source, 'bro_auto_initial');
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('flags structural_change=true on the first scan ever (no prior audit row)', async () => {
            const ws = mkdtempSync(join(tmpdir(), 'scan-struct-first-'));
            try {
                mkRepo(ws, 'app', { 'a.txt': 'a\n' });
                const db = tempDB();
                const tools = scanTools(db);
                const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
                const data = parse(result);
                assert.equal(data.structural_change, true);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('flags structural_change=false on an immediate rescan with no shape changes', async () => {
            const ws = mkdtempSync(join(tmpdir(), 'scan-struct-stable-'));
            try {
                mkRepo(ws, 'app', { 'src/main.py': 'p\n' });
                const db = tempDB();
                const tools = scanTools(db);
                await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
                // Second scan — same repo, same files, same top-level dirs.
                const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
                const data = parse(result);
                assert.equal(data.structural_change, false);
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it('flags structural_change=true when a new top-level dir appears between scans', async () => {
            const ws = mkdtempSync(join(tmpdir(), 'scan-struct-newdir-'));
            try {
                mkRepo(ws, 'app', { 'src/main.py': 'p\n' });
                const db = tempDB();
                const tools = scanTools(db);
                await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
                // Add a new top-level dir + commit.
                const appDir = join(ws, 'app');
                mkdirSync(join(appDir, 'docs'));
                writeFileSync(join(appDir, 'docs', 'README.md'), 'docs\n');
                execFileSync('git', ['add', '.'], { cwd: appDir });
                execFileSync('git', ['commit', '-qm', 'add docs'], { cwd: appDir });
                const result = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
                const data = parse(result);
                assert.equal(data.structural_change, true, 'new top-level dir is a structural change');
                db.close();
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
    });
});
//# sourceMappingURL=scan.test.js.map