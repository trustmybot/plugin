/**
 * Every deny-capable hooks/hooks.json registration carries "onFailure": "block"
 * (GH 1812, ported from tests/l1-lint/hook-onfailure.sh, GH 1692). Claude Code
 * treats a command hook that crashes, times out, or exits non-zero without valid
 * JSON as "continue" unless its registration says "onFailure": "block", so a gate
 * that dies allows the action.
 *
 * A registration is the router entry (`node "${CLAUDE_PLUGIN_ROOT}/mcp/
 * trajectory-server/dist/hooks.js" <Event> [part]`), checked once per gate that
 * dist/hooks-router.txt lists for <Event>, that entry's matcher and its part, or
 * a direct `node … dist/hooks.js <gate>` entry (liveness-sentinel); a leading
 * node guard (`command -v node … || { …; exit 2; }; `, GH 2215) is dropped. Each
 * gate is src/hooks/<gate>.ts, listed in dist/hooks-gates.txt.
 *
 * A gate is deny-capable when, outside comments, it builds a deny or calls a
 * function from src/hooks/**\/*.ts whose body builds a deny or calls such a
 * function, derived to a fixpoint, or when its `CHAIN` array names a
 * deny-capable gate.
 * FAIL: a deny-capable registration without "onFailure": "block", an onFailure
 *       value other than "block" / "continue", or a gate with no
 *       src/hooks/<gate>.ts in dist/hooks-gates.txt.
 * WARN: a registration whose gates are all observe-only carrying
 *       "onFailure": "block" (its crash would block the action for nothing).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { routerGatesOf } from '../parsing/hooks.js';
import { PLUGIN_ROOT } from './router-sandboxes.js';

const MCP = 'mcp/trajectory-server';
const TS_DENY_RE = /permissionDecision: *'deny'|decision: *'block'|denyDbUnavailable\(/;
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;
const FUNCTION_OPENER = /^(export\s+)?(async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*[(<]/;
const CONST_OPENER = /^(export\s+)?const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(:[^=]*)?=\s*(async\s+)?\(/;
const NODE_GUARD = /^command -v node >\/dev\/null 2>&1 \|\| \{ [^}]*\}; /;
const DIRECT_GATE = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/mcp\/trajectory-server\/dist\/hooks\.js" ([a-z][a-z0-9-]*)$/;
const ROUTER_ENTRY = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/mcp\/trajectory-server\/dist\/hooks\.js" ([A-Z][A-Za-z]+)(?: ([a-z-]+))?$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const callOf = (names: string): RegExp => new RegExp(`(^|[^A-Za-z0-9_$.])(${names})\\s*\\(`);

function tsSource(root: string, gate: string): string | undefined {
  const src = join(root, MCP, 'src/hooks', `${gate}.ts`);
  const listed = join(root, MCP, 'dist/hooks-gates.txt');
  if (!existsSync(src) || !existsSync(listed)) return undefined;
  return readFileSync(listed, 'utf8').split('\n').includes(gate) ? src : undefined;
}

function tsCode(file: string): string[] {
  return readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').filter((line) => !COMMENT_LINE.test(line));
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

// A body runs from its `function <name>(` / `const <name> = (` opener to the next `}` at column 0.
function tsDenyFunctions(dir: string): Set<string> {
  const bodies = new Map<string, string>();
  let fn = '';
  for (const line of tsFiles(dir).flatMap((f) => [...tsCode(f), '}'])) {
    if (FUNCTION_OPENER.test(line) || CONST_OPENER.test(line)) {
      fn = line.replace(/^(export\s+)?(async\s+)?(function|const)\s+/, '').replace(/[^A-Za-z0-9_$].*/, '');
      if (!bodies.has(fn)) bodies.set(fn, '');
      continue;
    }
    if (line.startsWith('}')) {
      fn = '';
      continue;
    }
    if (fn !== '') bodies.set(fn, `${bodies.get(fn)}\n${line}`);
  }
  const deny = new Set([...bodies].filter(([, body]) => TS_DENY_RE.test(body)).map(([n]) => n));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [n, body] of bodies) {
      if (deny.has(n)) continue;
      if ([...deny].some((d) => callOf(escapeRe(d)).test(body))) {
        deny.add(n);
        grew = true;
      }
    }
  }
  return deny;
}

