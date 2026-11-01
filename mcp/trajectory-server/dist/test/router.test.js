import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { eventHoldsEnforcement, matcherFits, ROUTER_GROUPS, routerGates, routerGroup, routerTimeoutS } from '../hooks/registry.js';
import { decide, denyOutput, mergeContext } from '../hooks/router/decide.js';
import { dedupeKey } from '../hooks/router/dedupe.js';
import { routerMain } from '../hooks/router/main.js';
import { EMPTY_MATCHER_COLUMN, matcherColumn, matcherOfColumn } from '../hooks/router/table.js';
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
    it('a merge drops no decision: ask beats allow in either order, with its own reason and both contexts (F287-4)', () => {
        const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'fine', additionalContext: 'one' } });
        const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check', additionalContext: 'two' } });
        assert.deepEqual(JSON.parse(mergeContext([allow, ask], 'PreToolUse')), {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check', additionalContext: 'one\n\ntwo' },
        });
        assert.deepEqual(JSON.parse(mergeContext([ask, allow], 'PreToolUse')), {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check', additionalContext: 'two\n\none' },
        });
        assert.deepEqual(JSON.parse(mergeContext([allow, context('more').stdout.trim()], 'PreToolUse')), {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'fine', additionalContext: 'one\n\nmore' },
        });
    });
    it('a merge keeps the first value of every other key, in hookSpecificOutput and at the top level (F287-4)', () => {
        const first = JSON.stringify({ systemMessage: 'first', hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { a: 1 } } });
        const second = JSON.stringify({ systemMessage: 'second', suppressOutput: true, hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { a: 2 }, extra: 'kept' } });
        assert.deepEqual(JSON.parse(mergeContext([first, second], 'PreToolUse')), {
            systemMessage: 'first',
            suppressOutput: true,
            hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '', updatedInput: { a: 1 }, extra: 'kept' },
        });
    });
    it('the bundle keeps the ask of a malformed ratification batch that also breaks the brevity targets (F287-4)', () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-router-ask-')));
        try {
            const db = new DatabaseSync(join(dir, 't.db'));
            db.exec(`CREATE TABLE roundtables(id INTEGER PRIMARY KEY, state TEXT);
        CREATE TABLE roundtable_votes(roundtable_id INT, participant TEXT);
        INSERT INTO roundtables(state) VALUES ('awaiting_human');`);
            db.close();
            const payload = JSON.stringify({
                tool_name: 'AskUserQuestion',
                session_id: 's1',
                tool_use_id: 't1',
                tool_input: { questions: [{ question: 'q', multiSelect: false, options: [{ label: 'one two three four five six seven eight' }] }] },
            });
            const out = execFileSync(process.execPath, [join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js'), 'PreToolUse'], {
                input: payload,
                encoding: 'utf8',
                cwd: dir,
                env: { ...process.env, TRAJECTORY_DB_PATH: join(dir, 't.db'), CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, TMB_INSTALLED_JSON: join(dir, 'none.json') },
            });
            const { hookSpecificOutput: o } = JSON.parse(out);
            assert.equal(o.permissionDecision, 'ask');
            assert.match(o.additionalContext, /label is 8 words/);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
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
    it('an event\'s matchers do not overlap: each tool name belongs to one of its groups', () => {
        const names = ROUTER_GROUPS.flatMap((g) => g.matcher.split('|').map((m) => `${g.event} ${g.part ?? ''} ${m}`));
        assert.equal(names.length, new Set(names).size);
        assert.equal(routerGroup('PreToolUse', 'Write')?.matcher, 'Write|Edit|MultiEdit|NotebookEdit');
    });
});
const EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionDenied', 'Stop', 'SubagentStop'];
function eventGroups(event, ...gates) {
    return [{ event, matcher: '', groupBudgetMs: 60_000, gates: gates.map(([name, kind, budgetMs]) => ({ name, kind, budgetMs: budgetMs ?? 5000 })) }];
}
const stopPayload = (extra = {}) => JSON.stringify({ session_id: 'sess-stop', stop_hook_active: false, ...extra });
function reasonFor(event, stdout) {
    const out = JSON.parse(stdout);
    if (event === 'PreToolUse') {
        assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse');
        assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
        assert.equal(out.decision, undefined);
        return out.hookSpecificOutput?.permissionDecisionReason ?? '';
    }
    assert.equal(out.decision, 'block');
    assert.equal(out.hookSpecificOutput, undefined);
    return out.reason ?? '';
}
describe('router events: a deny reads as its event wants (GH 1692 R3)', () => {
    for (const event of EVENTS) {
        it(`${event}: denyOutput and every fail-closed path print its shape`, async () => {
            assert.equal(reasonFor(event, denyOutput('no', event)), 'no');
            const failing = [
                ['throw', () => { throw new Error('kaboom'); }, /TMB gate g exited 1 without a decision/],
                ['exit 1', () => ({ stdout: '', code: 1 }), /TMB gate g exited 1 without a decision/],
                ['unparseable output', () => ({ stdout: 'not json\n', code: 0 }), /TMB gate g printed unparseable output without a decision/],
                ['unknown gate', undefined, /TMB gate g exited 1 without a decision/],
            ];
            for (const [what, gate, pattern] of failing) {
                const d = await decide(event, stopPayload(), {}, { groups: eventGroups(event, ['g', 'enforcement']), findGate: fakes(gate ? { g: gate } : {}) });
                assert.match(reasonFor(event, d.stdout), pattern, what);
                assert.equal(d.denied?.gate, 'g');
            }
        });
        it(`${event}: a gate past its budget or left no group budget denies in its shape`, async () => {
            const late = await decide(event, stopPayload(), {}, {
                groups: eventGroups(event, ['g', 'enforcement', 5]),
                findGate: fakes({ g: async () => { await sleep(40); return ALLOW; } }),
            });
            assert.match(reasonFor(event, late.stdout), /timed out after 5 ms/);
            const spent = await decide(event, stopPayload(), {}, { groups: eventGroups(event, ['g', 'enforcement']), groupBudgetMs: 0, findGate: fakes({ g: () => ALLOW }) });
            assert.match(reasonFor(event, spent.stdout), /group budget/);
        });
        it(`${event}: mergeContext defaults hookEventName to it`, () => {
            const plain = (text) => JSON.stringify({ hookSpecificOutput: { additionalContext: text } });
            assert.deepEqual(JSON.parse(mergeContext([plain('a'), plain('b')], event)), { hookSpecificOutput: { hookEventName: event, additionalContext: 'a\n\nb' } });
        });
    }
    it('an enforcement gate serves PreToolUse and SubagentStop, and no other event here', () => {
        assert.deepEqual(EVENTS.filter((e) => eventHoldsEnforcement(e)), ['PreToolUse', 'SubagentStop']);
    });
    for (const event of ['PreToolUse', 'SubagentStop']) {
        it(`an unparseable payload blocks on ${event}, naming the router`, async () => {
            const d = await decide(event, '{not json', {}, { findGate: fakes({}) });
            assert.match(reasonFor(event, d.stdout), /^BLOCKED: TMB gate router got an unparseable payload without a decision/);
            assert.equal(d.denied?.gate, 'router');
            assert.equal(d.code, 0);
        });
    }
    for (const event of ['PostToolUse', 'PermissionDenied', 'Stop']) {
        it(`an unparseable payload on ${event} logs to stderr and exits 0`, async () => {
            const d = await decide(event, '{not json', {}, { findGate: fakes({}) });
            assert.equal(d.stdout, '');
            assert.equal(d.code, 0);
            assert.equal(d.denied, null);
            assert.match(d.stderr, new RegExp(`TMB router: ${event} got an unparseable payload`));
        });
    }
});
describe('router events: a block keeps the other gates\' context (GH 1692 R3)', () => {
    const contextOn = (event, text) => ({ stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`, code: 0 });
    const blocks = (reason) => ({ stdout: `${JSON.stringify({ decision: 'block', reason })}\n`, code: 0 });
    it('swe-atomic-close\'s context survives consultant-persistence-gate\'s block', async () => {
        const d = await decide('SubagentStop', stopPayload(), {}, {
            findGate: fakes({ 'swe-atomic-close': () => contextOn('SubagentStop', 'task closed'), 'consultant-persistence-gate': () => blocks('persist first') }),
        });
        assert.deepEqual(d.gates.map((g) => [g.gate, g.outcome]), [['consultant-persistence-gate', 'deny'], ['swe-atomic-close', 'allow']]);
        assert.deepEqual(JSON.parse(d.stdout), { decision: 'block', reason: 'persist first', hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: 'task closed' } });
        assert.deepEqual(d.denied, { gate: 'consultant-persistence-gate', reason: 'persist first' });
        assert.equal(d.code, 0);
    });
    it('a fail-closed block keeps the context too', async () => {
        const d = await decide('SubagentStop', stopPayload(), {}, { findGate: fakes({ 'swe-atomic-close': () => contextOn('SubagentStop', 'task closed') }) });
        const out = JSON.parse(d.stdout);
        assert.equal(out.decision, 'block');
        assert.match(out.reason, /TMB gate consultant-persistence-gate exited 1/);
        assert.equal(out.hookSpecificOutput.additionalContext, 'task closed');
    });
    describe('an advisory gate overruns the group budget', () => {
        const overrunningClose = (consultant) => {
            const { groupBudgetMs } = routerGroup('SubagentStop', '');
            let clock = 0;
            const timedConsultant = (payload, env) => {
                clock += 1;
                return consultant(payload, env);
            };
            const overrun = () => {
                clock += groupBudgetMs;
                return contextOn('SubagentStop', 'too late');
            };
            return { now: () => clock, findGate: fakes({ 'consultant-persistence-gate': timedConsultant, 'swe-atomic-close': overrun }) };
        };
        it('the stop the enforcement gate allowed still goes through', async () => {
            const d = await decide('SubagentStop', stopPayload(), {}, overrunningClose(() => ALLOW));
            assert.deepEqual(d.gates.map((g) => [g.gate, g.outcome]), [['consultant-persistence-gate', 'allow'], ['swe-atomic-close', 'skipped_budget']]);
            assert.equal(d.denied, null);
            assert.equal(d.code, 0);
            assert.equal(d.stdout, '');
            assert.match(d.stderr, /advisory gate swe-atomic-close ran out of the \d+ ms group budget/);
        });
        it('the enforcement gate\'s own block still stands', async () => {
            const d = await decide('SubagentStop', stopPayload(), {}, overrunningClose(() => blocks('persist first')));
            assert.deepEqual(d.denied, { gate: 'consultant-persistence-gate', reason: 'persist first' });
            assert.equal(d.stdout, blocks('persist first').stdout);
        });
    });
    it('a block with no context prints the gate\'s own bytes', async () => {
        const d = await decide('SubagentStop', stopPayload(), {}, { findGate: fakes({ 'swe-atomic-close': () => ALLOW, 'consultant-persistence-gate': () => blocks('persist first') }) });
        assert.equal(d.stdout, blocks('persist first').stdout);
    });
    it('an exit 2 stays as it is: Claude Code reads its stderr, not stdout', async () => {
        const d = await decide('SubagentStop', stopPayload(), {}, { findGate: fakes({ 'swe-atomic-close': () => contextOn('SubagentStop', 'task closed'), 'consultant-persistence-gate': () => ({ stdout: '', code: 2 }) }) });
        assert.equal(d.code, 2);
        assert.equal(d.stdout, '');
    });
    it('a PreToolUse deny stays byte-identical, whatever context the other gates printed', async () => {
        const d = await decide('PreToolUse', bash('ls'), {}, { groups: group(['a', 'advisory'], ['b', 'enforcement']), findGate: fakes({ a: () => context('ctx'), b: () => deny('no') }) });
        assert.equal(d.stdout, deny('no').stdout);
    });
});
describe('router events: groups, table and dedupe keys (GH 1692 R3)', () => {
    const mcp = (suffix) => `mcp__plugin_tmb_trajectory-server__${suffix}`;
    const names = (event, tool) => routerGates(event, tool).map((g) => g.name);
    it('an empty matcher fits every call of its event, with or without a tool name', () => {
        assert.equal(matcherFits('', ''), true);
        assert.equal(matcherFits('', 'Bash'), true);
        assert.equal(matcherFits('Bash', ''), false);
        assert.deepEqual(names('Stop', ''), ['bro-turn-usage']);
        assert.deepEqual(names('SubagentStop', ''), ['consultant-persistence-gate', 'swe-atomic-close']);
    });
    it('the post-tool groups run in the order the spec names, each tool-filtered gate only for its tools', () => {
        assert.deepEqual(names('PostToolUse', mcp('task_update_status')), ['cleanup-worktree-on-task-close', 'task-overrun-alert']);
        assert.deepEqual(names('PostToolUse', mcp('validation_record')), ['cleanup-worktree-on-task-close', 'task-overrun-alert']);
        assert.deepEqual(names('PostToolUse', mcp('roundtable_close')), ['roundtable-cleanup-postcheck', 'task-overrun-alert']);
        assert.deepEqual(names('PostToolUse', mcp('bro_atomic_close')), ['post-task-close-rescan', 'post-atomic-close-readme', 'task-overrun-alert']);
        assert.deepEqual(names('PostToolUse', mcp('task_create_batch')), ['post-task-create-spawn-hint', 'task-overrun-alert']);
        assert.deepEqual(names('PostToolUse', mcp('issue_list')), ['task-overrun-alert']);
        assert.deepEqual(names('PostToolUse', 'Bash'), ['attribution-footer', 'clean-merged-branch', 'close-issue-on-merge']);
        assert.deepEqual(names('PostToolUse', 'Agent'), ['swe-spawn-bind']);
        assert.deepEqual(names('PermissionDenied', 'Agent'), ['swe-spawn-rollback']);
        assert.deepEqual(names('PostToolUse', 'Read'), []);
    });
    it('decide skips a tool-filtered gate for another tool', async () => {
        const ran = [];
        const spy = (name) => () => {
            ran.push(name);
            return ALLOW;
        };
        await decide('PostToolUse', JSON.stringify({ tool_name: mcp('issue_list'), tool_input: {} }), {}, { findGate: spy });
        assert.deepEqual(ran, ['task-overrun-alert']);
    });
    it('the table is one line per row, an empty matcher as its sentinel, six columns and a seventh for a part', () => {
        const lines = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks-router.txt'), 'utf8').trimEnd().split('\n');
        const rows = lines.map((l) => l.split(' '));
        for (const f of rows)
            assert.equal(f.length, f[6] === undefined ? 6 : 7, f.join(' '));
        assert.equal(rows.filter((f) => f[0] === 'cleanup-worktree-on-task-close').length, 2);
        assert.deepEqual(rows.filter((f) => f[3] === 'Stop').map((f) => [f[0], f[4], f[5]]), [['bro-turn-usage', EMPTY_MATCHER_COLUMN, '*'], ['session-handoff', EMPTY_MATCHER_COLUMN, '*']]);
        assert.deepEqual(rows.filter((f) => f[3] === 'SubagentStop').map((f) => [f[0], f[2], f[4]]), [['consultant-persistence-gate', 'enforcement', '-'], ['swe-atomic-close', 'advisory', '-']]);
        assert.equal(matcherColumn(''), '-');
        assert.equal(matcherColumn('Bash'), 'Bash');
        assert.equal(matcherOfColumn('-'), '');
        assert.equal(matcherOfColumn('Bash'), 'Bash');
    });
    it('SessionStart keys on event, session and part; UserPromptSubmit on its payload and part', () => {
        const start = (source, session = 's') => JSON.stringify({ hook_event_name: 'SessionStart', session_id: session, source });
        assert.equal(dedupeKey(start('startup'), 'SessionStart'), dedupeKey(start('resume'), 'SessionStart'));
        assert.notEqual(dedupeKey(start('startup'), 'SessionStart'), dedupeKey(start('startup', 'other'), 'SessionStart'));
        assert.notEqual(dedupeKey(start('startup'), 'SessionStart'), dedupeKey(start('startup'), 'SessionStart', 'persona'));
        assert.notEqual(dedupeKey(start('startup'), 'SessionStart', 'persona'), dedupeKey(start('startup'), 'SessionStart', 'prescan'));
        const prompt = (text) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: text });
        assert.equal(dedupeKey(prompt('a'), 'UserPromptSubmit', 'persona'), dedupeKey(prompt('a'), 'UserPromptSubmit', 'persona'));
        assert.notEqual(dedupeKey(prompt('a'), 'UserPromptSubmit', 'persona'), dedupeKey(prompt('b'), 'UserPromptSubmit', 'persona'));
        assert.notEqual(dedupeKey(prompt('a'), 'UserPromptSubmit'), dedupeKey(prompt('a'), 'UserPromptSubmit', 'persona'));
        assert.notEqual(dedupeKey(prompt('a'), 'UserPromptSubmit', 'persona'), dedupeKey(prompt('a'), 'UserPromptSubmit', 'roundtable'));
    });
    it('a payload with no tool_name keys on the whole payload, key order aside; a tool payload still on its call', () => {
        assert.equal(dedupeKey('{"session_id":"s","a":1}'), dedupeKey('{"a":1,"session_id":"s"}'));
        assert.notEqual(dedupeKey('{"session_id":"s","a":1}'), dedupeKey('{"session_id":"s","a":2}'));
        assert.equal(dedupeKey('[1]'), null);
        assert.equal(dedupeKey('{not json'), null);
        const call = { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't' };
        assert.equal(dedupeKey(JSON.stringify(call)), dedupeKey(JSON.stringify({ ...call, tool_response: { stdout: 'other' } })));
    });
});
describe('router plain-text context (GH 1692 R4)', () => {
    const plain = (stdout) => () => ({ stdout, code: 0 });
    const json = (text) => () => ({ stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`, code: 0 });
    const eventGroup = (event, ...names) => [{ event, matcher: '', groupBudgetMs: 5000, gates: names.map((name) => ({ name, kind: 'advisory', budgetMs: 1000 })) }];
    const payload = (event) => JSON.stringify({ hook_event_name: event, session_id: 's', prompt: 'p' });
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
        it(`${event}: a lone plain output passes through byte for byte`, async () => {
            const text = '[Persona loaded by the hook]\n\n  # You are bro\n\n\ttabbed {not json} line\n\n';
            const d = await decide(event, payload(event), {}, { groups: eventGroup(event, 'a'), findGate: fakes({ a: plain(text) }) });
            assert.equal(d.stdout, text);
            assert.equal(d.stderr, '');
            assert.deepEqual(d.gates.map((g) => g.outcome), ['allow']);
        });
        it(`${event}: a lone JSON output stays JSON`, async () => {
            const d = await decide(event, payload(event), {}, { groups: eventGroup(event, 'a'), findGate: fakes({ a: json('ctx') }) });
            assert.deepEqual(JSON.parse(d.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } });
        });
        it(`${event}: plain and JSON outputs merge in group order, the plain text exact`, async () => {
            const first = 'plain one\n  indented\ttext';
            const d = await decide(event, payload(event), {}, { groups: eventGroup(event, 'a', 'b', 'c'), findGate: fakes({ a: plain(`${first}\n`), b: json('from json'), c: plain('[last] plain') }) });
            const out = JSON.parse(d.stdout);
            assert.equal(out.hookSpecificOutput.additionalContext, `${first}\n\nfrom json\n\n[last] plain`);
            assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
        });
        it(`${event}: a JSON-shaped output that fails to parse is dropped and logged, the others kept`, async () => {
            for (const broken of ['{"hookSpecificOutput":', '["a",']) {
                const d = await decide(event, payload(event), {}, { groups: eventGroup(event, 'bad', 'good'), findGate: fakes({ bad: plain(broken), good: plain('still here\n') }) });
                assert.equal(d.stdout, 'still here\n', broken);
                assert.match(d.stderr, /advisory gate bad printed unparseable output — output dropped/);
                assert.deepEqual(d.gates.map((g) => g.outcome), ['error', 'allow']);
            }
        });
        it(`${event}: deny words in plain text are text, not a decision`, async () => {
            const text = 'quotes "decision": "block" in prose\n';
            const d = await decide(event, payload(event), {}, { groups: eventGroup(event, 'a'), findGate: fakes({ a: plain(text) }) });
            assert.equal(d.denied, null);
            assert.equal(d.stdout, text);
        });
    }
    it('an event that reads no plain context still drops plain text', async () => {
        const d = await decide('Stop', payload('Stop'), {}, { groups: eventGroup('Stop', 'a'), findGate: fakes({ a: plain('words\n') }) });
        assert.equal(d.stdout, '');
        assert.match(d.stderr, /advisory gate a printed unparseable output/);
    });
});
describe('router docs describe what is routed (GH 1692 R3)', () => {
    const doc = (rel) => readFileSync(join(PLUGIN_ROOT, rel), 'utf8');
    it('the changelog names the SubagentStop order, in the fragment or the release it was assembled into', () => {
        const fragment = 'changelog.d/1692-ts-router-post-stop.md';
        const text = doc(existsSync(join(PLUGIN_ROOT, fragment)) ? fragment : 'CHANGELOG.md');
        assert.match(text, /`consultant-persistence-gate`[^\n]*now runs before `swe-atomic-close`/);
    });
    it('CONTAINMENT.md does not limit the router to PreToolUse', () => {
        assert.doesNotMatch(doc('docs/architecture/CONTAINMENT.md'), /command outside PreToolUse is|every PreToolUse command is the router/);
    });
    it('hook_call is described as written on every routed event, in the source and its generated doc', () => {
        for (const rel of ['mcp/trajectory-server/src/audit-events.ts', 'docs/contributing/ENUMS.md']) {
            assert.doesNotMatch(doc(rel), /The PreToolUse router \(/, rel);
        }
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
describe('TMB_HOOKS_IMPL=bash: the router runs each gate as its .sh (F287-6)', () => {
    const HANG_S = 30;
    let root;
    before(() => {
        root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-router-sh-')));
        mkdirSync(join(root, 'scripts/hooks'), { recursive: true });
        writeFileSync(join(root, 'scripts/hooks/says-context.sh'), `cat >/dev/null\nprintf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from the sh"}}\\n'\n`);
        writeFileSync(join(root, 'scripts/hooks/says-deny.sh'), `cat >/dev/null\nprintf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"the sh says no"}}\\n'\n`);
        writeFileSync(join(root, 'scripts/hooks/exits-3.sh'), 'exit 3\n');
        writeFileSync(join(root, 'scripts/hooks/hangs.sh'), `trap '' TERM\nsleep ${HANG_S}\n`);
    });
    after(() => rmSync(root, { recursive: true, force: true }));
    const shEnv = () => ({ ...process.env, TMB_HOOKS_IMPL: 'bash', CLAUDE_PLUGIN_ROOT: root });
    it('a gate with a .sh answers from its .sh, not from the TypeScript registry', async () => {
        const d = await decide('PreToolUse', bash('ls'), shEnv(), { groups: group(['says-context', 'enforcement']) });
        assert.deepEqual(JSON.parse(d.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'from the sh' } });
        assert.equal(d.denied, null);
    });
    it('a .sh deny is the router deny, named by its gate', async () => {
        const d = await decide('PreToolUse', bash('ls'), shEnv(), { groups: group(['says-context', 'advisory'], ['says-deny', 'enforcement']) });
        assert.deepEqual(d.denied, { gate: 'says-deny', reason: 'the sh says no' });
    });
    it('an enforcement gate with no .sh denies naming itself; an advisory one is dropped and logged', async () => {
        const denied = await decide('PreToolUse', bash('ls'), shEnv(), { groups: group(['no-such-gate', 'enforcement']) });
        assert.equal(denied.denied?.gate, 'no-such-gate');
        assert.match(reasonOf(denied.stdout), /^BLOCKED: TMB gate no-such-gate exited 1 without a decision/);
        assert.match(denied.stderr, /TMB_HOOKS_IMPL=bash runs only \.sh gates/);
        const dropped = await decide('PreToolUse', bash('ls'), shEnv(), { groups: group(['no-such-gate', 'advisory']) });
        assert.equal(dropped.denied, null);
        assert.equal(dropped.stdout, '');
        assert.match(dropped.stderr, /advisory gate no-such-gate exited 1 — output dropped/);
    });
    it('the real swe-resume-gate, born in TypeScript, denies under the switch as dispatch.sh refusing it does', async () => {
        const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: {}, tool_use_id: 't' });
        const d = await decide('PreToolUse', payload, { ...process.env, TMB_HOOKS_IMPL: 'bash', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
        assert.equal(d.denied?.gate, 'swe-resume-gate');
    });
    it('a .sh exiting other than 0 or 2 fails closed as a gate does', async () => {
        const d = await decide('PreToolUse', bash('ls'), shEnv(), { groups: group(['exits-3', 'enforcement']) });
        assert.match(reasonOf(d.stdout), /^BLOCKED: TMB gate exits-3 exited 3 without a decision/);
    });
    it('a .sh that holds SIGTERM still ends at the gate budget, and denies by name', async () => {
        const d = await decide('PreToolUse', bash('ls'), shEnv(), { groups: group(['hangs', 'enforcement', 300]) });
        assert.match(reasonOf(d.stdout), /^BLOCKED: TMB gate hangs timed out after 300 ms/);
    });
    it('with no switch the same group runs the TypeScript registry', async () => {
        const d = await decide('PreToolUse', bash('ls'), { ...process.env, CLAUDE_PLUGIN_ROOT: root }, { groups: group(['says-context', 'advisory']) });
        assert.equal(d.stdout, '');
        assert.match(d.stderr, /unknown gate 'says-context'/);
    });
    it('every gate of the R4 events runs under the switch but those born in TypeScript, dropped and logged', async () => {
        const events = ['SessionStart', 'UserPromptSubmit', 'WorktreeCreate'];
        const gates = ROUTER_GROUPS.filter((g) => events.includes(g.event)).flatMap((g) => g.gates.map((x) => x.name));
        assert.deepEqual(gates.filter((name) => !existsSync(join(PLUGIN_ROOT, 'scripts/hooks', `${name}.sh`))), ['rework-waiver-capture', 'task-overrun-alert']);
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-router-sh-events-')));
        const env = { ...process.env, TMB_HOOKS_IMPL: 'bash', CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, PWD: dir, TMB_SKIP_MCP_DEPS_INSTALL: '1', TRAJECTORY_DB_PATH: join(dir, 'absent.db') };
        try {
            const start = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'sh-events', source: 'startup', cwd: dir });
            const persona = await decide('SessionStart', start, env, { part: 'persona' });
            assert.match(persona.stdout, /You are bro/);
            assert.deepEqual(persona.gates.map((g) => g.gate), ['session-start-persona']);
            const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sh-events', prompt: 'hi', cwd: dir });
            const defaults = await decide('UserPromptSubmit', prompt, env);
            assert.equal(defaults.denied, null);
            assert.match(defaults.stderr, /advisory gate rework-waiver-capture exited 1 — output dropped/);
            const worktree = await decide('WorktreeCreate', JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: 'sh-events', name: 'n', cwd: dir }), env);
            assert.deepEqual(worktree.gates.map((g) => g.gate), ['worktree-create']);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('the switch reaches a real .sh through the bundle: askuserquestion-length-lint.sh answers', () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-router-sh-real-')));
        try {
            const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_use_id: 'real', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'q', multiSelect: false, options: [{ label: 'one two three four five six seven eight' }] }] } });
            const out = execFileSync(process.execPath, [join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js'), 'PreToolUse'], {
                input: payload,
                encoding: 'utf8',
                cwd: dir,
                env: { ...process.env, TMB_HOOKS_IMPL: 'bash', CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, TMB_INSTALLED_JSON: join(dir, 'none.json') },
            });
            assert.match(out, /label is 8 words/);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
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
    async function call(payload, findGate, groups, event = 'PreToolUse', part) {
        let stdout = '';
        let stderr = '';
        const code = await routerMain(event, env(), {
            readStdin: () => payload,
            writeStdout: async (t) => {
                stdout += t;
            },
            writeStderr: (t) => {
                stderr += t;
            },
        }, { findGate, groups, part, hop: false, selfRoot: PLUGIN_ROOT });
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
    for (const event of ['Stop', 'SubagentStop']) {
        it(`a ${event} payload with no tool_name runs its group, and its duplicate runs nothing`, async () => {
            let runs = 0;
            const findGate = () => () => {
                runs++;
                return ALLOW;
            };
            const payload = JSON.stringify({ hook_event_name: event, session_id: `sess-${event}`, stop_hook_active: false });
            const first = await call(payload, findGate, undefined, event);
            assert.equal(first.code, 0);
            const ran = routerGates(event, '').length;
            assert.equal(runs, ran);
            assert.ok(ran > 0);
            const second = await call(payload, findGate, undefined, event);
            assert.equal(second.code, 0);
            assert.equal(second.stdout, '');
            assert.equal(runs, ran);
        });
    }
    describe('parts of one event (GH 1692 R4)', () => {
        const parted = (event) => [
            { event, matcher: '', groupBudgetMs: 5000, gates: [{ name: 'main', kind: 'advisory', budgetMs: 1000 }] },
            { event, matcher: '', part: 'persona', groupBudgetMs: 5000, gates: [{ name: 'p', kind: 'advisory', budgetMs: 1000 }] },
        ];
        for (const event of ['SessionStart', 'UserPromptSubmit']) {
            it(`${event}: each part runs its own gates, its duplicate nothing, and no part answers for another`, async () => {
                const ran = [];
                const findGate = (name) => () => {
                    ran.push(name);
                    return { stdout: `from ${name}\n`, code: 0 };
                };
                const payload = JSON.stringify({ hook_event_name: event, session_id: `sess-parts-${event}`, prompt: 'p' });
                const groups = parted(event);
                assert.equal((await call(payload, findGate, groups, event)).stdout, 'from main\n');
                assert.equal((await call(payload, findGate, groups, event, 'persona')).stdout, 'from p\n');
                assert.equal((await call(payload, findGate, groups, event, 'persona')).stdout, '');
                assert.equal((await call(payload, findGate, groups, event)).stdout, '');
                assert.deepEqual(ran, ['main', 'p']);
            });
        }
        it('a part no group holds runs nothing', async () => {
            const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'sess-no-part' });
            const r = await call(payload, () => () => ({ stdout: 'ran\n', code: 0 }), parted('SessionStart'), 'SessionStart', 'absent');
            assert.equal(r.code, 0);
            assert.equal(r.stdout, '');
        });
    });
    describe('WorktreeCreate prints the path or fails (GH 1692 R4)', () => {
        const wt = (session) => JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: session, name: 'n', cwd: project });
        const wtGroup = (over = {}) => [
            { event: 'WorktreeCreate', matcher: '', groupBudgetMs: over.groupBudgetMs ?? 5000, gates: [{ name: 'wt', kind: over.kind ?? 'advisory', budgetMs: over.budgetMs ?? 1000 }] },
        ];
        const failed = (r, cause) => {
            assert.equal(r.stdout, '');
            assert.notEqual(r.code, 0);
            assert.match(r.stderr, cause);
        };
        it('prints the bare path and nothing else', async () => {
            const r = await call(wt('wt-ok'), fakes({ wt: () => ({ stdout: '/a b/.claude/worktrees/n\n', code: 0 }) }), wtGroup(), 'WorktreeCreate');
            assert.equal(r.code, 0);
            assert.equal(r.stdout, '/a b/.claude/worktrees/n\n');
        });
        it('a duplicate within the window replays the path and runs nothing', async () => {
            let runs = 0;
            const gates = fakes({ wt: () => (runs++, { stdout: '/p/dupe\n', code: 0 }) });
            const first = await call(wt('wt-dupe'), gates, wtGroup(), 'WorktreeCreate');
            const second = await call(wt('wt-dupe'), gates, wtGroup(), 'WorktreeCreate');
            assert.equal(runs, 1);
            assert.equal(first.stdout, '/p/dupe\n');
            assert.equal(second.stdout, '/p/dupe\n');
            assert.equal(second.code, 0);
        });
        it('a duplicate of a failure replays the failure', async () => {
            const gates = fakes({ wt: () => ({ stdout: '', code: 1 }) });
            const first = await call(wt('wt-dupe-fail'), gates, wtGroup(), 'WorktreeCreate');
            failed(first, /WorktreeCreate failed/);
            failed(await call(wt('wt-dupe-fail'), gates, wtGroup(), 'WorktreeCreate'), /WorktreeCreate failed/);
        });
        it('a gate failure', async () => {
            failed(await call(wt('wt-fail'), fakes({ wt: () => ({ stdout: '/ignored\n', code: 1 }) }), wtGroup(), 'WorktreeCreate'), /WorktreeCreate failed: gate wt ended in error/);
        });
        it('a gate throwing', async () => {
            const r = await call(wt('wt-throw'), fakes({ wt: () => { throw new Error('boom'); } }), wtGroup(), 'WorktreeCreate');
            failed(r, /boom[\s\S]*WorktreeCreate failed: gate wt ended in error/);
        });
        it('a gate timeout', async () => {
            const r = await call(wt('wt-late'), fakes({ wt: () => new Promise(() => { }) }), wtGroup({ budgetMs: 30 }), 'WorktreeCreate');
            failed(r, /ran past its 30 ms budget[\s\S]*WorktreeCreate failed: gate wt ended in skipped_budget/);
        });
        it('a budget skip', async () => {
            failed(await call(wt('wt-skip'), fakes({ wt: () => ({ stdout: '/ignored\n', code: 0 }) }), wtGroup({ groupBudgetMs: 0 }), 'WorktreeCreate'), /got no time[\s\S]*WorktreeCreate failed: gate wt ended in skipped_budget/);
        });
        it('an unparseable payload', async () => {
            failed(await call('{not json', fakes({}), wtGroup(), 'WorktreeCreate'), /WorktreeCreate failed: an unparseable payload/);
        });
        it('a gate printing no path, or more than a path', async () => {
            failed(await call(wt('wt-empty'), fakes({ wt: () => ALLOW }), wtGroup(), 'WorktreeCreate'), /WorktreeCreate failed: no bare path printed/);
            failed(await call(wt('wt-two'), fakes({ wt: () => ({ stdout: '/a\n/b\n', code: 0 }) }), wtGroup(), 'WorktreeCreate'), /WorktreeCreate failed: no bare path printed/);
        });
        it('a JSON answer is no path, whichever way the gate prints it', async () => {
            failed(await call(wt('wt-json'), fakes({ wt: () => ({ stdout: '{"continue":true}\n', code: 0 }) }), wtGroup(), 'WorktreeCreate'), /WorktreeCreate failed: no bare path printed/);
        });
        it('a deny from a gate', async () => {
            failed(await call(wt('wt-deny'), fakes({ wt: () => ({ stdout: '{"decision":"block","reason":"no"}\n', code: 2 }) }), wtGroup(), 'WorktreeCreate'), /WorktreeCreate failed/);
        });
        it('the audit row of a failure says failed', async () => {
            const before = rows('hook_call').length;
            await call(wt('wt-audit'), fakes({ wt: () => ({ stdout: '', code: 1 }) }), wtGroup(), 'WorktreeCreate');
            const added = rows('hook_call').slice(before);
            assert.equal(added.length, 1);
            assert.equal(JSON.parse(added[0].content_json).decision, 'failed');
        });
    });
    describe('a hop needs the event and part in the target table (GH 2207)', () => {
        const install = (name, table, bundleSource = "process.stdout.write('hop:' + process.argv.slice(2).join(' ') + '\\n');\n") => {
            const root = join(base, name);
            const manifest = join(root, 'mcp/trajectory-server/dist/hooks-router.txt');
            mkdirSync(dirname(manifest), { recursive: true });
            writeFileSync(manifest, table);
            writeFileSync(join(root, 'mcp/trajectory-server/dist/hooks.js'), bundleSource);
            const installed = join(base, `${name}.json`);
            writeFileSync(installed, JSON.stringify({ plugins: { 'tmb@trustmybot-dev': [{ scope: 'project', projectPath: project, installPath: root }] } }));
            return installed;
        };
        const OLD_TABLE = 'containment-guard 5000 enforcement PreToolUse Bash *\n';
        async function viaHop(installed, event, payload, part, gate = () => ({ stdout: 'local\n', code: 0 })) {
            let stdout = '';
            let stderr = '';
            const code = await routerMain(event, { ...env(), TMB_INSTALLED_JSON: installed }, { readStdin: () => payload, writeStdout: async (t) => void (stdout += t), writeStderr: (t) => void (stderr += t) }, { part, selfRoot: PLUGIN_ROOT, findGate: () => gate });
            return { code, stdout, stderr };
        }
        it('with an unparseable payload and an older target, Stop logs and exits 0, with no unknown gate', async () => {
            const r = await viaHop(install('old-stop', OLD_TABLE), 'Stop', '{not json');
            assert.equal(r.code, 0);
            assert.equal(r.stdout, '');
            assert.match(r.stderr, /Stop got an unparseable payload — no gate run/);
            assert.doesNotMatch(r.stderr, /unknown gate/);
            assert.doesNotMatch(r.stdout, /hop:/);
        });
        it('with an unparseable payload and an older target, SubagentStop still blocks, with no unknown gate', async () => {
            const r = await viaHop(install('old-substop', OLD_TABLE), 'SubagentStop', '{not json');
            assert.equal(r.code, 0);
            assert.equal(JSON.parse(r.stdout).decision, 'block');
            assert.doesNotMatch(r.stderr, /unknown gate/);
        });
        it('with an unparseable payload, a target that has the event answers', async () => {
            const r = await viaHop(install('new-stop', 'bro-turn-usage 5000 advisory Stop - *\n'), 'Stop', '{not json');
            assert.equal(r.stdout, 'hop:Stop\n');
        });
        it('a target with the event but not the part does not answer for that part', async () => {
            const installed = install('old-part', 'ensure-gitignore 5000 advisory SessionStart - *\n');
            const payload = (id) => JSON.stringify({ hook_event_name: 'SessionStart', session_id: id });
            const persona = await viaHop(installed, 'SessionStart', payload('hop-part-a'), 'persona');
            assert.equal(persona.stdout, 'local\n');
            assert.equal((await viaHop(installed, 'SessionStart', payload('hop-part-b'))).stdout, 'hop:SessionStart\n');
        });
        it('a target with the part gets it as its second argument, and no row of a part answers for the default', async () => {
            const installed = install('new-part', 'session-start-persona 5000 advisory SessionStart - * persona\n');
            const payload = (id) => JSON.stringify({ hook_event_name: 'SessionStart', session_id: id });
            assert.equal((await viaHop(installed, 'SessionStart', payload('hop-part-c'), 'persona')).stdout, 'hop:SessionStart persona\n');
            assert.notEqual((await viaHop(installed, 'SessionStart', payload('hop-part-d'))).stdout, 'hop:SessionStart\n');
        });
        it('WorktreeCreate: a failed hop prints no stdout, names the cause and exits non-zero', async () => {
            const table = 'worktree-create 5000 advisory WorktreeCreate - *\n';
            const payload = (id) => JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: id, name: 'n' });
            for (const [name, source, code] of [['exits', 'process.exit(3);\n', 3], ['chatty', "process.stdout.write('{\"continue\":true}\\n');\n", 1], ['silent', '', 1]]) {
                const r = await viaHop(install(`wt-hop-${name}`, table, source), 'WorktreeCreate', payload(`hop-wt-${name}`));
                assert.equal(r.stdout, '', name);
                assert.equal(r.code, code, name);
                assert.match(r.stderr, /WorktreeCreate failed: .* answered exit \d+ with no bare path/, name);
            }
        });
        it('WorktreeCreate: a hop that answers a path passes it through', async () => {
            const r = await viaHop(install('wt-hop-ok', 'worktree-create 5000 advisory WorktreeCreate - *\n', "process.stdout.write('/there/n\\n');\n"), 'WorktreeCreate', JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: 'hop-wt-ok', name: 'n' }));
            assert.equal(r.code, 0);
            assert.equal(r.stdout, '/there/n\n');
        });
    });
    it('a call no group matches leaves no lock behind', async () => {
        const locks = join(dirname(db), 'locks/events');
        const before = existsSync(locks) ? readdirSync(locks).length : 0;
        const r = await call(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sess-none', tool_name: 'Read', tool_input: {}, tool_use_id: 'none' }), fakes({}), undefined, 'PostToolUse');
        assert.equal(r.code, 0);
        assert.equal(r.stdout, '');
        assert.equal(existsSync(locks) ? readdirSync(locks).length : 0, before);
    });
    it('an unjudged deny records no path', async () => {
        const r = await call(bash('touch "$X"', { tool_use_id: 'deny-unjudged', session_id: 'sess-unjudged', cwd: project }), fakes({ g: () => deny('BLOCKED: write target "$X" cannot be judged: it names a variable') }), group(['g', 'enforcement']));
        assert.equal(r.code, 0);
        assert.equal(existsSync(join(dirname(db), 'locks/boundary-denies/sess-unjudged')), false);
    });
});
//# sourceMappingURL=router.test.js.map