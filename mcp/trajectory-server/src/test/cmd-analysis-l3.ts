/**
 * Shared harness for the cmd-analysis l3 ports (GH 1692), the node:test form
 * of the bash cmd-analysis l3 test it replaces. A group is one
 * `it`: its cases run through one bash process that sources
 * scripts/hooks/lib/cmd-analysis.sh once, each call in its own subshell, and a
 * case whose probe has a `ts` side also runs through the TypeScript
 * cmd-analysis module and must give the same answer. A `step` between cases
 * changes the fixture, so the cases after it run in a fresh bash process.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cmdStatements,
  ghMutation,
  isPromptSurfacePath,
  pathCanonical,
  stripLiterals,
  writePaths,
} from '../hooks/cmd-analysis/index.js';
import { writeTargets } from '../hooks/cmd-analysis/targets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, '../../../..');
export const LIB = join(PLUGIN_ROOT, 'scripts/hooks/lib/cmd-analysis.sh');
const BOUNDED_CHILD = join(HERE, 'run-bounded-child.js');

/**
 * The commands of tests/fixtures/cmd-analysis/divergences.jsonl (decision 703):
 * the TS answers them differently on purpose and cmd-analysis-diff.suite.ts
 * asserts that recorded answer, so a probe of one asserts on bash only.
 */
export const DIVERGENT: ReadonlySet<string> = new Set(
  readFileSync(join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis/divergences.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { cmd: string }).cmd),
);

function unlessDivergent(cmd: string, p: Probe): Probe {
  return DIVERGENT.has(cmd) ? shOnly(p) : p;
}

const SCRIPT = `. "$1"
targets() { tmb_cmd_write_targets "$(tmb_cmd_strip_literals "$1")"; }
ghm() { tmb_gh_mutation "$(tmb_cmd_strip_literals "$1")"; }
ghs() { tmb_cmd_statements "$1" "$2" | while IFS="$(printf '\\t')" read -r _d s; do tmb_gh_mutation "$s"; done; }
while IFS= read -r -d '' fn && IFS= read -r -d '' n; do
  a=()
  for ((i = 0; i < n; i++)); do IFS= read -r -d '' x; a+=("$x"); done
  ( "$fn" "\${a[@]}" ) </dev/null
  printf '\\0%s\\0' "$?"
done`;

export interface ShCall {
  fn: string;
  args: string[];
}

export interface ShResult {
  out: string;
  status: number;
}

export interface Probe {
  call: ShCall;
  fromSh: (r: ShResult) => string;
  ts?: () => string | Promise<string>;
}

type Kind = 'eq' | 'has' | 'lacks';

interface Case {
  kind: Kind;
  want: string;
  probe: Probe;
  label: string;
  post: (s: string) => string;
}

type Item = { case: Case } | { step: () => void | Promise<void> };

interface Group {
  name: string;
  items: Item[];
}

/** `$( )`: the output without its trailing newlines. */
export function subst(out: string): string {
  return out.replace(/\n+$/, '');
}

/** `paste -sd<sep> -`: the output's lines joined by <sep>. */
export function paste(out: string, sep: string): string {
  const lines = out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join(sep);
}

export function lastField(s: string, sep = '|'): string {
  return s.split(sep).pop() ?? '';
}

/** `sed 's/^[^|]*|//'`: the line without its first statement. */
export function dropFirst(s: string): string {
  return s.replace(/^[^|]*\|/, '');
}

