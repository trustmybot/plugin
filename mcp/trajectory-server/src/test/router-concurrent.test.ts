import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ALLOW, type Gate, type GateResult } from '../hooks/gate.js';
import type { RouterGroup } from '../hooks/registry.js';
import { type DecideDeps, decide } from '../hooks/router/decide.js';
import { routerMain } from '../hooks/router/main.js';

const deny = (reason: string): GateResult => ({
  stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`,
  code: 0,
});
const context = (text: string): GateResult => ({
  stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`,
  code: 0,
});

const PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't' });
const BUDGET_MS = 5000;

type Spec = [name: string, kind: 'enforcement' | 'advisory', budgetMs?: number];

function bashGroup(concurrent: boolean, ...gates: Spec[]): RouterGroup[] {
  return [{ event: 'PreToolUse', matcher: 'Bash', groupBudgetMs: BUDGET_MS, ...(concurrent ? { concurrent } : {}), gates: gates.map(([name, kind, budgetMs]) => ({ name, kind, budgetMs: budgetMs ?? BUDGET_MS })) }];
}

function deps(groups: RouterGroup[], gates: Record<string, Gate>): DecideDeps {
  return { groups, findGate: (name) => gates[name], parserWait: () => Promise.resolve() };
}

function signal(): { fired: Promise<void>; fire: () => void } {
  let fire = (): void => undefined;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
}

const reasonOf = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
const contextOf = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

describe('concurrent router group (GH 1692 R-async, decisions 937 and 1136)', () => {
  const held: NodeJS.Timeout[] = [];
  /** A gate wait nothing ends: decide's deadline timers are unref'd, so the test holds the loop open as routerMain does. */
  const stuck = (): Promise<GateResult> => {
    held.push(setInterval(() => undefined, 60_000));
    return new Promise<GateResult>(() => undefined);
  };
  afterEach(() => {
    for (const timer of held.splice(0)) clearInterval(timer);
  });

  it('the first deny in group order answers when a later gate finishes first', async () => {
    const lastDone = signal();
    const finished: string[] = [];
    const d = await decide('PreToolUse', PAYLOAD, {}, deps(bashGroup(true, ['first', 'enforcement'], ['allows', 'enforcement'], ['last', 'enforcement']), {
      first: async () => {
        await lastDone.fired;
        finished.push('first');
        return deny('first says no');
      },
      allows: () => ALLOW,
      last: async () => {
        finished.push('last');
        lastDone.fire();
        return deny('last says no');
      },
    }));
    assert.deepEqual(finished, ['last', 'first']);
    assert.equal(d.denied?.gate, 'first');
    assert.equal(d.denied?.reason, 'first says no');
    assert.equal(reasonOf(d.stdout), 'first says no');
    assert.deepEqual(d.gates.map((g) => [g.gate, g.outcome]), [['first', 'deny'], ['allows', 'allow'], ['last', 'deny']]);
  });

  it('context and stderr stay in registry order, whichever gate finished first', async () => {
    const lastDone = signal();
    const d = await decide('PreToolUse', PAYLOAD, {}, deps(bashGroup(true, ['one', 'advisory'], ['bad-a', 'advisory'], ['two', 'advisory'], ['bad-b', 'advisory']), {
      one: async () => {
        await lastDone.fired;
        return context('from one');
      },
      'bad-a': async () => {
        await lastDone.fired;
        return { stdout: '', code: 1 };
      },
      two: () => context('from two'),
      'bad-b': async () => {
        lastDone.fire();
        return { stdout: '', code: 1 };
      },
    }));
    assert.equal(contextOf(d.stdout), 'from one\n\nfrom two');
    assert.ok(d.stderr.includes('bad-a') && d.stderr.indexOf('bad-a') < d.stderr.indexOf('bad-b'), d.stderr);
  });

  it('an enforcement gate cut at its deadline denies naming itself, while its siblings still settle', async () => {
    let siblingSettled = false;
    const d = await decide('PreToolUse', PAYLOAD, {}, deps(bashGroup(true, ['allows', 'enforcement'], ['hung', 'enforcement', 40], ['slower', 'advisory']), {
      allows: () => ALLOW,
      hung: stuck,
      slower: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        siblingSettled = true;
        return context('sibling');
      },
    }));
    assert.equal(siblingSettled, true);
    assert.equal(d.denied?.gate, 'hung');
    assert.match(reasonOf(d.stdout), /^BLOCKED: TMB gate hung timed out after 40 ms/);
    assert.deepEqual(d.gates.map((g) => [g.gate, g.outcome]), [['allows', 'allow'], ['hung', 'deny'], ['slower', 'allow']]);
  });

  it('a slow advisory gate is skipped_budget and the answer is unaffected', async () => {
    const d = await decide('PreToolUse', PAYLOAD, {}, deps(bashGroup(true, ['allows', 'enforcement'], ['slow', 'advisory', 40], ['notes', 'advisory']), {
      allows: () => ALLOW,
      slow: stuck,
      notes: () => context('kept'),
    }));
    assert.equal(d.denied, null);
    assert.equal(d.code, 0);
    assert.deepEqual(d.gates.map((g) => [g.gate, g.outcome]), [['allows', 'allow'], ['slow', 'skipped_budget'], ['notes', 'allow']]);
    assert.equal(contextOf(d.stdout), 'kept');
    assert.match(d.stderr, /advisory gate slow ran past its 40 ms budget — skipped/);
  });

  it('gates overlap: one that resolves only after its sibling started completes', async () => {
    const started = signal();
    const d = await decide('PreToolUse', PAYLOAD, {}, deps(bashGroup(true, ['waits', 'enforcement', 200], ['starts', 'enforcement']), {
      waits: async () => {
        await Promise.race([started.fired, stuck()]);
        return ALLOW;
      },
      starts: () => {
        started.fire();
        return ALLOW;
      },
    }));
    assert.equal(d.denied, null);
    assert.deepEqual(d.gates.map((g) => g.outcome), ['allow', 'allow']);
  });

  it('a group budget under a gate budget limits that gate, named as the group budget', async () => {
    const d = await decide('PreToolUse', PAYLOAD, {}, { ...deps(bashGroup(true, ['hung', 'enforcement'], ['allows', 'enforcement']), { hung: stuck, allows: () => ALLOW }), groupBudgetMs: 40 });
    assert.equal(d.denied?.gate, 'hung');
    assert.match(reasonOf(d.stdout), /^BLOCKED: TMB gate hung ran out of the router's 40 ms group budget/);
  });

  it('with no group budget no gate starts, and an unknown gate fails closed by name', async () => {
    let ran = false;
    const spent = await decide('PreToolUse', PAYLOAD, {}, { ...deps(bashGroup(true, ['g', 'enforcement']), { g: () => ((ran = true), ALLOW) }), groupBudgetMs: 0 });
    assert.equal(ran, false);
    assert.equal(spent.denied?.gate, 'g');
    const unknown = await decide('PreToolUse', PAYLOAD, {}, deps(bashGroup(true, ['ok', 'enforcement'], ['missing', 'enforcement']), { ok: () => ALLOW }));
    assert.equal(unknown.denied?.gate, 'missing');
  });

  const orderOf = async (concurrent: boolean, env: NodeJS.ProcessEnv): Promise<string[]> => {
    const order: string[] = [];
    const gate = (name: string): Gate => async () => {
      order.push(`${name} start`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`${name} end`);
      return ALLOW;
    };
    await decide('PreToolUse', PAYLOAD, env, deps(bashGroup(concurrent, ['a', 'enforcement'], ['b', 'enforcement']), { a: gate('a'), b: gate('b') }));
    return order;
  };
  const ONE_AT_A_TIME = ['a start', 'a end', 'b start', 'b end'];

  it('a flagged group starts every gate before any ends', async () => {
    assert.deepEqual((await orderOf(true, {})).slice(0, 2), ['a start', 'b start']);
  });

  it('an unflagged group still runs one at a time', async () => {
    assert.deepEqual(await orderOf(false, {}), ONE_AT_A_TIME);
  });

  it('TMB_HOOKS_IMPL=bash takes the sequential path on a flagged group', async () => {
    assert.deepEqual(await orderOf(true, { TMB_HOOKS_IMPL: 'bash' }), ONE_AT_A_TIME);
  });
});

