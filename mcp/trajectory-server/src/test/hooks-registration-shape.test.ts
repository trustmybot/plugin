/**
 * hooks.json registration shape (GH 1692 R1, SC1). A registration that holds
 * a deny-capable gate (the router entry with an enforcement gate, or any
 * registration that fails closed with onFailure: block) is a plain command
 * hook: no `mcp_tool`, `prompt`, `agent` or `if` field, whose semantics would
 * let a call pass without the gate running. The Bash PreToolUse event is the
 * router's one exec-form entry.
 */
import assert from 'node:assert/strict';
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

  it('Bash PreToolUse is one group, matcher Bash, one exec-form router entry that fails closed at the router timeout', () => {
    const bash = HOOKS.hooks.PreToolUse.filter((g) => g.matcher.split('|').includes('Bash'));
    assert.equal(bash.length, 1);
    assert.equal(bash[0].matcher, 'Bash');
    assert.equal(bash[0].hooks.length, 1);
    const [r] = bash[0].hooks;
    assert.equal(r.type, 'command');
    assert.match(r.command ?? '', ROUTER);
    assert.ok(r.command?.endsWith('dist/hooks.js" PreToolUse'));
    assert.equal(r.onFailure, 'block');
    assert.equal(r.timeout, routerTimeoutS());
    assert.equal('if' in r, false);
  });

  it('containment-guard and debug-trajectory no longer register for Bash', () => {
    for (const gate of ['containment-guard', 'debug-trajectory']) {
      const groups = HOOKS.hooks.PreToolUse.filter((g) => g.hooks.some((r) => (r.command ?? '').endsWith(`dispatch.sh" ${gate}`)));
      assert.ok(groups.length > 0, `${gate} still registers for its other tools`);
      for (const g of groups) assert.equal(g.matcher.split('|').includes('Bash'), false, `${gate}: ${g.matcher}`);
    }
  });
});
