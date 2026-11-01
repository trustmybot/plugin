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
import { ALLOW, type Gate, type GateResult } from '../hooks/gate.js';
import { armDeadline, disarmDeadline, noteSpawn, spawnLimit } from '../hooks/lib/deadline.js';
import { gitRun } from '../hooks/lib/git.js';
import { eventHoldsEnforcement, matcherFits, type RouterGroup, ROUTER_GROUPS, routerGates, routerGroup, routerTimeoutS } from '../hooks/registry.js';
import { decide, denyOutput, mergeContext } from '../hooks/router/decide.js';
import { dedupeKey } from '../hooks/router/dedupe.js';
import { routerMain } from '../hooks/router/main.js';
import { EMPTY_MATCHER_COLUMN, matcherColumn, matcherOfColumn } from '../hooks/router/table.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');

const deny = (reason: string): GateResult => ({
  stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`,
  code: 0,
});
const context = (text: string): GateResult => ({
  stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`,
  code: 0,
});

const BASH_GROUP = routerGroup('PreToolUse', 'Bash') as RouterGroup;

function group(...gates: [string, 'enforcement' | 'advisory', number?][]): RouterGroup[] {
  return [{ event: 'PreToolUse', matcher: 'Bash', groupBudgetMs: BASH_GROUP.groupBudgetMs, gates: gates.map(([name, kind, budgetMs]) => ({ name, kind, budgetMs: budgetMs ?? 5000 })) }];
}

function bash(command: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu-1', ...extra });
}

function reasonOf(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
}