function tsChain(file: string): string[] {
  const out: string[] = [];
  let on = false;
  for (const line of tsCode(file)) {
    if (/^(export\s+)?const\s+CHAIN[^=]*=\s*\[/.test(line)) on = true;
    if (!on) continue;
    for (const m of line.matchAll(/'([a-z0-9-]+)'/g)) out.push(m[1]!);
    if (line.includes('];')) on = false;
  }
  return out;
}

function denyCapable(root: string, fns: Set<string>, gate: string, seen: string[] = []): boolean {
  if (seen.includes(gate)) return false;
  const src = tsSource(root, gate);
  if (src === undefined) return false;
  const names = [...fns].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)).join('|');
  const tests = names === '' ? [TS_DENY_RE] : [TS_DENY_RE, callOf(names)];
  if (tsCode(src).some((line) => tests.some((re) => re.test(line)))) return true;
  return tsChain(src).some((sub) => denyCapable(root, fns, sub, [gate, ...seen]));
}

interface Registration {
  event: string;
  matcher: string;
  target: string;
  onFailure: string;
  gate?: string;
  router?: { event: string; part: string | undefined };
}

interface HooksFile {
  hooks?: Record<string, { matcher?: string; hooks?: { command?: string; onFailure?: string }[] }[]>;
}

function registrations(hooksJson: string): Registration[] {
  const parsed = JSON.parse(readFileSync(hooksJson, 'utf8')) as HooksFile;
  const out: Registration[] = [];
  for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      const matcher = group.matcher ?? '';
      for (const hook of group.hooks ?? []) {
        const command = (hook.command ?? '').replace(NODE_GUARD, '');
        const onFailure = hook.onFailure ?? '-';
        const direct = DIRECT_GATE.exec(command);
        const routed = ROUTER_ENTRY.exec(command);
        if (direct) out.push({ event, matcher, target: direct[1]!, onFailure, gate: direct[1]! });
        else if (routed) {
          const target = `router:${routed[1]}${routed[2] ? `+${routed[2]}` : ''}:${matcher}`;
          out.push({ event, matcher, target, onFailure, router: { event: routed[1]!, part: routed[2] } });
        } else out.push({ event, matcher, target: '', onFailure });
      }
    }
  }
  return out;
}

function gatesOf(root: string, r: Registration): string[] {
  if (r.gate !== undefined) return [r.gate];
  if (r.router === undefined) return [];
  const tablePath = join(root, MCP, 'dist/hooks-router.txt');
  const table = existsSync(tablePath) ? readFileSync(tablePath, 'utf8') : '';
  return routerGatesOf(table, r.router.event, r.matcher, r.router.part);
}

interface CheckResult {
  ok: boolean;
  out: string;
}

const row = (event: string, gate: string, capable: string, onFailure: string, status: string): string =>
  `${event.padEnd(18)} ${gate.padEnd(34)} ${capable.padEnd(12)} ${onFailure.padEnd(10)} ${status}`;

