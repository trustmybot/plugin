/**
 * The orphan-scan gate end to end (GH 1692): a SessionStart gate that reports, and with TMB_ORPHAN_SCAN_CLEAN=1 cleans,
 * cross-upgrade TMB orphans scoped strictly to the current project. Another
 * project's stale-looking DB or pinned cache version is never reported or
 * touched. Each case builds a sandboxed HOME and project root and drives
 * `node dist/hooks.js orphan-scan` through TMB_ORPHAN_SCAN_HOME and
 * TMB_ORPHAN_SCAN_PROJECT_DIR. The process-tree cases spawn "Claude Code"
 * surrogates re-parented to init and run only where `ps` can list processes
 * (not inside the Claude Code Bash sandbox, GH 2334).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeSandbox, runGate } from './hook-sandbox.js';
const GATE = 'orphan-scan';
const PLUGIN_NAME = 'tmb';
const INPUT = '{"hook_event_name":"SessionStart"}';
const SRV_ARGV = 'node /x/mcp/trajectory-server/dist/index.js';
const PS_LISTS = spawnSync('ps', ['-o', 'pid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout?.trim() === String(process.pid);
const slugFor = (dir) => dir.replace(/[^A-Za-z0-9]+/g, '-');
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
/** A trajectory.db with plugin_meta at <version>; no version makes it 0-byte. */
function makeDb(path, version) {
    mkdirSync(dirname(path), { recursive: true });
    if (version === undefined) {
        writeFileSync(path, '');
        return;
    }
    const db = new DatabaseSync(path);
    try {
        db.exec(`CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, plugin_version TEXT NOT NULL);
       INSERT INTO plugin_meta (schema_version, plugin_version) VALUES (${version}, '0.0.0');`);
    }
    finally {
        db.close();
    }
}
const liveDbOf = (project) => join(project, '.claude', PLUGIN_NAME, 'trajectory.db');
const historyDbOf = (home, project) => join(home, '.claude/projects', slugFor(project), 'trajectory.db');
/** A live project DB at schema 26 and a 0-byte stale DB in its history dir. */
function buildSandbox(home, project) {
    mkdirSync(join(home, '.claude/plugins/cache'), { recursive: true });
    mkdirSync(join(home, '.claude/projects'), { recursive: true });
    makeDb(liveDbOf(project), 26);
    makeDb(historyDbOf(home, project));
}
/**
 * Starts a detached "CC" process whose argv0 is <cc>, with a trajectory-server
 * child and a hook child, from a launcher that exits at once, so the CC
 * re-parents to init and no real Claude Code above this suite stands in for it.
 */
