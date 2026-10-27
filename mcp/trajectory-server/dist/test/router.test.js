import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ALLOW } from '../hooks/gate.js';
import { ROUTER_GROUPS, routerGates, routerTimeoutS } from '../hooks/registry.js';
import { decide } from '../hooks/router/decide.js';
import { routerMain } from '../hooks/router/main.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const deny = (reason) => ({
    stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`,
    code: 0,
});
const context = (text) => ({
    stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`,
    code: 0,
});
function group(...gates) {
    return [{ event: 'PreToolUse', tools: ['Bash'], gates: gates.map(([name, kind, budgetMs]) => ({ name, kind, budgetMs: budgetMs ?? 5000 })) }];
}
function bash(command, extra = {}) {
    return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu-1', ...extra });
}
function reasonOf(stdout) {
    return JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason;
}
function fakes(map) {
    return (name) => map[name];
}
describe('router decision: deny, allow, merge', () => {
    it('allows when every gate allows, with one allow outcome and a ms per gate', async () => {
        const d = await decide('PreToolUse', bash('ls'), {}, { groups: group(['a', 'enforcement'], ['b', 'advisory']), findGate: fakes({ a: () => ALLOW, b: () => ALLOW }) });
        assert.equal(d.stdout, '');
        assert.equal(d.code, 0);
        assert.equal(d.denied, null);
        assert.deepEqual(d.gates.map((g) => [g.gate, g.outcome]), [['a', 'allow'], ['b', 'allow']]);
        assert.ok(d.gates.every((g) => typeof g.ms === 'number' && g.ms >= 0));
    });
    it('returns the first deny in group order, with that gate reason, whichever finished first', async () => {
        const d = await decide('PreToolUse', bash('ls'), {}, {
            groups: group(['a', 'enforcement'], ['b', 'enforcement'], ['c', 'enforcement']),
            findGate: fakes({
                a: () => context('ctx a'),
                b: async () => {
                    await sleep(30);
                    return deny('b says no');
                },
                c: () => deny('c says no'),
            }),
        });
        assert.equal(reasonOf(d.stdout), 'b says no');
        assert.deepEqual(d.denied, { gate: 'b', reason: 'b says no' });
        assert.deepEqual(d.gates.map((g) => g.outcome), ['allow', 'deny', 'deny']);
    });
    it('passes one context through as is and merges several into one additionalContext', async () => {
        const one = await decide('PreToolUse', bash('ls'), {}, { groups: group(['a', 'advisory'], ['b', 'enforcement']), findGate: fakes({ a: () => context('only'), b: () => ALLOW }) });
        assert.equal(one.stdout, context('only').stdout);
        const two = await decide('PreToolUse', bash('ls'), {}, { groups: group(['a', 'advisory'], ['b', 'enforcement']), findGate: fakes({ a: () => context('one'), b: () => context('two') }) });
        assert.deepEqual(JSON.parse(two.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'one\n\ntwo' } });
    });
    it('runs no gate for a tool no group names, and allows', async () => {
        let ran = 0;
        const d = await decide('PreToolUse', JSON.stringify({ tool_name: 'Read', tool_input: {} }), {}, { groups: group(['a', 'enforcement']), findGate: fakes({ a: () => (ran++, deny('x')) }) });
        assert.equal(d.stdout, '');
        assert.equal(ran, 0);
    });
    it('keeps an exit 2 deny with its code', async () => {
        const d = await decide('PreToolUse', bash('ls'), {}, { groups: group(['a', 'enforcement']), findGate: fakes({ a: () => ({ stdout: '', code: 2 }) }) });
        assert.equal(d.code, 2);
        assert.equal(d.denied?.gate, 'a');
    });
});
describe('router fail-closed: each denies naming the gate', () => {
    const cases = [
        ['a throw', () => {
                throw new Error('kaboom');
            }, /TMB gate g exited 1 without a decision/],
        ['a rejection', () => Promise.reject(new Error('kaboom')), /TMB gate g exited 1 without a decision/],
        ['exit 1', () => ({ stdout: '', code: 1 }), /TMB gate g exited 1 without a decision/],
        ['unparseable output', () => ({ stdout: 'not json\n', code: 0 }), /TMB gate g printed unparseable output without a decision/],
        ['an unknown gate', undefined, /TMB gate g exited 1 without a decision/],
    ];
    for (const [what, gate, pattern] of cases) {
        it(`${what} of an enforcement gate denies`, async () => {
            const d = await decide('PreToolUse', bash('ls'), {}, { groups: group(['ok', 'enforcement'], ['g', 'enforcement']), findGate: fakes(gate ? { ok: () => ALLOW, g: gate } : { ok: () => ALLOW }) });
            assert.equal(d.code, 0);
            assert.match(reasonOf(d.stdout), pattern);
            assert.equal(d.denied?.gate, 'g');
            assert.match(d.stderr, /gate g .*failing closed/);
            assert.equal(d.gates[1].outcome, 'deny');
        });
        it(`${what} of an advisory gate is dropped and logged, and the call proceeds`, async () => {
            const d = await decide('PreToolUse', bash('ls'), {}, { groups: group(['g', 'advisory'], ['ok', 'enforcement']), findGate: fakes(gate ? { ok: () => context('kept'), g: gate } : { ok: () => context('kept') }) });
            assert.equal(d.stdout, context('kept').stdout);
            assert.equal(d.gates[0].outcome, 'error');
            assert.match(d.stderr, /advisory gate g .*output dropped/);
        });
    }
    it('an exit 1 that still printed a deny keeps that deny', async () => {
        const d = await decide('PreToolUse', bash('ls'), {}, { groups: group(['g', 'enforcement']), findGate: fakes({ g: () => ({ ...deny('own reason'), code: 1 }) }) });
        assert.equal(reasonOf(d.stdout), 'own reason');
    });
    it('an unparseable payload denies naming the router', async () => {
        const d = await decide('PreToolUse', '{not json', {}, { groups: group(['g', 'enforcement']), findGate: fakes({ g: () => ALLOW }) });
        assert.match(reasonOf(d.stdout), /^BLOCKED: TMB gate router got an unparseable payload without a decision/);
        assert.equal(d.denied?.gate, 'router');
    });
});
describe('router budgets', () => {
    it('skips a slow advisory gate: output dropped and logged, the call proceeds', async () => {
        const d = await decide('PreToolUse', bash('ls'), {}, {
            groups: group(['slow', 'advisory', 40], ['ok', 'enforcement']),
            findGate: fakes({
                slow: async () => {
                    await sleep(400);
                    return context('late context');
                },
                ok: () => ALLOW,
            }),
        });
        assert.equal(d.stdout, '');
        assert.equal(d.denied, null);
        assert.equal(d.gates[0].outcome, 'skipped_budget');
        assert.ok(d.gates[0].ms < 400, `${d.gates[0].ms} ms: raced, not awaited`);
        assert.match(d.stderr, /advisory gate slow ran past its 40 ms budget — skipped, output dropped/);
    });
    it('denies on a slow enforcement gate, naming the gate and its budget', async () => {
        const d = await decide('PreToolUse', bash('ls'), {}, {
            groups: group(['ok', 'enforcement'], ['slow', 'enforcement', 40]),
            findGate: fakes({
                ok: () => ALLOW,
                slow: async () => {
                    await sleep(400);
                    return ALLOW;
                },
            }),
        });
        assert.match(reasonOf(d.stdout), /^BLOCKED: TMB gate slow timed out after 40 ms \(infrastructure load, not a policy decision\)/);
        assert.equal(d.gates[1].outcome, 'deny');
    });
    it('judges a sync gate on return: past its budget it denies', async () => {
        const busy = () => {
            const end = performance.now() + 30;
            while (performance.now() < end) {
                /* spin */
            }
            return ALLOW;
        };
        const d = await decide('PreToolUse', bash('ls'), {}, { groups: group(['sync', 'enforcement', 5]), findGate: fakes({ sync: busy }) });
        assert.match(reasonOf(d.stdout), /TMB gate sync timed out after 5 ms/);
    });
    it('the hooks.json registration is the router timeout: largest budget + 2 s', () => {
        const max = Math.max(...ROUTER_GROUPS.flatMap((g) => g.gates.map((x) => x.budgetMs)));
        assert.equal(routerTimeoutS(), Math.ceil(max / 1000) + 2);
    });
});
describe('router entry: dedupe and records', () => {
    let base;
    let project;
    let db;
    before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-router-')));
        project = join(base, 'project');
        db = join(project, '.claude/tmb/trajectory.db');
        mkdirSync(dirname(db), { recursive: true });
        const d = new DatabaseSync(db);
        d.exec(SCHEMA);
        d.close();
    });
    after(() => rmSync(base, { recursive: true, force: true }));
    const env = () => {
        const e = { ...process.env, CLAUDE_PROJECT_DIR: project, PWD: project, TMB_TEST_RUN_ID: 'router-test' };
        delete e.TRAJECTORY_DB_PATH;
        return e;
    };
    async function call(payload, findGate, groups) {
        let stdout = '';
        let stderr = '';
        const code = await routerMain('PreToolUse', env(), {
            readStdin: () => payload,
            writeStdout: async (t) => {
                stdout += t;
            },
            writeStderr: (t) => {
                stderr += t;
            },
        }, { findGate, groups, hop: false, selfRoot: PLUGIN_ROOT });
        return { code, stdout, stderr };
    }
    function rows(type) {
        const d = new DatabaseSync(db);
        try {
            return d.prepare('SELECT from_node, summary, content_json, issue_id FROM audit WHERE event_type = ? ORDER BY id').all(type);
        }
        finally {
            d.close();
        }
    }
    it('writes one hook_call row with the 11 gates of the Bash group, each with its ms', async () => {
        const names = routerGates('PreToolUse', 'Bash').map((g) => g.name);
        assert.equal(names.length, 11);
        const r = await call(bash('ls', { tool_use_id: 'call-row' }), () => () => ALLOW);
        assert.equal(r.stdout, '');
        const calls = rows('hook_call');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].from_node, 'hook:router');
        assert.equal(calls[0].issue_id, -1);
        const content = JSON.parse(calls[0].content_json);
        assert.equal(content.decision, 'allow');
        assert.deepEqual(content.gates.map((g) => g.gate), names);
        assert.ok(content.gates.every((g) => typeof g.ms === 'number' && g.outcome === 'allow'));
    });
    it('a second identical payload replays the first deny without re-running the gates', async () => {
        let runs = 0;
        const gates = fakes({ a: () => (runs++, deny('a denies')) });
        const payload = bash('rm -rf build', { tool_use_id: 'dupe-1' });
        const first = await call(payload, gates, group(['a', 'enforcement']));
        const second = await call(payload, gates, group(['a', 'enforcement']));
        assert.equal(runs, 1);
        assert.equal(second.stdout, first.stdout);
        assert.equal(reasonOf(second.stdout), 'a denies');
        const third = await call(bash('rm -rf build', { tool_use_id: 'dupe-2' }), gates, group(['a', 'enforcement']));
        assert.equal(runs, 2, 'another tool_use_id is another call');
        assert.equal(reasonOf(third.stdout), 'a denies');
    });
    it('a duplicate of an allow emits nothing', async () => {
        let runs = 0;
        const gates = fakes({ a: () => (runs++, context('ctx')) });
        const payload = bash('ls', { tool_use_id: 'dupe-allow' });
        const first = await call(payload, gates, group(['a', 'advisory']));
        const second = await call(payload, gates, group(['a', 'advisory']));
        assert.equal(runs, 1);
        assert.equal(first.stdout, context('ctx').stdout);
        assert.equal(second.stdout, '');
    });
    it('a deny writes the hook_denied row and the boundary-denies record of each path the command writes', async () => {
        const target = join(base, 'written.txt');
        const before = rows('hook_denied').length;
        const r = await call(bash(`touch ${target}`, { tool_use_id: 'deny-rec', session_id: 'sess-rec', cwd: project }), fakes({ g: () => deny('g denies the write') }), group(['g', 'enforcement']));
        assert.equal(reasonOf(r.stdout), 'g denies the write');
        const denied = rows('hook_denied').slice(before);
        assert.equal(denied.length, 1);
        assert.equal(denied[0].from_node, 'hook:dispatch');
        assert.equal(denied[0].summary, 'g denied Bash');
        assert.deepEqual(JSON.parse(denied[0].content_json), { hook: 'g', rule: 'g denies the write', tool: 'Bash', agent_type: null, task_id: null, cwd: project });
        const digest = createHash('sha256').update(target, 'utf8').digest('hex');
        const record = join(dirname(db), 'locks/boundary-denies/sess-rec', digest);
        assert.ok(existsSync(record), `${record}: ${readdirSync(dirname(record)).join(', ')}`);
        assert.match(readFileSync(record, 'utf8'), /^g\n\d+\n$/);
    });
    it('an unjudged deny records no path', async () => {
        const r = await call(bash('touch "$X"', { tool_use_id: 'deny-unjudged', session_id: 'sess-unjudged', cwd: project }), fakes({ g: () => deny('BLOCKED: write target "$X" cannot be judged: it names a variable') }), group(['g', 'enforcement']));
        assert.equal(r.code, 0);
        assert.equal(existsSync(join(dirname(db), 'locks/boundary-denies/sess-unjudged')), false);
    });
});
//# sourceMappingURL=router.test.js.map