/**
 * hooks.json registration shape (GH 1692 R1, SC1). A registration that holds
 * a deny-capable gate (the router entry with an enforcement gate, or any
 * registration that fails closed with onFailure: block) is a plain command
 * hook: no `mcp_tool`, `prompt`, `agent` or `if` field, whose semantics would
 * let a call pass without the gate running. The Bash PreToolUse event is the
 * router's one exec-form entry.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROUTER_GROUPS, routerTimeoutS } from '../hooks/registry.js';
import { PLUGIN_ROOT } from './router-sandboxes.js';

interface Registration {
  type?: string;
  command?: string;
  timeout?: number;
  onFailure?: string;
  [k: string]: unknown;
}
interface Group {
  matcher: string;
  hooks: Registration[];
}
interface HooksJson {
  hooks: Record<string, Group[]>;
}

const ROUTER = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/mcp\/trajectory-server\/dist\/hooks\.js" ([A-Za-z]+)$/;
const FORBIDDEN = ['mcp_tool', 'prompt', 'agent', 'if'] as const;

function denyCapable(event: string, r: Registration): boolean {
  if (r.onFailure === 'block') return true;
  const m = ROUTER.exec(r.command ?? '');
  return m !== null && m[1] === event && ROUTER_GROUPS.some((grp) => grp.event === event && grp.gates.some((g) => g.kind === 'enforcement'));
}

function shapeViolations(h: HooksJson): string[] {
  const out: string[] = [];
  for (const [event, groups] of Object.entries(h.hooks)) {
    for (const g of groups) {
      for (const r of g.hooks) {
        if (!denyCapable(event, r)) continue;
        const where = `${event} ${g.matcher}: ${r.command ?? r.type ?? '?'}`;
        for (const f of FORBIDDEN) if (f in r) out.push(`${where} has '${f}'`);
        if (r.type !== 'command') out.push(`${where} is type '${String(r.type)}', not command`);
      }
    }
  }
  return out;
}

const HOOKS = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')) as HooksJson;

describe('hooks.json registration shape', () => {
  it('no deny-capable registration carries mcp_tool, prompt, agent or if', () => {
    assert.deepEqual(shapeViolations(HOOKS), []);
  });

  it('self-test: each forbidden field on a deny-capable registration fails, on an observe-only one passes', () => {
    const router = 'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" PreToolUse';
    for (const f of FORBIDDEN) {
      const bad: HooksJson = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: router, timeout: 9, [f]: 'x' }] }] } };
      assert.equal(shapeViolations(bad).length, 1, `router entry with '${f}'`);
      const blocked: HooksJson = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'x', onFailure: 'block', [f]: 'x' }] }] } };
      assert.equal(shapeViolations(blocked).length, 1, `fail-closed entry with '${f}'`);
      const observe: HooksJson = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'x', [f]: 'x' }] }] } };
      assert.deepEqual(shapeViolations(observe), [], `observe-only entry with '${f}'`);
    }
    assert.equal(shapeViolations({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'prompt', onFailure: 'block' }] }] } }).length, 1, 'a prompt-type hook');
  });

  it('every PreToolUse entry is one router group: its matcher, timeout and onFailure are the registry\'s, in exec form with no if', () => {
    const groups = ROUTER_GROUPS.filter((g) => g.event === 'PreToolUse');
    assert.deepEqual(HOOKS.hooks.PreToolUse.map((g) => g.matcher).sort(), groups.map((g) => g.matcher).sort());
    for (const group of groups) {
      const [entry] = HOOKS.hooks.PreToolUse.filter((g) => g.matcher === group.matcher);
      assert.equal(entry.hooks.length, 1, group.matcher);
      const [r] = entry.hooks;
      assert.equal(r.type, 'command');
      assert.match(r.command ?? '', ROUTER);
      assert.ok(r.command?.endsWith('dist/hooks.js" PreToolUse'), group.matcher);
      assert.equal(r.timeout, routerTimeoutS(group), group.matcher);
      assert.equal(r.onFailure, group.gates.some((g) => g.kind === 'enforcement') ? 'block' : undefined, group.matcher);
      assert.equal('if' in r, false, group.matcher);
    }
  });

  it('no tool name appears in two PreToolUse matchers, and the advisory groups cannot block', () => {
    const names = HOOKS.hooks.PreToolUse.flatMap((g) => g.matcher.split('|'));
    assert.equal(names.length, new Set(names).size, names.join(' '));
    for (const matcher of ['AskUserQuestion', 'Read|Skill']) {
      const [entry] = HOOKS.hooks.PreToolUse.filter((g) => g.matcher === matcher);
      assert.equal(entry.hooks[0].onFailure, undefined, matcher);
    }
  });

  it('the trajectory-gates chain table is the router group: names, order, tool filter and budget floor', () => {
    const table = execFileSync('bash', ['-c', '. "$0"; tmb_chain_table trajectory-gates', join(PLUGIN_ROOT, 'scripts/hooks/lib/registrations.sh')], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.split(' '));
    const group = ROUTER_GROUPS.find((g) => g.matcher === 'mcp__.*trajectory-server__.*');
    assert.deepEqual(table.map(([name, , tool]) => [name, tool]), group?.gates.map((g) => [g.name, g.toolSuffix ?? '*']));
    for (const [name, timeoutS] of table) {
      const budgetMs = group?.gates.find((g) => g.name === name)?.budgetMs ?? 0;
      assert.ok(budgetMs >= Number(timeoutS) * 1000, `${name}: ${budgetMs} ms under its ${timeoutS} s`);
    }
  });

  it('no PreToolUse gate registers through dispatch.sh any more', () => {
    for (const g of HOOKS.hooks.PreToolUse) {
      for (const r of g.hooks) assert.doesNotMatch(r.command ?? '', /dispatch\.sh/, g.matcher);
    }
  });
});