function check(hooksJson: string, root: string): CheckResult {
  const fns = tsDenyFunctions(join(root, MCP, 'src/hooks'));
  const lines = [row('EVENT', 'GATE', 'DENY-CAPABLE', 'ONFAILURE', 'STATUS')];
  let fail = 0;
  let warn = 0;
  let n = 0;
  for (const r of registrations(hooksJson)) {
    const list = gatesOf(root, r);
    const via = r.router ? ' (router)' : '';
    if (list.length === 0) {
      lines.push(row(r.event, r.target || '?', '?', r.onFailure, 'FAIL (no gate)'));
      fail++;
      continue;
    }
    if (!['block', 'continue', '-'].includes(r.onFailure)) {
      lines.push(row(r.event, r.target, '?', r.onFailure, 'FAIL (onFailure must be block or continue)'));
      fail++;
      continue;
    }
    let any = 'no';
    for (const gate of list) {
      n++;
      if (tsSource(root, gate) === undefined) {
        lines.push(row(r.event, gate, '?', r.onFailure, 'FAIL (no src/hooks/<gate>.ts in dist/hooks-gates.txt)'));
        fail++;
        any = 'unknown';
        continue;
      }
      const capable = denyCapable(root, fns, gate);
      if (capable) any = 'yes';
      let status = `ok${via}`;
      if (capable && r.onFailure !== 'block') {
        status = 'FAIL (deny-capable: add "onFailure": "block")';
        fail++;
      }
      lines.push(row(r.event, gate, capable ? 'yes' : 'no', r.onFailure, status));
    }
    if (any === 'no' && r.onFailure === 'block') {
      lines.push(row(r.event, r.target, 'no', 'block', 'WARN (observe-only: "onFailure": "block" is unnecessary)'));
      warn++;
    }
  }
  if (n === 0) return { ok: false, out: `hook-onfailure: parsed 0 gate registrations from ${hooksJson}` };
  if (warn > 0) lines.push(`hook-onfailure: WARN ${warn} observe-only registration(s) carry onFailure: block`);
  if (fail > 0) {
    lines.push(`hook-onfailure: FAIL ${fail} registration(s)`);
    return { ok: false, out: lines.join('\n') };
  }
  lines.push(`hook-onfailure: PASS — ${n} gate registrations, every deny-capable one fails closed`);
  return { ok: true, out: lines.join('\n') };
}

const routerCmd = (event: string): string => `node "\${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" ${event}`;
const group = (matcher: string, command: string, onFailure?: string) => ({
  matcher,
  hooks: [{ type: 'command', command, timeout: 6, ...(onFailure ? { onFailure } : {}) }],
});

const FIXTURE: Record<string, string> = {
  'hooks-missing.json': JSON.stringify({
    hooks: {
      PreToolUse: [group('Bash', routerCmd('PreToolUse'))],
      Stop: [group('', routerCmd('fx-ghost'), 'block')],
    },
  }),
  'hooks-ok.json': JSON.stringify({
    hooks: {
      PreToolUse: [
        group('Bash', routerCmd('PreToolUse'), 'block'),
        group('Agent', routerCmd('PreToolUse'), 'block'),
        group('Write|Edit', routerCmd('PreToolUse')),
      ],
      SubagentStop: [group('', routerCmd('SubagentStop'), 'block')],
    },
  }),
  'hooks-warn.json': JSON.stringify({
    hooks: {
      PreToolUse: [group('Bash', routerCmd('PreToolUse'), 'block'), group('Write|Edit', routerCmd('PreToolUse'), 'block')],
    },
  }),
  'hooks-bad-value.json': JSON.stringify({
    hooks: {
      PreToolUse: [group('Bash', routerCmd('PreToolUse'), 'deny')],
      SubagentStop: [group('', routerCmd('SubagentStop'), 'block')],
    },
  }),
  'hooks-empty.json': JSON.stringify({ hooks: {} }),
  [`${MCP}/dist/hooks-router.txt`]: [
    'fx-gate 1000 enforcement PreToolUse Bash *',
    'fx-ts-helper-gate 1000 enforcement PreToolUse Bash *',
    'fx-dispatcher 1000 enforcement PreToolUse Agent *',
    'fx-ts-observe 1000 advisory PreToolUse Write|Edit *',
    'fx-block-gate 1000 enforcement SubagentStop - *',
    '',
  ].join('\n'),
  [`${MCP}/dist/hooks-gates.txt`]: ['fx-block-gate', 'fx-dispatcher', 'fx-gate', 'fx-ts-helper-gate', 'fx-ts-observe', ''].join('\n'),
  [`${MCP}/src/hooks/fx-dispatcher.ts`]: `// Builds no deny itself; denies through the gates of its CHAIN.
export const CHAIN: readonly string[] = [
  'fx-ts-observe',
  'fx-gate',
];

export const fxDispatcher = () => ({ stdout: '', code: 0 });
`,
  [`${MCP}/src/hooks/fx-gate.ts`]: `// Denies directly.
export const fxGate = () => ({
  stdout: \`\${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'fx' } })}\\n\`,
  code: 0,
});
`,
  [`${MCP}/src/hooks/fx-ts-observe.ts`]: `// Calls only a helper that never denies; fxDenyVia( in a comment is ignored.
import { fxNote } from './fx-helpers.js';

export const fxTsObserve = (payload: { tool_name?: string }) => {
  if (payload.tool_name !== 'Bash') return { stdout: '', code: 0 };
  return fxNote('fx');
};
`,
  [`${MCP}/src/hooks/fx-helpers.ts`]: `import { fxDenyCore, fxDescribe } from './lib/fx-db.js';

export function fxDenyVia(reason: string): { stdout: string; code: number } {
  return { stdout: \`\${fxDenyCore(fxDescribe(reason))}\\n\`, code: 0 };
}

export function fxNote(reason: string): { stdout: string; code: number } {
  return { stdout: \`\${fxDescribe(reason)}\\n\`, code: 0 };
}
`,
  [`${MCP}/src/hooks/fx-block-gate.ts`]: `// Blocks a non-PreToolUse event.
export const fxBlockGate = () => ({ stdout: \`\${JSON.stringify({ decision: 'block', reason: 'fx' })}\\n\`, code: 0 });
`,
  [`${MCP}/src/hooks/fx-ts-helper-gate.ts`]: `// Denies only through fxDenyVia, which denies through fxDenyCore.
import { fxDenyVia } from './fx-helpers.js';

export const fxTsHelperGate = (payload: { tool_name?: string }) => {
  if (payload.tool_name !== 'Bash') return { stdout: '', code: 0 };
  return fxDenyVia('fx');
};
`,
  [`${MCP}/src/hooks/lib/fx-db.ts`]: `export function fxDenyCore(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

export function fxDescribe(reason: string): string {
  return \`fx: \${reason}\`;
}
`,
};

