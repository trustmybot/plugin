/**
 * The one derivation of which gates are deny-capable, shared by hook-onfailure
 * and router-budgets tests. A gate is deny-capable when, outside comments,
 * src/hooks/<gate>.ts (listed in dist/hooks-gates.txt) builds a deny or calls a
 * function from src/hooks/**\/*.ts whose body builds a deny or calls such a
 * function, derived to a fixpoint, or when its `CHAIN` array names a
 * deny-capable gate.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MCP = 'mcp/trajectory-server';
const TS_DENY_RE = /permissionDecision: *'deny'|decision: *'block'|denyDbUnavailable\(/;
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;
const FUNCTION_OPENER = /^(export\s+)?(async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*[(<]/;
const CONST_OPENER = /^(export\s+)?const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(:[^=]*)?=\s*(async\s+)?\(/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const callOf = (names: string): RegExp => new RegExp(`(^|[^A-Za-z0-9_$.])(${names})\\s*\\(`);

export function tsSource(root: string, gate: string): string | undefined {
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
export function tsDenyFunctions(dir: string): Set<string> {
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
    for (const m of line.matchAll(/'([a-z0-9-]+)'/g)) out.push(m[1]);
    if (line.includes('];')) on = false;
  }
  return out;
}

export function denyCapable(root: string, fns: Set<string>, gate: string, seen: string[] = []): boolean {
  if (seen.includes(gate)) return false;
  const src = tsSource(root, gate);
  if (src === undefined) return false;
  const names = [...fns].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)).join('|');
  const tests = names === '' ? [TS_DENY_RE] : [TS_DENY_RE, callOf(names)];
  if (tsCode(src).some((line) => tests.some((re) => re.test(line)))) return true;
  return tsChain(src).some((sub) => denyCapable(root, fns, sub, [gate, ...seen]));
}
