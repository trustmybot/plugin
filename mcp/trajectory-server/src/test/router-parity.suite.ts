/**
 * Decision parity (GH 1692): every corpus payload of each router gate,
 * materialized in its gate's parity sandbox, gets from the router the
 * decision the gates give one by one: the first deny in ROUTER_GROUPS order
 * with that gate's output, else the allowing gates' contexts merged.
 * One router-parity.<gate>.test.ts per gate runs it as its own node --test process (GH 2118).
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findGate, routerGates } from '../hooks/registry.js';
import { decide, failClosedReason, payloadTool } from '../hooks/router/decide.js';
import { type RouterCase, type RouterCorpusGate, type RouterSandbox, routerSandbox, underUid } from './router-sandboxes.js';

const DENY = /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/;
const EVENT = 'PreToolUse';

interface Expected {
  decision: 'allow' | 'deny';
  gate: string | null;
  stdout: unknown;
  code: number;
}

function parsed(stdout: string): unknown {
  const t = stdout.trim();
  return t === '' ? null : JSON.parse(t);
}

async function oneByOne(c: RouterCase): Promise<Expected> {
  const tool = payloadTool(c.input);
  if (tool === null) return { decision: 'deny', gate: 'router', stdout: parsed(`${JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, permissionDecision: 'deny', permissionDecisionReason: failClosedReason('router', 'got an unparseable payload') } })}`), code: 0 };
  const contexts: { hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown; permissionDecision?: string; permissionDecisionReason?: string } }[] = [];
  for (const gate of routerGates(EVENT, tool)) {
    const fn = findGate(gate.name);
    assert.ok(fn, `${gate.name} is registered`);
    const r = await fn(c.input, c.env);
    if (r.code === 2 || DENY.test(r.stdout)) return { decision: 'deny', gate: gate.name, stdout: parsed(r.stdout), code: r.code === 2 ? 2 : 0 };
    assert.equal(r.code, 0, `${gate.name} exits 0 or 2 on ${basename(c.file)}`);
    if (r.stdout.trim() !== '') contexts.push(JSON.parse(r.stdout) as never);
  }
  if (contexts.length === 0) return { decision: 'allow', gate: null, stdout: null, code: 0 };
  if (contexts.length === 1) return { decision: 'allow', gate: null, stdout: contexts[0], code: 0 };
  const asks = contexts.find((x) => x.hookSpecificOutput?.permissionDecision === 'ask')?.hookSpecificOutput;
  return {
    decision: 'allow',
    gate: null,
    stdout: { hookSpecificOutput: { hookEventName: contexts.find((x) => x.hookSpecificOutput?.hookEventName)?.hookSpecificOutput?.hookEventName ?? EVENT, additionalContext: contexts.map((x) => x.hookSpecificOutput?.additionalContext).filter((x) => x !== undefined && x !== null).join('\n\n'), ...(asks ? { permissionDecision: 'ask' } : {}), ...(asks?.permissionDecisionReason === undefined ? {} : { permissionDecisionReason: asks.permissionDecisionReason }) } },
    code: 0,
  };
}

async function inCase<T>(c: RouterCase, fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  c.reset?.();
  process.chdir(c.cwd);
  try {
    return await underUid(c.fakeUid, fn);
  } finally {
    process.chdir(cwd);
  }
}

export function routerParityGate(gate: RouterCorpusGate): void {
  describe('router decision parity over the gates corpora', () => {
    let sandbox: RouterSandbox;
    before(() => {
      sandbox = routerSandbox(mkdtempSync(join(tmpdir(), 'tmb-router-parity-')), [gate]);
    });
    after(() => sandbox.cleanup());

    it(`${gate}: the router decides as the gates do one by one`, async () => {
      const cases = sandbox.cases.filter((c) => c.gate === gate);
      assert.ok(cases.length > 0, `${gate} has a corpus`);
      let ran = 0;
      for (const c of cases) {
        const want = await inCase(c, () => oneByOne(c));
        const got = await inCase(c, () => decide(EVENT, c.input, c.env, { budgetMs: () => 120_000, groupBudgetMs: Number.POSITIVE_INFINITY }));
        const name = basename(c.file);
        assert.equal(got.denied === null ? 'allow' : 'deny', want.decision, `${name}: decision (${got.stderr})`);
        assert.equal(got.denied?.gate ?? null, want.gate, `${name}: denying gate`);
        assert.deepEqual(parsed(got.stdout), want.stdout, `${name}: output`);
        assert.equal(got.code, want.code, `${name}: exit code`);
        if (got.tool === 'Bash') assert.equal(got.gates.length, 11, `${name}: all 11 gates ran`);
        if (got.gates.some((g) => g.gate === gate)) ran++;
      }
      assert.ok(ran > 0, `the router ran ${gate} on its corpus`);
    });
  });
}
