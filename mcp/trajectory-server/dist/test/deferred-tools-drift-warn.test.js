/**
 * deferred-tools-drift-warn end to end (GH 1692), the SessionStart gate that
 * warns when a dist/tools/*.js is newer than this session's trajectory-server child:
 *   1. no child resolved, a missing tool dir, or every tool file older than the
 *      child (started in the past or the future) → silent;
 *   2. a tool file newer than the child → the Tier 2 note (#98) as
 *      additionalContext, a full restart and no /plugin, /reload-plugins or /mcp;
 *   3. without TMB_MCP_PID_OVERRIDE it names this session's own server (the one
 *      whose parent chain holds the nearest Claude Code ancestor), never a
 *      bystander session's, on two live process trees.
 * Each case runs `node dist/hooks.js deferred-tools-drift-warn` in a sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, runGate } from './hook-sandbox.js';
const GATE = 'deferred-tools-drift-warn';
const FAKE_PID = '99999';
const SRV_ARGV = 'node /x/mcp/trajectory-server/dist/index.js';
const now = () => Math.floor(Date.now() / 1000);
const PS_LISTS = spawnSync('ps', ['-o', 'pid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout?.trim() === String(process.pid);
/**
 * A "claude" process (argv0) with two `sleep 300` children: a server whose argv
 * holds the trajectory-server path and a hook surrogate. The server argv comes
 * through the env, so the "claude" command line never holds the path.
 */
const TREE_SCRIPT = `
const { spawn } = require('node:child_process');
const srv = spawn('sleep', ['300'], { argv0: process.env.SRV_ARGV, stdio: 'ignore' });
const hook = spawn('sleep', ['300'], { argv0: 'cc-hook-runner', stdio: 'ignore' });
process.stdout.write(JSON.stringify({ srv: srv.pid, hook: hook.pid }) + '\\n');
`;
function spawnLiveTree(children) {
    const cc = spawn(process.execPath, ['-e', TREE_SCRIPT], { argv0: 'claude', env: { ...process.env, SRV_ARGV }, stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(cc);
    return new Promise((resolve, reject) => {
        let buf = '';
        cc.on('error', reject);
        cc.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            if (!buf.includes('\n'))
                return;
            const { srv, hook } = JSON.parse(buf);
            resolve({ cc: cc.pid, srv, hook });
        });
    });
}
describe('deferred-tools-drift-warn: newer MCP tool files than the running child', () => {
    let sb;
    let toolDir;
    let pastEpoch;
    let futureEpoch;
    before(() => {
        sb = makeSandbox(GATE);
        toolDir = join(sb.dir, 'dist/tools');
        mkdirSync(toolDir, { recursive: true });
        pastEpoch = String(now() - 60);
        futureEpoch = String(now() + 60);
    });
    after(() => sb.remove());
    function run(env) {
        const r = runGate(GATE, { cwd: sb.dir, env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir, ...env }, input: '{}' });
        return r.stdout + r.stderr;
    }
    function touch(epoch, ...names) {
        for (const name of names) {
            writeFileSync(join(toolDir, name), '', { flag: 'a' });
            utimesSync(join(toolDir, name), epoch, epoch);
        }
    }
    it('no child resolved and no override (an empty tool dir): silent', () => {
        assert.equal(run({ TMB_TOOL_DIR_OVERRIDE: toolDir }), '');
    });
    it('the tool dir does not exist: silent', () => {
        assert.equal(run({ TMB_MCP_PID_OVERRIDE: FAKE_PID, TMB_MCP_START_OVERRIDE: pastEpoch, TMB_TOOL_DIR_OVERRIDE: join(sb.dir, 'nonexistent') }), '');
    });
    it('every tool file older than the child: silent', () => {
        touch(now() - 120, 'index.js', 'tasks.js');
        assert.equal(run({ TMB_MCP_PID_OVERRIDE: FAKE_PID, TMB_MCP_START_OVERRIDE: pastEpoch, TMB_TOOL_DIR_OVERRIDE: toolDir }), '');
    });
    it('a tool file newer than the child: the Tier 2 note as SessionStart additionalContext', () => {
        touch(now() + 1, 'index.js');
        const out = run({ TMB_MCP_PID_OVERRIDE: FAKE_PID, TMB_MCP_START_OVERRIDE: pastEpoch, TMB_TOOL_DIR_OVERRIDE: toolDir });
        for (const text of ['"hookEventName":"SessionStart"', 'additionalContext', 'deferred-tools drift', '#98', 'Tier 2', 'fully quit and relaunch Claude Code']) {
            assert.ok(out.includes(text), `${text} in ${out}`);
        }
        const slash = out.split('\n').filter((l) => /(^|[ `"'(])\/(plugin|reload-plugins|mcp)([ `"'),.;:]|$)/.test(l));
        assert.deepEqual(slash, [], 'names no /plugin, /reload-plugins or /mcp');
    });
    it('every tool file older than a child started in the future: silent', () => {
        touch(now() - 120, 'index.js', 'tasks.js');
        assert.equal(run({ TMB_MCP_PID_OVERRIDE: FAKE_PID, TMB_MCP_START_OVERRIDE: futureEpoch, TMB_TOOL_DIR_OVERRIDE: toolDir }), '');
    });
    describe('own-child resolution, with no PID override', { skip: !PS_LISTS && 'ps cannot list processes on this host' }, () => {
        const children = [];
        const pids = [];
        let own;
        let bystander;
        before(async () => {
            own = await spawnLiveTree(children);
            bystander = await spawnLiveTree(children);
            pids.push(own.srv, own.hook, bystander.srv, bystander.hook);
        });
        after(() => {
            for (const pid of pids) {
                try {
                    process.kill(pid);
                }
                catch {
                    /* already gone */
                }
            }
            for (const c of children)
                c.kill();
        });
        it('names this session\'s server, never the bystander\'s', () => {
            touch(now() + 1, 'index.js');
            const out = run({ TMB_DRIFT_SELF_PID: String(own.hook), TMB_MCP_START_OVERRIDE: pastEpoch, TMB_TOOL_DIR_OVERRIDE: toolDir });
            assert.ok(out.includes(`PID ${own.srv})`), out);
            assert.ok(!out.includes(`PID ${bystander.srv})`), out);
        });
    });
});
//# sourceMappingURL=deferred-tools-drift-warn.test.js.map