export function shRun(calls: readonly ShCall[], env: NodeJS.ProcessEnv = process.env): ShResult[] {
  if (calls.length === 0) return [];
  const input = calls.map((c) => [c.fn, String(c.args.length), ...c.args].join('\0') + '\0').join('');
  const res = spawnSync('bash', ['-c', SCRIPT, 'bash', LIB], { input, env, maxBuffer: 1 << 28, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const chunks = res.stdout.split('\0');
  return calls.map((_, i) => ({ out: chunks[2 * i]!, status: Number(chunks[2 * i + 1]) }));
}

/** A cmd-analysis.sh function's `$( )` output. */
export function shFn(fn: string, ...args: string[]): Probe {
  return { call: { fn, args }, fromSh: (r) => subst(r.out) };
}

export function shOnly(p: Probe): Probe {
  return { call: p.call, fromSh: p.fromSh };
}

export function withTs(p: Probe, ts: () => string | Promise<string>): Probe {
  return { ...p, ts };
}

/** `tmb_cmd_write_paths "$cmd" "$cwd" | paste -sd, -`. */
export function wpaths(cmd: string, cwd = ''): Probe {
  return unlessDivergent(cmd, {
    call: { fn: 'tmb_cmd_write_paths', args: [cmd, cwd] },
    fromSh: (r) => paste(r.out, ','),
    ts: async () => (await writePaths(cmd, { cwd })).join(','),
  });
}

/** `tmb_cmd_write_paths "$cmd" "$cwd" "" "$root"`, <root> shown as `@`. */
export function rootedPaths(cmd: string, cwd: string, root: string, at = true): Probe {
  const show = (s: string) => (at ? s.split(root).join('@') : s);
  return unlessDivergent(cmd, {
    call: { fn: 'tmb_cmd_write_paths', args: [cmd, cwd, '', root] },
    fromSh: (r) => paste(show(r.out), ','),
    ts: async () => (await writePaths(cmd, { cwd, root })).map(show).join(','),
  });
}

/** `tmb_cmd_write_targets "$(tmb_cmd_strip_literals "$cmd")" | tr '\n' ,`. */
export function targets(cmd: string): Probe {
  return {
    call: { fn: 'targets', args: [cmd] },
    fromSh: (r) => r.out.replace(/\n/g, ','),
    ts: () =>
      subst(stripLiterals(cmd))
        .split('\n')
        .flatMap((l) => writeTargets(l))
        .map((t) => `${t},`)
        .join(''),
  };
}

export function strip(cmd: string): Probe {
  return withTs(shFn('tmb_cmd_strip_literals', cmd), () => subst(stripLiterals(cmd)));
}

/** `tmb_is_prompt_surface_path "$p" [root]` as `true` / `false`. */
export function surface(p: string, root?: string): Probe {
  const args = root === undefined ? [p] : [p, root];
  return {
    call: { fn: 'tmb_is_prompt_surface_path', args },
    fromSh: (r) => String(r.status === 0),
    ts: async () => String(await isPromptSurfacePath(p, root ?? '')),
  };
}

export function canonical(p: string): Probe {
  return withTs(shFn('tmb_path_canonical', p), () => pathCanonical(p));
}

/** `tmb_cmd_statements "$cmd" "$cwd" | tr '\t' '#' | paste -sd'|' -`. */
export function stmts(cmd: string, cwd: string): Probe {
  return unlessDivergent(cmd, {
    call: { fn: 'tmb_cmd_statements', args: [cmd, cwd] },
    fromSh: (r) => paste(r.out.replace(/\t/g, '#'), '|'),
    ts: async () => {
      const res = await cmdStatements(cmd, cwd);
      return res.ok ? res.statements.map((s) => `${s.dir}#${s.stmt}`.replace(/\t/g, '#')).join('|') : '<refused>';
    },
  });
}

/** `tmb_gh_mutation "$(tmb_cmd_strip_literals "$cmd")"`. */
export function ghm(cmd: string): Probe {
  return withTs(shFn('ghm', cmd), () => ghMutation(subst(stripLiterals(cmd))));
}

/** tmb_gh_mutation of every statement tmb_cmd_statements lists. */
export function ghs(cmd: string, cwd: string): Probe {
  return withTs(shFn('ghs', cmd, cwd), async () => {
    const res = await cmdStatements(cmd, cwd);
    if (!res.ok) return '<refused>';
    return res.statements
      .map((s) => ghMutation(s.stmt))
      .filter((m) => m !== '')
      .join('\n');
  });
}

export class Suite {
  readonly groups: Group[] = [];

  group(name: string): this {
    this.groups.push({ name, items: [] });
    return this;
  }

  private add(c: Case): this {
    this.groups[this.groups.length - 1]!.items.push({ case: c });
    return this;
  }

  eq(want: string, probe: Probe, label: string, post: (s: string) => string = (s) => s): this {
    return this.add({ kind: 'eq', want, probe, label, post });
  }

  has(probe: Probe, needle: string, label: string): this {
    return this.add({ kind: 'has', want: needle, probe, label, post: (s) => s });
  }

  lacks(probe: Probe, needle: string, label: string): this {
    return this.add({ kind: 'lacks', want: needle, probe, label, post: (s) => s });
  }

  step(fn: () => void | Promise<void>): this {
    this.groups[this.groups.length - 1]!.items.push({ step: fn });
    return this;
  }

  /** How many assertions the suite makes on cmd-analysis.sh and on the TS module. */
  counts(): { sh: number; ts: number } {
    const cases = this.groups.flatMap((g) => g.items.flatMap((i) => ('case' in i ? [i.case] : [])));
    return { sh: cases.length, ts: cases.filter((c) => c.probe.ts !== undefined).length };
  }
}

function judge(c: Case, got: string): string | null {
  const ok = c.kind === 'eq' ? got === c.want : c.kind === 'has' ? got.includes(c.want) : !got.includes(c.want);
  if (ok) return null;
  const how = c.kind === 'eq' ? 'want' : c.kind === 'has' ? 'missing' : 'unexpected';
  return `${c.label}: ${how} ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`;
}

async function runGroup(g: Group): Promise<string[]> {
  const fails: string[] = [];
  let pending: Case[] = [];
  const flush = async () => {
    const sh = shRun(pending.map((c) => c.probe.call));
    for (const [i, c] of pending.entries()) {
      const shFail = judge(c, c.post(c.probe.fromSh(sh[i]!)));
      if (shFail) fails.push(`sh ${shFail}`);
      if (c.probe.ts) {
        const tsFail = judge(c, c.post(await c.probe.ts()));
        if (tsFail) fails.push(`ts ${tsFail}`);
      }
    }
    pending = [];
  };
  for (const item of g.items) {
    if ('case' in item) {
      pending.push(item.case);
      continue;
    }
    await flush();
    await item.step();
  }
  await flush();
  return fails;
}

export function runSuite(title: string, suite: Suite): void {
  const { sh, ts } = suite.counts();
  describe(`${title}: ${sh} cases on cmd-analysis.sh, ${ts} also on the TS module`, () => {
    for (const g of suite.groups) {
      it(`${g.name} [${g.items.filter((i) => 'case' in i).length}]`, async () => {
        assert.deepEqual(await runGroup(g), []);
      });
    }
  });
}

export interface Bounded {
  status: number | null;
  stdout: string;
}

/**
 * The perl run_bounded of the bash suite: <cmd> in its own process group under
 * run-bounded-child.js, the whole group killed after <secs> (status 124), on
 * INT or TERM to the watchdog, or when <caller> dies.
 */
export function runBounded(secs: number, cmd: string, args: readonly string[], caller = process.pid): Bounded {
  const res = spawnSync(process.execPath, [BOUNDED_CHILD, String(caller), String(secs), cmd, ...args], {
    encoding: 'utf8',
    timeout: (secs + 10) * 1000,
    killSignal: 'SIGKILL',
  });
  return { status: res.status, stdout: res.stdout };
}

export function spawnBounded(secs: number, cmd: string, args: readonly string[], caller = process.pid) {
  return spawn(process.execPath, [BOUNDED_CHILD, String(caller), String(secs), cmd, ...args], { stdio: 'ignore' });
}
