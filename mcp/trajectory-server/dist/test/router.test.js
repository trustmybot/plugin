import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ALLOW } from '../hooks/gate.js';
import { armDeadline, disarmDeadline, noteSpawn, spawnLimit } from '../hooks/lib/deadline.js';
import { gitRun } from '../hooks/lib/git.js';
import { ROUTER_GROUPS, routerGates, routerGroup, routerTimeoutS } from '../hooks/registry.js';
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
const BASH_GROUP = routerGroup('PreToolUse', 'Bash');
function group(...gates) {
    return [{ event: 'PreToolUse', matcher: 'Bash', groupBudgetMs: BASH_GROUP.groupBudgetMs, gates: gates.map(([name, kind, budgetMs]) => ({ name, kind, budgetMs: budgetMs ?? 5000 })) }];
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
    it('charges each gate only its own work: a sibling that blocks the event loop never times out an idle gate (F271-1)', async () => {
        const quick = async () => {
            await new Promise((r) => setImmediate(r));
            return ALLOW;
        };
        const heavy = async () => {
            await Promise.resolve();
            const end = performance.now() + 600;
            while (performance.now() < end) {
                /* spin */
            }
            return ALLOW;
        };
        const d = await decide('PreToolUse', bash('true'), {}, {
            groups: [{ event: 'PreToolUse', matcher: 'Bash', groupBudgetMs: BASH_GROUP.groupBudgetMs, gates: [{ name: 'quick', kind: 'enforcement', budgetMs: 200 }, { name: 'heavy', kind: 'enforcement', budgetMs: 5000 }] }],
            findGate: fakes({ quick, heavy }),
        });
        assert.equal(d.denied, null, JSON.stringify(d.gates));
        assert.deepEqual(d.gates.map((g) => [g.gate, g.outcome]), [['quick', 'allow'], ['heavy', 'allow']]);
        assert.ok(d.gates[0].ms < d.gates[1].ms, JSON.stringify(d.gates));
    });
    it('runs the gates one at a time in group order', async () => {
        const log = [];
        const gate = (name) => async () => {
            log.push(`${name}:start`);
            await sleep(5);
            log.push(`${name}:end`);
            return ALLOW;
        };
        await decide('PreToolUse', bash('true'), {}, { groups: group(['a', 'enforcement'], ['b', 'advisory'], ['c', 'enforcement']), findGate: fakes({ a: gate('a'), b: gate('b'), c: gate('c') }) });
        assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    });
    it('each group\'s router timeout covers its budget plus the parse allowance, and its budget its largest gate budget', () => {
        for (const g of ROUTER_GROUPS) {
            const largest = Math.max(...g.gates.map((x) => x.budgetMs));
            assert.ok(g.groupBudgetMs >= largest, `${g.matcher}: ${g.groupBudgetMs} < ${largest}`);
            assert.ok(routerTimeoutS(g) * 1000 > g.groupBudgetMs, `${g.matcher}: ${routerTimeoutS(g)} s <= ${g.groupBudgetMs} ms`);
        }
        assert.ok(routerTimeoutS({ groupBudgetMs: 3000 }) * 1000 >= 3000);
        assert.ok(routerTimeoutS({ groupBudgetMs: 3000 }) < routerTimeoutS({ groupBudgetMs: 4500 }));
    });
});
describe('router groups (GH 1692 R2)', () => {
    const MCP = 'mcp__plugin_tmb_trajectory-server__';
    const toolCall = (tool, input = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });
    const names = (tool) => routerGates('PreToolUse', tool).map((g) => g.name);
    const CHAIN_HEAD = ['agent-arg-matches-caller', 'swe-brief-gate'];
    it('the mcp matcher takes every trajectory-server tool, whatever the plugin prefix, and no other', () => {
        for (const prefix of ['mcp__plugin_tmb_trajectory-server__', 'mcp__trajectory-server__']) {
            assert.deepEqual(names(`${prefix}task_brief`), CHAIN_HEAD, prefix);
        }
        assert.deepEqual(names('mcp__plugin_other__query'), []);
        assert.deepEqual(names('xmcp__trajectory-server__task_brief'), [], 'the matcher fits the whole name');
    });
    it('a matcher fits the whole tool name, not a part of it', () => {
        assert.ok(names('Read').includes('debug-trajectory'));
        assert.deepEqual(names('ReadFile'), []);
        assert.deepEqual(names('Bashful'), []);
    });
    it('a tool-filtered gate runs only for its own tool', () => {
        assert.deepEqual(names(`${MCP}task_update_status`), [...CHAIN_HEAD, 'swe-verification-gate']);
        assert.deepEqual(names(`${MCP}validation_record`), [...CHAIN_HEAD, 'reviewer-identity-observe']);
        assert.deepEqual(names(`${MCP}cheatcode_install`), [...CHAIN_HEAD, 'cheatcode-install-approval']);
        assert.deepEqual(names(`${MCP}task_update_statusx`), CHAIN_HEAD);
    });
    it('decide skips a tool-filtered gate for another tool', async () => {
        const seen = [];
        const gate = (name) => () => (seen.push(name), ALLOW);
        const groups = [
            {
                event: 'PreToolUse',
                matcher: 'mcp__.*trajectory-server__.*',
                groupBudgetMs: 5000,
                gates: [
                    { name: 'every', kind: 'enforcement', budgetMs: 1000 },
                    { name: 'only-close', kind: 'enforcement', budgetMs: 1000, toolSuffix: 'task_update_status' },
                ],
            },
        ];
        const findGate = fakes({ every: gate('every'), 'only-close': gate('only-close') });
        const other = await decide('PreToolUse', toolCall(`${MCP}task_brief`), {}, { groups, findGate });
        assert.deepEqual(other.gates.map((g) => g.gate), ['every']);
        const close = await decide('PreToolUse', toolCall(`${MCP}task_update_status`), {}, { groups, findGate });
        assert.deepEqual(close.gates.map((g) => g.gate), ['every', 'only-close']);
        assert.deepEqual(seen, ['every', 'every', 'only-close']);
    });
    it('a tool no group matches runs nothing and allows', async () => {
        let ran = false;
        const d = await decide('PreToolUse', toolCall('Glob'), {}, { findGate: () => () => ((ran = true), deny('never')) });
        assert.equal(ran, false);
        assert.deepEqual(d.gates, []);
        assert.equal(d.denied, null);
        assert.equal(d.stdout, '');
        assert.equal(d.code, 0);
    });
    it('the first deny in group order wins, whatever follows it', async () => {
        const seen = [];
        const gate = (name) => () => (seen.push(name), deny(`${name} denies`));
        const groups = [
            {
                event: 'PreToolUse',
                matcher: 'Write|Edit',
                groupBudgetMs: 5000,
                gates: [
                    { name: 'first', kind: 'enforcement', budgetMs: 1000 },
                    { name: 'second', kind: 'enforcement', budgetMs: 1000 },
                ],
            },
        ];
        const d = await decide('PreToolUse', toolCall('Edit'), {}, { groups, findGate: fakes({ first: gate('first'), second: gate('second') }) });
        assert.equal(d.denied?.gate, 'first');
        assert.equal(reasonOf(d.stdout), 'first denies');
        assert.deepEqual(seen, ['first', 'second'], 'a group runs on past a deny, as its separate registrations did');
    });
    it('the trajectory-server group stops at the first deny, as the chain does: a denied call leaves no later side effect', async () => {
        const mcp = routerGroup('PreToolUse', `${MCP}task_update_status`);
        assert.equal(mcp?.stopAtFirstDeny, true);
        assert.deepEqual(ROUTER_GROUPS.filter((g) => g.stopAtFirstDeny).map((g) => g.matcher), ['mcp__.*trajectory-server__.*']);
        const seen = [];
        const d = await decide('PreToolUse', toolCall(`${MCP}task_update_status`), {}, {
            findGate: (name) => () => (seen.push(name), name === 'swe-brief-gate' ? deny('brief first') : ALLOW),
        });
        assert.deepEqual(seen, CHAIN_HEAD, 'swe-verification-gate never starts');
        assert.equal(d.denied?.gate, 'swe-brief-gate');
        assert.deepEqual(d.gates.map((g) => g.gate), CHAIN_HEAD);
    });
    it('every chain member is enforcement: the chain fails closed on any of them', () => {
        const mcp = ROUTER_GROUPS.find((g) => g.matcher.startsWith('mcp__'));
        assert.ok(mcp);
        assert.ok(mcp.gates.every((g) => g.kind === 'enforcement'));
    });
    it('matchers do not overlap: each tool name belongs to one group', () => {
        const names = ROUTER_GROUPS.flatMap((g) => g.matcher.split('|'));
        assert.equal(names.length, new Set(names).size);
        assert.equal(routerGroup('PreToolUse', 'Write')?.matcher, 'Write|Edit|MultiEdit|NotebookEdit');
    });
});
describe('per-group budgets (GH 1692 R2)', () => {
    const HANG_S = 30;
    const VERIFICATION_FLOOR_MS = 1_830_000;
    let bin;
    let env;
    const viaGit = (_payload, gateEnv) => {
        gitRun('/', ['status'], gateEnv);
        return ALLOW;
    };
    before(() => {
        bin = mkdtempSync(join(tmpdir(), 'tmb-fake-git-'));
        writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep ${HANG_S}\n`);
        chmodSync(join(bin, 'git'), 0o755);
        env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    });
    after(() => rmSync(bin, { recursive: true, force: true }));
    it('the Bash group budget is its own, far below the verification floor the mcp group holds', () => {
        const mcp = routerGroup('PreToolUse', 'mcp__plugin_tmb_trajectory-server__task_update_status');
        assert.ok(mcp.groupBudgetMs >= VERIFICATION_FLOOR_MS);
        assert.ok(BASH_GROUP.groupBudgetMs < VERIFICATION_FLOOR_MS / 10, `${BASH_GROUP.groupBudgetMs}`);
        assert.ok(routerTimeoutS(BASH_GROUP) < routerTimeoutS(mcp));
        assert.equal(BASH_GROUP.gates.some((g) => g.name === 'swe-verification-gate'), false);
    });
    it('a hung gate in the Bash group ends at the Bash budget, though a sibling group holds the verification floor', async () => {
        const groups = [
            { event: 'PreToolUse', matcher: 'Bash', groupBudgetMs: 300, gates: [{ name: 'hung', kind: 'enforcement', budgetMs: VERIFICATION_FLOOR_MS }] },
            { event: 'PreToolUse', matcher: 'mcp__.*', groupBudgetMs: VERIFICATION_FLOOR_MS, gates: [{ name: 'verify', kind: 'enforcement', budgetMs: VERIFICATION_FLOOR_MS }] },
        ];
        const d = await decide('PreToolUse', bash('git status'), env, { groups, findGate: fakes({ hung: viaGit, verify: viaGit }) });
        assert.equal(d.denied?.gate, 'hung');
        assert.match(reasonOf(d.stdout), /300 ms group budget/);
        assert.deepEqual(d.gates.map((g) => g.gate), ['hung']);
        assert.ok(d.gates[0].ms < HANG_S * 1000, `${d.gates[0].ms} ms: git was not cut off`);
    });
});
describe('router deadlines: every spawn stops at the gate deadline (decision 922)', () => {
    const HANG_S = 30;
    let bin;
    let env;
    const viaGit = (_payload, gateEnv) => {
        gitRun('/', ['status'], gateEnv);
        return ALLOW;
    };
    before(() => {
        bin = mkdtempSync(join(tmpdir(), 'tmb-fake-git-'));
        writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep ${HANG_S}\n`);
        chmodSync(join(bin, 'git'), 0o755);
        env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    });
    after(() => rmSync(bin, { recursive: true, force: true }));
    it('a hung git ends at the gate budget: the enforcement gate denies by name, the advisory one is skipped', async () => {
        const d = await decide('PreToolUse', bash('git status'), env, {
            groups: group(['hung-advisory', 'advisory', 300], ['hung-enforcement', 'enforcement', 300]),
            findGate: fakes({ 'hung-advisory': viaGit, 'hung-enforcement': viaGit }),
        });
        assert.deepEqual(d.gates.map((g) => [g.gate, g.outcome]), [['hung-advisory', 'skipped_budget'], ['hung-enforcement', 'deny']]);
        assert.equal(d.denied?.gate, 'hung-enforcement');
        assert.match(reasonOf(d.stdout), /^BLOCKED: TMB gate hung-enforcement timed out after 300 ms \(infrastructure load, not a policy decision\)/);
        assert.match(d.stderr, /advisory gate hung-advisory ran past its 300 ms budget — skipped/);
        for (const g of d.gates)
            assert.ok(g.ms < HANG_S * 1000 && g.ms < routerTimeoutS(BASH_GROUP) * 1000, `${g.gate} ${g.ms} ms: git was not cut off`);
    });
    it('once the group budget is spent, the next enforcement gate denies naming itself and the group budget', async () => {
        let ran = false;
        const d = await decide('PreToolUse', bash('git status'), env, {
            groups: group(['eats-group', 'advisory', 5000], ['after-spent', 'enforcement', 5000], ['advisory-after', 'advisory', 5000]),
            groupBudgetMs: 300,
            findGate: fakes({ 'eats-group': viaGit, 'after-spent': () => ((ran = true), ALLOW), 'advisory-after': () => ((ran = true), ALLOW) }),
        });
        assert.equal(ran, false, 'no gate runs once the group budget is spent');
        assert.deepEqual(d.gates.map((g) => [g.gate, g.outcome]), [['eats-group', 'skipped_budget'], ['after-spent', 'deny'], ['advisory-after', 'skipped_budget']]);
        assert.equal(d.denied?.gate, 'after-spent');
        assert.match(reasonOf(d.stdout), /^BLOCKED: TMB gate after-spent was not run: the gates before it spent the router's 300 ms group budget/);
        assert.match(d.stderr, /advisory gate eats-group ran out of the 300 ms group budget — skipped/);
        assert.ok(d.gates[0].ms < HANG_S * 1000 && d.gates[0].ms < routerTimeoutS(BASH_GROUP) * 1000, `${d.gates[0].ms} ms: git was not cut off`);
    });
    it('a gate the group budget cuts off mid-run denies naming the group budget', async () => {
        const d = await decide('PreToolUse', bash('git status'), env, {
            groups: group(['cut-by-group', 'enforcement', 5000]),
            groupBudgetMs: 300,
            findGate: fakes({ 'cut-by-group': viaGit }),
        });
        assert.equal(d.denied?.gate, 'cut-by-group');
        assert.match(reasonOf(d.stdout), /^BLOCKED: TMB gate cut-by-group ran out of the router's 300 ms group budget/);
    });
    it('outside a gate, git runs with no timeout of its own', () => {
        assert.equal(spawnLimit(), null);
        assert.equal(gitRun('/', ['--version']).code, 0);
    });
    it('a spawn takes the sooner of its own limit and the deadline left, at least 1 ms', () => {
        let t = 1000;
        armDeadline(1050, () => t);
        try {
            assert.deepEqual(spawnLimit(), { timeout: 50, killSignal: 'SIGTERM', byDeadline: true });
            assert.deepEqual(spawnLimit(10, 'SIGKILL'), { timeout: 10, killSignal: 'SIGKILL', byDeadline: false });
            assert.deepEqual(spawnLimit(500, 'SIGKILL'), { timeout: 50, killSignal: 'SIGKILL', byDeadline: true });
            assert.equal(noteSpawn(spawnLimit(10), { signal: 'SIGKILL' }), true);
            assert.equal(disarmDeadline(), false, 'a cut by the caller limit is not the deadline');
            armDeadline(1050, () => t);
            t = 2000;
            assert.equal(spawnLimit()?.timeout, 1);
            assert.equal(noteSpawn(spawnLimit(), { error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), signal: null }), true);
            assert.equal(disarmDeadline(), true);
        }
        finally {
            disarmDeadline();
        }
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
    it('a deny on a non-Bash tool writes the hook_denied row dispatch.sh writes and, as its record_bash_deny, no boundary-denies record', async () => {
        const before = rows('hook_denied').length;
        const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-edit', tool_use_id: 'deny-edit', cwd: project, tool_name: 'Edit', tool_input: { file_path: join(base, 'x.txt') } });
        const groups = [{ event: 'PreToolUse', matcher: 'Edit', groupBudgetMs: 5000, gates: [{ name: 'g', kind: 'enforcement', budgetMs: 1000 }] }];
        const r = await call(payload, fakes({ g: () => deny('g denies the edit') }), groups);
        assert.equal(reasonOf(r.stdout), 'g denies the edit');
        const denied = rows('hook_denied').slice(before);
        assert.equal(denied.length, 1);
        assert.equal(denied[0].from_node, 'hook:dispatch');
        assert.equal(denied[0].summary, 'g denied Edit');
        assert.deepEqual(JSON.parse(denied[0].content_json), { hook: 'g', rule: 'g denies the edit', tool: 'Edit', agent_type: null, task_id: null, cwd: project });
        assert.equal(existsSync(join(dirname(db), 'locks/boundary-denies/sess-edit')), false);
    });
    it('never hands a call to an install whose router table has no group for its tool, and still does for one it has', async () => {
        const old = join(base, 'old-install');
        const manifest = join(old, 'mcp/trajectory-server/dist/hooks-router.txt');
        mkdirSync(dirname(manifest), { recursive: true });
        writeFileSync(manifest, 'containment-guard 5000 enforcement PreToolUse Bash\n');
        const bundle = join(old, 'mcp/trajectory-server/dist/hooks.js');
        writeFileSync(bundle, "process.stdout.write('{\"hookSpecificOutput\":{\"additionalContext\":\"old install answered\"}}\\n');\n");
        const installed = join(base, 'installed.json');
        writeFileSync(installed, JSON.stringify({ plugins: { 'tmb@trustmybot-dev': [{ scope: 'project', projectPath: project, installPath: old }] } }));
        const run = async (payload) => {
            let stdout = '';
            await routerMain('PreToolUse', { ...env(), TMB_INSTALLED_JSON: installed }, { readStdin: () => payload, writeStdout: async (t) => void (stdout += t), writeStderr: () => { } }, {
                findGate: fakes({ g: () => deny('this install decided') }),
                groups: [{ event: 'PreToolUse', matcher: 'Write', groupBudgetMs: 5000, gates: [{ name: 'g', kind: 'enforcement', budgetMs: 1000 }] }],
                selfRoot: PLUGIN_ROOT,
            });
            return stdout;
        };
        const write = await run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-hop', tool_use_id: 'hop-w', tool_name: 'Write', tool_input: {} }));
        assert.equal(reasonOf(write), 'this install decided');
        const shell = await run(bash('ls', { session_id: 'sess-hop', tool_use_id: 'hop-b' }));
        assert.match(shell, /old install answered/);
    });
    it('an unjudged deny records no path', async () => {
        const r = await call(bash('touch "$X"', { tool_use_id: 'deny-unjudged', session_id: 'sess-unjudged', cwd: project }), fakes({ g: () => deny('BLOCKED: write target "$X" cannot be judged: it names a variable') }), group(['g', 'enforcement']));
        assert.equal(r.code, 0);
        assert.equal(existsSync(join(dirname(db), 'locks/boundary-denies/sess-unjudged')), false);
    });
});
//# sourceMappingURL=router.test.js.map