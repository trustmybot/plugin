/**
 * Unit tests of the TypeScript orphan-scan and session-start-prescan gates
 * (GH 1692): the project-scope invariant of orphan-scan's clean mode, each
 * divergence from the .sh that decision 703 allows, and the helpers that
 * reproduce bash, sort -V and jq behavior. Every case runs in the parity
 * suite's sandbox, with its HOME and its ps/lsof stubs; no case reads the real
 * ~/.claude or signals a process.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashInt, isCcCommand, orphanScanRun, projectSlug } from '../hooks/orphan-scan.js';
import { contractScript, filevercmp, globNames, NO_JQ_LINE, readPair, sortVMax } from '../hooks/session-start-prescan.js';
import { belowV110 } from '../hooks/lib/install.js';
import { buildSessionScansSandbox, HELD_DB, OTHER_DB, PROJECT_DB, sessionScanEnv } from './hooks-session-scans-parity.suite.js';
import { noCmdPath } from './hooks-swe-run-parity.suite.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
function byteCompare(a, b) {
    return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function gate(name, env, cwd) {
    const r = spawnSync(process.execPath, [HOOKS_BUNDLE, name], { input: '{"hook_event_name":"SessionStart"}', env, cwd, encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
describe('orphan-scan and session-start-prescan in a sandbox', () => {
    let base;
    let s;
    let project;
    before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-session-scans-unit-')));
        s = join(base, 'sandbox');
        project = join(s, 'project');
    });
    after(() => {
        rmSync(base, { recursive: true, force: true });
    });
    it("clean mode never lists or removes another project's DB, process or pinned cache version", () => {
        buildSessionScansSandbox(s, process.pid);
        const home = join(s, 'homes/all');
        const cache = join(home, '.claude/plugins/cache');
        const env = sessionScanEnv(s, 'orphan-scan', 'C', { TMB_ORPHAN_SCAN_HOME: home, TMB_ORPHAN_SCAN_CLEAN: '1', TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE: '9000404 9000406' }, project);
        const servers = new Set(['9000403', '9000404', '9000406', '9000407', '9000409']);
        const asked = [];
        const terminated = [];
        const ops = {
            alive: (pid) => {
                asked.push(pid);
                return servers.has(pid);
            },
            terminate: (pid) => {
                terminated.push(pid);
                return true;
            },
        };
        const stderr = [];
        const r = orphanScanRun(env, ops, (text) => stderr.push(text));
        const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
        const otherHistory = join(home, '.claude/projects', projectSlug(join(s, 'other')));
        assert.ok(existsSync(join(otherHistory, 'trajectory.db')), "the other project's old-layout DB stays");
        assert.ok(existsSync(join(otherHistory, 'memory/trajectory.db')), "the other project's 0-byte DB stays");
        assert.ok(existsSync(join(s, OTHER_DB)), "the other project's live DB stays");
        assert.ok(existsSync(join(cache, 'trustmybot/tmb/1.2.0')), 'the version the other project pins stays');
        assert.ok(existsSync(join(cache, 'trustmybot/tmb/1.1.0')), 'the version this project pins stays');
        assert.ok(existsSync(join(cache, 'other/othertool/1.0.0')), "another plugin's cache stays");
        assert.ok(existsSync(join(home, '.claude/tmb/trajectory.db')), 'the legacy DB stays while a live DB exists');
        assert.ok(existsSync(join(s, PROJECT_DB)), 'the live DB stays');
        assert.ok(!ctx.includes(projectSlug(join(s, 'other'))), "no line names the other project's DBs");
        assert.ok(!ctx.includes('9000409'), "no line names the other project's server");
        assert.ok(!/tmb\/1\.2\.0(\n|$)/.test(ctx), 'no line names the pinned version');
        assert.ok(!asked.includes('9000409'), "the other project's server is never even probed");
        assert.deepEqual(terminated, ['9000404', '9000406'], "only this project's dead-owner servers are terminated");
        const ownHistory = join(home, '.claude/projects', projectSlug(project));
        assert.ok(!existsSync(join(ownHistory, 'trajectory.db')) && !existsSync(join(ownHistory, 'memory/trajectory.db')), "this project's stale DBs are removed");
        assert.ok(!existsSync(join(cache, 'trustmybot/tmb/1.0.0')) && !existsSync(join(cache, 'trustmybot-dev/tmb/1.2.0-dev.5')), 'unpinned versions are removed');
        assert.ok(ctx.includes('terminated stale duplicate trajectory-server: pid 9000404'), ctx);
        assert.deepEqual(stderr, []);
    });
    it("seen from another project, this project's DBs and processes are someone else's and stay", () => {
        buildSessionScansSandbox(s, process.pid);
        const home = join(s, 'homes/all');
        const held = dirname(dirname(dirname(join(s, HELD_DB))));
        const env = sessionScanEnv(s, 'orphan-scan', 'C', { TMB_ORPHAN_SCAN_HOME: home, TMB_ORPHAN_SCAN_CLEAN: '1', TRAJECTORY_DB_PATH: join(s, HELD_DB) }, held);
        const terminated = [];
        const r = orphanScanRun(env, { alive: (pid) => pid !== '9000405', terminate: (pid) => terminated.push(pid) > 0 }, () => { });
        const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
        assert.ok(ctx.startsWith(`=== TMB orphan scan (project-scoped) ===\nproject: ${held}\n`), ctx);
        const projectHistory = join(home, '.claude/projects', projectSlug(project));
        assert.ok(existsSync(join(projectHistory, 'trajectory.db')) && existsSync(join(projectHistory, 'memory/trajectory.db')), "project/'s stale DBs stay");
        assert.ok(!ctx.includes(projectSlug(project)), ctx);
        assert.deepEqual(terminated, ['9000404', '9000406'], "only the held DB's lsof holders are terminated");
    });
    it('decision 703: orphan-scan still reports without jq, where the .sh exits silently', () => {
        buildSessionScansSandbox(s, process.pid);
        const env = sessionScanEnv(s, 'orphan-scan', 'C', { PATH: noCmdPath(join(base, 'nojq'), 'jq', process.env.PATH ?? ''), TMB_ORPHAN_SCAN_HOME: join(s, 'homes/old-layout') }, project);
        assert.notEqual(spawnSync('jq', ['--version'], { env }).status, 0, 'jq is off PATH');
        const r = gate('orphan-scan', env, project);
        assert.equal(r.code, 0);
        assert.ok(r.stdout.includes(`stale trajectory DB (this project): ${join(s, 'homes/old-layout/.claude/projects', projectSlug(project), 'trajectory.db')}`), r.stdout);
    });
    it('decision 703: orphan-scan reads schema versions through node:sqlite without the sqlite3 CLI', () => {
        buildSessionScansSandbox(s, process.pid);
        const env = sessionScanEnv(s, 'orphan-scan', 'C', { PATH: noCmdPath(join(base, 'nosqlite-o'), 'sqlite3', process.env.PATH ?? ''), TMB_ORPHAN_SCAN_HOME: join(s, 'homes/old-layout') }, project);
        assert.notEqual(spawnSync('sqlite3', ['-version'], { env }).status, 0, 'sqlite3 is off PATH');
        const r = gate('orphan-scan', env, project);
        assert.equal(r.code, 0);
        assert.equal(r.stderr, '', 'no "DB unavailable" warning');
        assert.ok(r.stdout.includes('stale trajectory DB (this project)'), r.stdout);
    });
    it('decision 703: session-start-prescan prints the inventory without the sqlite3 CLI', () => {
        buildSessionScansSandbox(s, process.pid);
        const env = sessionScanEnv(s, 'session-start-prescan', 'C', { PATH: noCmdPath(join(base, 'nosqlite-p'), 'sqlite3', process.env.PATH ?? '') }, project);
        const r = gate('session-start-prescan', env, project);
        assert.equal(r.code, 0);
        assert.ok(r.stdout.includes('=== Project Inventory (auto, deterministic) ==='), r.stdout);
        assert.ok(r.stdout.includes('Open issues:       3'), r.stdout);
    });
    it('session-start-prescan without jq prints the Tooling line byte for byte', () => {
        buildSessionScansSandbox(s, process.pid);
        const env = sessionScanEnv(s, 'session-start-prescan', 'C', { PATH: noCmdPath(join(base, 'nojq-p'), 'jq', process.env.PATH ?? ''), TRAJECTORY_DB_PATH: join(s, PROJECT_DB) }, project);
        const r = gate('session-start-prescan', env, project);
        assert.equal(r.stdout, NO_JQ_LINE);
        assert.equal(NO_JQ_LINE, '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Tooling: jq not found — every TMB gate will deny until it is installed"}}\n');
    });
});
describe('orphan-scan helpers', () => {
    it('isCcCommand matches the Claude Code CLI words only', () => {
        for (const cmd of ['claude', 'node /x/bin/claude --resume', '/A/claude.app/Contents/MacOS/claude', '/u/.local/share/claude/versions/2.1.0', 'node /n/@anthropic-ai/claude-code/cli.js']) {
            assert.ok(isCcCommand(cmd), cmd);
        }
        for (const cmd of ['node /x/mcp/trajectory-server/dist/index.js', 'bash /u/.claude/shell-snapshots/s.sh', 'claudex', ''])
            assert.ok(!isCcCommand(cmd), cmd);
    });
    it("projectSlug collapses every non-alphanumeric run, as CC's slug does", () => {
        assert.equal(projectSlug('/Users/a b/.x_y'), '-Users-a-b-x-y');
    });
    it("bashInt reads `[ -lt ]` operands: blanks and sign allowed, int64 only", () => {
        assert.equal(bashInt(' 42\n'), 42n);
        assert.equal(bashInt('-7'), -7n);
        assert.equal(bashInt('4x'), null);
        assert.equal(bashInt('9223372036854775808'), null);
    });
});
describe('session-start-prescan helpers', () => {
    it('filevercmp orders as sort -V does, ties broken bytewise', () => {
        const order = ['1.2', '1.2.0~1', '01.2.0', '1.2.0', '1.2.0a', '1.2.0-dev.9', '1.2.0-dev.10', '1.2.0-dev.199.gh2087', '1.2.0-dev.199.gh2100', '1.2.0-rc.1', '1.2.0.1', '1.10.0'];
        const shuffled = [...order].reverse();
        assert.deepEqual(shuffled.sort((a, b) => filevercmp(a, b) || byteCompare(a, b)), order);
        assert.equal(sortVMax('1.9.9', '1.10.0'), '1.10.0');
        assert.equal(sortVMax('1.2.0', '01.2.0'), '1.2.0');
    });
    it("readPair keeps bash's `IFS='|' read -r name path` quirk", () => {
        assert.deepEqual(readPair('x|y|'), { name: 'x', path: 'y' });
        assert.deepEqual(readPair('x|y|z|'), { name: 'x', path: 'y|z|' });
        assert.deepEqual(readPair('x|y||'), { name: 'x', path: 'y||' });
        assert.deepEqual(readPair('x'), { name: 'x', path: '' });
    });
    it('globNames sorts as the bash glob does, the `*/` suffix included', () => {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-glob-names-'));
        try {
            for (const name of ['ab', 'a_b', 'a0', 'a', 'a.b', 'a-b', '.hidden'])
                mkdirSync(join(dir, name));
            assert.deepEqual(globNames(dir, { LC_ALL: 'C' }, '/'), ['a-b', 'a.b', 'a', 'a0', 'a_b', 'ab']);
            assert.deepEqual(globNames(dir, { LC_ALL: 'en_US.UTF-8' }, '/'), ['a_b', 'a-b', 'a.b', 'a', 'a0', 'ab']);
            assert.deepEqual(globNames(dir, { LC_ALL: 'C' }), ['a', 'a-b', 'a.b', 'a0', 'a_b', 'ab']);
            assert.deepEqual(globNames(dir, { LC_ALL: 'en_US.UTF-8' }), ['a', 'a_b', 'a-b', 'a.b', 'a0', 'ab']);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("contractScript builds jq's script: params unique and sorted, env numbers as jq renders them", () => {
        const contracts = [
            { id: 'a', sql: 'SELECT 1', expect: { op: '=', value: 1 }, params: [{ name: 'stale_hours', env: 'X_H', default: 6 }] },
            {
                id: 'b',
                sql: 'SELECT 0',
                expect: { op: '>=', value: 0.05 },
                params: [
                    { name: 'grace_hours', env: 'X_G', default: 24 },
                    { name: 'stale_hours', env: 'X_H', default: 6 },
                ],
            },
        ];
        assert.equal(contractScript(contracts, { X_H: '007.50', X_G: '0' }), [
            "SELECT '__schema|' || COALESCE((SELECT schema_version FROM plugin_meta LIMIT 1), '');",
            '.parameter set :grace_hours 24',
            '.parameter set :stale_hours 7.50',
            "SELECT 'a|' || CASE WHEN (SELECT 1) = 1 THEN 'ok' ELSE 'fail' END;",
            "SELECT 'b|' || CASE WHEN (SELECT 0) >= 0.05 THEN 'ok' ELSE 'fail' END;",
        ].join('\n'));
    });
    it("belowV110 compares the release part as jq's tonumber? // -1 does", () => {
        assert.ok(belowV110('1.0.2'));
        assert.ok(belowV110('1.0'));
        assert.ok(belowV110('abc'));
        assert.ok(!belowV110('1.1.0'));
        assert.ok(!belowV110('1.2.0-dev.5'));
    });
});
//# sourceMappingURL=hooks-session-scans.test.js.map