describe('hook-onfailure: deny-capable registrations fail closed', () => {
  const fx = mkdtempSync(join(tmpdir(), 'tmb-hook-onfailure-'));
  after(() => rmSync(fx, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(fx, rel)), { recursive: true });
    writeFileSync(join(fx, rel), body);
  }

  it('fails a deny-capable registration without the key, and a gate with no source', () => {
    const r = check(join(fx, 'hooks-missing.json'), fx);
    assert.equal(r.ok, false, r.out);
    assert.match(r.out, /fx-gate .*FAIL \(deny-capable/);
    assert.match(r.out, /fx-ghost .*FAIL \(no src\/hooks/);
  });

  it('passes correct registrations cleanly and derives each gate\'s deny capability', () => {
    const r = check(join(fx, 'hooks-ok.json'), fx);
    assert.equal(r.ok, true, r.out);
    assert.doesNotMatch(r.out, /WARN/);
    for (const g of ['fx-gate', 'fx-block-gate', 'fx-ts-helper-gate', 'fx-dispatcher']) {
      assert.match(r.out, new RegExp(`^[A-Za-z]+ +${g} +yes `, 'm'), `${g} not derived deny-capable`);
    }
    assert.match(r.out, /^[A-Za-z]+ +fx-ts-observe +no /m, 'fx-ts-observe not derived observe-only');
  });

  it('warns on an observe-only registration that carries the key', () => {
    const r = check(join(fx, 'hooks-warn.json'), fx);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /router:PreToolUse:Write.*WARN/);
  });

  it('fails an onFailure value other than block or continue', () => {
    const r = check(join(fx, 'hooks-bad-value.json'), fx);
    assert.equal(r.ok, false, r.out);
    assert.match(r.out, /FAIL \(onFailure must be block or continue\)/);
  });

  it('fails when no gate registration parses', () => {
    const r = check(join(fx, 'hooks-empty.json'), fx);
    assert.equal(r.ok, false);
    assert.match(r.out, /parsed 0 gate registrations/);
  });

  it('every deny-capable registration in the shipped hooks.json carries "onFailure": "block"', (t) => {
    const r = check(join(PLUGIN_ROOT, 'hooks/hooks.json'), PLUGIN_ROOT);
    t.diagnostic(r.out);
    assert.equal(r.ok, true, r.out);
  });
});