describe('the bounded parser wait (GH 1692 R-async, decision 1136)', () => {
  const answer = async (groups: RouterGroup[], gates: Record<string, Gate>): Promise<{ stdout: string; code: number }> => {
    let stdout = '';
    const code = await routerMain(
      'PreToolUse',
      {},
      {
        readStdin: () => PAYLOAD,
        writeStdout: async (text) => {
          stdout += text;
        },
        writeStderr: () => undefined,
      },
      { groups, findGate: (name) => gates[name], parserWait: () => new Promise(() => undefined), hop: false, dedupe: false, record: false, selfRoot: '' },
    );
    return { stdout, code };
  };

  it('a parser that never loads does not stop the call answering', async () => {
    const r = await answer(bashGroup(true, ['allows', 'enforcement']), { allows: () => context('still ran') });
    assert.equal(r.code, 0);
    assert.equal(contextOf(r.stdout), 'still ran');
  });

  it('an enforcement gate awaiting that parser denies at its deadline, naming itself', async () => {
    const r = await answer(bashGroup(true, ['needs-parser', 'enforcement', 40], ['allows', 'enforcement']), { 'needs-parser': () => new Promise<GateResult>(() => undefined), allows: () => ALLOW });
    assert.equal(r.code, 0);
    assert.match(reasonOf(r.stdout), /^BLOCKED: TMB gate needs-parser timed out after 40 ms/);
  });

  it('a parser that fails to load still lets the gates run', async () => {
    let ran = false;
    await decide('PreToolUse', PAYLOAD, {}, {
      groups: bashGroup(true, ['g', 'enforcement']),
      findGate: () => () => ((ran = true), ALLOW),
      parserWait: () => Promise.reject(new Error('no wasm')),
    });
    assert.equal(ran, true);
  });
});