const CC_SCRIPT = `
const { spawn } = require('node:child_process');
const { renameSync, writeFileSync } = require('node:fs');
const srv = spawn('sleep', ['300'], { argv0: process.env.SRV_ARGV, stdio: 'ignore' });
const hook = spawn('sleep', ['300'], { argv0: 'cc-hook-runner', stdio: 'ignore' });
writeFileSync(process.env.PIDFILE + '.part', JSON.stringify({ cc: process.pid, srv: srv.pid, hook: hook.pid }));
renameSync(process.env.PIDFILE + '.part', process.env.PIDFILE);
`;
const LAUNCHER = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', process.env.CC_SCRIPT], { argv0: process.env.CC_ARGV0, detached: true, stdio: 'ignore' }).unref();
`;
describe('orphan-scan: project-scoped cross-upgrade orphans', () => {
    let sb;
    let root;
    const spawned = [];
    before(() => {
        sb = makeSandbox(GATE);
        root = sb.dir;
    });
    after(() => {
        for (const pid of spawned) {
            try {
                process.kill(pid);
            }
            catch {
                /* already gone */
            }
        }
        sb.remove();
    });
    function runHook(home, project, extra = {}) {
        return runGate(GATE, {
            cwd: root,
            env: { ...sb.env, TMB_ORPHAN_SCAN_HOME: home, TMB_ORPHAN_SCAN_PROJECT_DIR: project, ...extra },
            input: INPUT,
        });
    }
    const scan = (home, project, clean = '0') => runHook(home, project, { TMB_ORPHAN_SCAN_CLEAN: clean }).stdout;
    it('a current-project 0-byte stale DB is reported; the live DB is not', () => {
        const home = join(root, 'h1');
        const proj = join(root, 'proj1');
        buildSandbox(home, proj);
        const out = scan(home, proj);
        assert.ok(out.includes(historyDbOf(home, proj)), `stale DB reported: ${out}`);
        assert.ok(!out.includes(liveDbOf(proj)), `live DB never reported: ${out}`);
    });
    it('report-only mode deletes nothing', () => {
        const home = join(root, 'h2');
        const proj = join(root, 'proj2');
        buildSandbox(home, proj);
        scan(home, proj);
        assert.ok(isFile(historyDbOf(home, proj)), 'stale DB removed in report-only mode');
        assert.ok(isFile(liveDbOf(proj)), 'live DB removed in report-only');
    });
    it('gated cleanup removes the stale DB; the live DB stays', () => {
        const home = join(root, 'h3');
        const proj = join(root, 'proj3');
        buildSandbox(home, proj);
        scan(home, proj, '1');
        assert.ok(!isFile(historyDbOf(home, proj)), 'gated cleanup did not remove stale DB');
        assert.ok(isFile(liveDbOf(proj)), 'gated cleanup removed live DB');
    });
    it("another project's stale DB is never reported or touched", () => {
        const home = join(root, 'h4');
        const proj = join(root, 'proj4');
        buildSandbox(home, proj);
        const otherStale = historyDbOf(home, join(root, 'other4'));
        makeDb(otherStale);
        const out = scan(home, proj, '1');
        assert.ok(!out.includes(otherStale), `other project's DB not reported: ${out}`);
        assert.ok(isFile(otherStale), "other project's DB was deleted (invariant breach)");
    });
    describe('cache versions', () => {
        let home;
        let proj;
        let pinnedDir;
        let unusedDir;
        before(() => {
            home = join(root, 'h5');
            proj = join(root, 'proj5');
            buildSandbox(home, proj);
            const cache = join(home, '.claude/plugins/cache/trustmybot-dev', PLUGIN_NAME);
            pinnedDir = join(cache, '0.10.0-rc.4');
            unusedDir = join(cache, '0.9.0');
            mkdirSync(pinnedDir, { recursive: true });
            mkdirSync(unusedDir, { recursive: true });
            const installed = {
                version: 2,
                plugins: {
                    'tmb@trustmybot-dev': [{ scope: 'local', projectPath: join(root, 'someother'), installPath: pinnedDir, version: '0.10.0-rc.4' }],
                },
            };
            writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify(installed, null, 2));
        });
        it('an unused cache version is a candidate; a pinned version is not', () => {
            const out = scan(home, proj);
            assert.ok(out.includes(unusedDir), `unused cache version reported as candidate: ${out}`);
            assert.ok(!out.includes(pinnedDir), `pinned cache version (other project) never a candidate: ${out}`);
        });
        it('gated cleanup removes only the unused cache version and keeps the pinned one', () => {
            scan(home, proj, '1');
            assert.ok(!isDir(unusedDir), 'unused cache version not cleaned');
            assert.ok(isDir(pinnedDir), 'pinned cache version was removed (invariant breach)');
        });
    });
    it('a non-stale DB (same schema as live) is not reported', () => {
        const home = join(root, 'h6');
        const proj = join(root, 'proj6');
        buildSandbox(home, proj);
        const dup = historyDbOf(home, proj);
        makeDb(dup, 26);
        const out = scan(home, proj);
        assert.ok(!out.includes(dup), `current-schema dup not flagged: ${out}`);
    });
    it('a clean sandbox is silent (no findings, exit 0)', () => {
        const home = join(root, 'h7');
        const proj = join(root, 'proj7');
        mkdirSync(join(home, '.claude/plugins/cache'), { recursive: true });
        mkdirSync(join(home, '.claude/projects'), { recursive: true });
        makeDb(liveDbOf(proj), 26);
        assert.equal(scan(home, proj), '', 'no findings → empty output');
    });
    it('lsof and sqlite3 absent: degrades gracefully and still exits 0', () => {
        const home = join(root, 'h8');
        const proj = join(root, 'proj8');
        buildSandbox(home, proj);
        const curated = join(root, 'curatedbin');
        mkdirSync(curated, { recursive: true });
        const dirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d !== '');
        for (const b of ['env', 'bash', 'sh', 'jq', 'date', 'find', 'grep', 'sed', 'sort', 'head', 'tail', 'ps', 'kill', 'rm', 'mkdir', 'cat', 'printf', 'awk', 'dirname', 'basename', 'ln']) {
            const src = dirs.map((d) => join(d, b)).find((p) => existsSync(p));
            if (src !== undefined)
                symlinkSync(src, join(curated, b));
        }
        const r = runHook(home, proj, { PATH: curated });
        assert.equal(r.status, 0, `soft-fail with missing lsof/sqlite3: ${r.stderr}`);
    });
    describe('process trees', { skip: !PS_LISTS && 'ps cannot list processes on this host (GH 2334)' }, () => {
        let home;
        let proj;
        let selfHook;
        async function spawnCcTree(name, cc) {
            const pidfile = join(root, `${name}.pids`);
            const r = spawnSync(process.execPath, ['-e', LAUNCHER], {
                env: { ...sb.env, CC_SCRIPT, CC_ARGV0: cc, SRV_ARGV, PIDFILE: pidfile },
                stdio: 'ignore',
            });
            if (r.error)
                throw r.error;
            for (let tries = 0; tries < 50 && !existsSync(pidfile); tries += 1)
                await sleep(100);
            const tree = JSON.parse(readFileSync(pidfile, 'utf8'));
            spawned.push(tree.srv, tree.hook, tree.cc);
            return { cc: String(tree.cc), srv: String(tree.srv), hook: String(tree.hook) };
        }
        const treeScan = (holders, self, clean = '0') => runHook(home, proj, { TMB_ORPHAN_SCAN_CLEAN: clean, TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE: holders, TMB_ORPHAN_SCAN_SELF_PID: self }).stdout;
        before(async () => {
            home = join(root, 'h9');
            proj = join(root, 'proj9');
            mkdirSync(join(home, '.claude/plugins/cache'), { recursive: true });
            mkdirSync(join(home, '.claude/projects'), { recursive: true });
            makeDb(liveDbOf(proj), 26);
            selfHook = (await spawnCcTree('self', 'claude')).hook;
        });
        it("a live sibling session's server is not reported as a lock-conflict", async () => {
            const sib = await spawnCcTree('sibling', 'claude --resume');
            const out = treeScan(sib.srv, selfHook);
            assert.ok(!out.includes('lock-conflict'), `live sibling server is no lock-conflict: ${out}`);
            assert.ok(!out.includes('stale duplicate'), `live sibling server is not stale: ${out}`);
            assert.equal(out, '', 'live sibling server → silent');
            treeScan(sib.srv, selfHook, '1');
            await sleep(200);
            let alive = true;
            try {
                process.kill(Number(sib.srv), 0);
            }
            catch {
                alive = false;
            }
            assert.ok(alive, 'live sibling server was killed in clean mode');
        });
        it('an unrecognised parent leaves its server ownerless (stale)', async () => {
            const notCc = await spawnCcTree('notcc', 'node /opt/tools/bin/not-claude');
            const out = treeScan(notCc.srv, selfHook);
            assert.ok(out.includes(`stale duplicate trajectory-server on this project's live DB: pid ${notCc.srv}`), `server under a non-CC parent is stale: ${out}`);
        });
        const ccCommands = [
            'node /opt/tools/bin/claude',
            '/home/u/.local/share/claude/versions/2.1.305',
            'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
            '/Users/u/Library/Application Support/Claude/claude-code/2.1.305/claude.app/Contents/MacOS/claude',
        ];
        ccCommands.forEach((cc, i) => {
            it(`\`${cc}\` is recognised as a CC process`, async () => {
                const tree = await spawnCcTree(`cc${i}`, cc);
                assert.equal(treeScan(tree.srv, selfHook), '', 'its server has a live owner → silent');
                assert.equal(treeScan(tree.srv, tree.hook), '', 'its own hook resolves it as this session → silent');
            });
        });
    });
});
//# sourceMappingURL=orphan-scan-sandbox.test.js.map