function fakes(map: Record<string, Gate>): (name: string) => Gate | undefined {
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
      const { hookSpecificOutput: o } = JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string; additionalContext: string } };
      assert.equal(o.permissionDecision, 'ask');
      assert.match(o.additionalContext, /label is 8 words/);
    } finally {
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
  const cases: [string, Gate | undefined, RegExp][] = [
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
    const busy: Gate = () => {
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
    const quick: Gate = async () => {
      await new Promise((r) => setImmediate(r));
      return ALLOW;
    };
    const heavy: Gate = async () => {
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
    const log: string[] = [];
    const gate = (name: string): Gate => async () => {
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
  const toolCall = (tool: string, input: Record<string, unknown> = {}): string => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });
  const names = (tool: string): string[] => routerGates('PreToolUse', tool).map((g) => g.name);
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
    const seen: string[] = [];
    const gate = (name: string): Gate => () => (seen.push(name), ALLOW);
    const groups: RouterGroup[] = [
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
    const seen: string[] = [];
    const gate = (name: string): Gate => () => (seen.push(name), deny(`${name} denies`));
    const groups: RouterGroup[] = [
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
    const seen: string[] = [];
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
    const names = ROUTER_GROUPS.flatMap((g) => g.matcher.split('|').map((m) => `${g.event} ${m}`));
    assert.equal(names.length, new Set(names).size);
    assert.equal(routerGroup('PreToolUse', 'Write')?.matcher, 'Write|Edit|MultiEdit|NotebookEdit');
  });
});

const EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionDenied', 'Stop', 'SubagentStop'] as const;

function eventGroups(event: string, ...gates: [string, 'enforcement' | 'advisory', number?][]): RouterGroup[] {
  return [{ event, matcher: '', groupBudgetMs: 60_000, gates: gates.map(([name, kind, budgetMs]) => ({ name, kind, budgetMs: budgetMs ?? 5000 })) }];
}

const stopPayload = (extra: Record<string, unknown> = {}): string => JSON.stringify({ session_id: 'sess-stop', stop_hook_active: false, ...extra });

function reasonFor(event: string, stdout: string): string {
  const out = JSON.parse(stdout) as { decision?: string; reason?: string; hookSpecificOutput?: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
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
      const failing: [string, Gate | undefined, RegExp][] = [
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
      const plain = (text: string): string => JSON.stringify({ hookSpecificOutput: { additionalContext: text } });
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
  const contextOn = (event: string, text: string): GateResult => ({ stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`, code: 0 });
  const blocks = (reason: string): GateResult => ({ stdout: `${JSON.stringify({ decision: 'block', reason })}\n`, code: 0 });

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
    const out = JSON.parse(d.stdout) as { decision: string; reason: string; hookSpecificOutput: { additionalContext: string } };
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /TMB gate consultant-persistence-gate exited 1/);
    assert.equal(out.hookSpecificOutput.additionalContext, 'task closed');
  });

  describe('an advisory gate overruns the group budget', () => {
    const overrunningClose = (consultant: Gate) => {
      const { groupBudgetMs } = routerGroup('SubagentStop', '') as RouterGroup;
      let clock = 0;
      const timedConsultant: Gate = (payload, env) => {
        clock += 1;
        return consultant(payload, env);
      };
      const overrun: Gate = () => {
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
  const mcp = (suffix: string): string => `mcp__plugin_tmb_trajectory-server__${suffix}`;
  const names = (event: string, tool: string): string[] => routerGates(event, tool).map((g) => g.name);

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
    const ran: string[] = [];
    const spy = (name: string): Gate | undefined => () => {
      ran.push(name);
      return ALLOW;
    };
    await decide('PostToolUse', JSON.stringify({ tool_name: mcp('issue_list'), tool_input: {} }), {}, { findGate: spy });
    assert.deepEqual(ran, ['task-overrun-alert']);
  });

  it('the table is one line per row, an empty matcher as its sentinel, every line six columns', () => {
    const lines = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks-router.txt'), 'utf8').trimEnd().split('\n');
    for (const line of lines) assert.equal(line.split(' ').length, 6, line);
    const rows = lines.map((l) => l.split(' '));
    assert.equal(rows.filter((f) => f[0] === 'cleanup-worktree-on-task-close').length, 2);
    assert.deepEqual(rows.filter((f) => f[3] === 'Stop').map((f) => [f[0], f[4], f[5]]), [['bro-turn-usage', EMPTY_MATCHER_COLUMN, '*']]);
    assert.deepEqual(rows.filter((f) => f[3] === 'SubagentStop').map((f) => [f[0], f[2], f[4]]), [['consultant-persistence-gate', 'enforcement', '-'], ['swe-atomic-close', 'advisory', '-']]);
    assert.equal(matcherColumn(''), '-');
    assert.equal(matcherColumn('Bash'), 'Bash');
    assert.equal(matcherOfColumn('-'), '');
    assert.equal(matcherOfColumn('Bash'), 'Bash');
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

describe('router docs describe what is routed (GH 1692 R3)', () => {
  const doc = (rel: string): string => readFileSync(join(PLUGIN_ROOT, rel), 'utf8');

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
  let bin: string;
  let env: NodeJS.ProcessEnv;
  const viaGit: Gate = (_payload, gateEnv) => {
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
    const mcp = routerGroup('PreToolUse', 'mcp__plugin_tmb_trajectory-server__task_update_status') as RouterGroup;
    assert.ok(mcp.groupBudgetMs >= VERIFICATION_FLOOR_MS);
    assert.ok(BASH_GROUP.groupBudgetMs < VERIFICATION_FLOOR_MS / 10, `${BASH_GROUP.groupBudgetMs}`);
    assert.ok(routerTimeoutS(BASH_GROUP) < routerTimeoutS(mcp));
    assert.equal(BASH_GROUP.gates.some((g) => g.name === 'swe-verification-gate'), false);
  });

  it('a hung gate in the Bash group ends at the Bash budget, though a sibling group holds the verification floor', async () => {
    const groups: RouterGroup[] = [
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
  let bin: string;
  let env: NodeJS.ProcessEnv;
  const viaGit: Gate = (_payload, gateEnv) => {
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
    for (const g of d.gates) assert.ok(g.ms < HANG_S * 1000 && g.ms < routerTimeoutS(BASH_GROUP) * 1000, `${g.gate} ${g.ms} ms: git was not cut off`);
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
    } finally {
      disarmDeadline();
    }
  });
});

describe('TMB_HOOKS_IMPL=bash: the router runs each gate as its .sh (F287-6)', () => {
  const HANG_S = 30;
  let root: string;
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-router-sh-')));
    mkdirSync(join(root, 'scripts/hooks'), { recursive: true });
    writeFileSync(join(root, 'scripts/hooks/says-context.sh'), `cat >/dev/null\nprintf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from the sh"}}\\n'\n`);
    writeFileSync(join(root, 'scripts/hooks/says-deny.sh'), `cat >/dev/null\nprintf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"the sh says no"}}\\n'\n`);
    writeFileSync(join(root, 'scripts/hooks/exits-3.sh'), 'exit 3\n');
    writeFileSync(join(root, 'scripts/hooks/hangs.sh'), `trap '' TERM\nsleep ${HANG_S}\n`);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const shEnv = (): NodeJS.ProcessEnv => ({ ...process.env, TMB_HOOKS_IMPL: 'bash', CLAUDE_PLUGIN_ROOT: root });

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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('router entry: dedupe and records', () => {
  let base: string;
  let project: string;
  let db: string;
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

  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project, PWD: project, TMB_TEST_RUN_ID: 'router-test' };
    delete e.TRAJECTORY_DB_PATH;
    return e;
  };

  async function call(payload: string, findGate: (name: string) => Gate | undefined, groups?: RouterGroup[], event = 'PreToolUse'): Promise<{ code: number; stdout: string; stderr: string }> {
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
    }, { findGate, groups, hop: false, selfRoot: PLUGIN_ROOT });
    return { code, stdout, stderr };
  }

  function rows(type: string): { from_node: string; summary: string; content_json: string; issue_id: number }[] {
    const d = new DatabaseSync(db);
    try {
      return d.prepare('SELECT from_node, summary, content_json, issue_id FROM audit WHERE event_type = ? ORDER BY id').all(type) as never;
    } finally {
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
    const content = JSON.parse(calls[0].content_json) as { decision: string; gates: { gate: string; ms: number | null; outcome: string }[] };
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
    const groups: RouterGroup[] = [{ event: 'PreToolUse', matcher: 'Edit', groupBudgetMs: 5000, gates: [{ name: 'g', kind: 'enforcement', budgetMs: 1000 }] }];
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
    const run = async (payload: string): Promise<string> => {
      let stdout = '';
      await routerMain('PreToolUse', { ...env(), TMB_INSTALLED_JSON: installed }, { readStdin: () => payload, writeStdout: async (t) => void (stdout += t), writeStderr: () => {} }, {
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
      const findGate = (): Gate => () => {
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

  it('a call no group matches leaves no lock behind', async () => {
    const locks = join(dirname(db), 'locks/events');
    const before = existsSync(locks) ? readdirSync(locks).length : 0;
    const r = await call(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sess-none', tool_name: 'Read', tool_input: {}, tool_use_id: 'none' }), fakes({}), undefined, 'PostToolUse');
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(locks) ? readdirSync(locks).length : 0, before);
  });

  it('an unjudged deny records no path', async () => {
    const r = await call(
      bash('touch "$X"', { tool_use_id: 'deny-unjudged', session_id: 'sess-unjudged', cwd: project }),
      fakes({ g: () => deny('BLOCKED: write target "$X" cannot be judged: it names a variable') }),
      group(['g', 'enforcement']),
    );
    assert.equal(r.code, 0);
    assert.equal(existsSync(join(dirname(db), 'locks/boundary-denies/sess-unjudged')), false);
  });
});
