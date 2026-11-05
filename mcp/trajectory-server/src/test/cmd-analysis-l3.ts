/**
 * Shared harness for the cmd-analysis l3 ports (GH 1692), the node:test form
 * of the bash cmd-analysis l3 test it replaces. A group is one `it`: each of
 * its cases is judged on the frozen answers of the shell lib, recorded once
 * into tests/fixtures/cmd-analysis/l3/<suite>.jsonl, and a case whose probe has
 * a `ts` side also runs through the TypeScript cmd-analysis module and must
 * give the same answer. A `step` between cases changes the fixture the TS side
 * reads.
 * The fixture holds one line {group, index, label, sh} per case, keyed by the
 * group name, the case's index in the group and its label. A suite registers
 * its machine paths (tmp roots, HOME) as tokens, which the fixture stores in
 * place of the path and the harness expands at run time.
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
const FIXTURES = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis');
const BOUNDED_CHILD = join(HERE, 'run-bounded-child.js');
const MACHINE_PATH = /\/Users\/|\/var\/folders\/|tmb-cmd-analysis/;

/**
 * The commands of tests/fixtures/cmd-analysis/divergences.jsonl (decision 703):
 * the TS answers them differently on purpose and cmd-analysis-diff.suite.ts
 * asserts that recorded answer, so a probe of one asserts on the frozen shell
 * answer only.
 */
export const DIVERGENT: ReadonlySet<string> = new Set(
  readFileSync(join(FIXTURES, 'divergences.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { cmd: string }).cmd),
);

/** A case's TS side; without one the case is judged on its frozen shell answer only. */
export interface Probe {
  ts?: () => string | Promise<string>;
}

export const SH_ONLY: Probe = {};

function unlessDivergent(cmd: string, p: Probe): Probe {
  return DIVERGENT.has(cmd) ? SH_ONLY : p;
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

interface FrozenLine {
  group: string;
  index: number;
  label: string;
  sh: string;
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

/** tmb_cmd_write_paths "$cmd" "$cwd" | paste -sd, - */
export function wpaths(cmd: string, cwd = ''): Probe {
  return unlessDivergent(cmd, { ts: async () => (await writePaths(cmd, { cwd })).join(',') });
}

/** tmb_cmd_write_paths "$cmd" "$cwd" "" "$root", <root> shown as `@`. */
export function rootedPaths(cmd: string, cwd: string, root: string, at = true): Probe {
  const show = (s: string) => (at ? s.split(root).join('@') : s);
  return unlessDivergent(cmd, { ts: async () => (await writePaths(cmd, { cwd, root })).map(show).join(',') });
}

/** tmb_cmd_write_targets "$(tmb_cmd_strip_literals "$cmd")" | tr '\n' , */
export function targets(cmd: string): Probe {
  return {
    ts: () =>
      subst(stripLiterals(cmd))
        .split('\n')
        .flatMap((l) => writeTargets(l))
        .map((t) => `${t},`)
        .join(''),
  };
}

/** "$(tmb_cmd_strip_literals "$cmd")" */
export function strip(cmd: string): Probe {
  return { ts: () => subst(stripLiterals(cmd)) };
}

/** tmb_is_prompt_surface_path "$p" [root] as `true` / `false`. */
export function surface(p: string, root?: string): Probe {
  return { ts: async () => String(await isPromptSurfacePath(p, root ?? '')) };
}

/** "$(tmb_path_canonical "$p")" */
export function canonical(p: string): Probe {
  return { ts: () => pathCanonical(p) };
}

/** tmb_cmd_statements "$cmd" "$cwd" | tr '\t' '#' | paste -sd'|' - */
export function stmts(cmd: string, cwd: string): Probe {
  return unlessDivergent(cmd, {
    ts: async () => {
      const res = await cmdStatements(cmd, cwd);
      return res.ok ? res.statements.map((s) => `${s.dir}#${s.stmt}`.replace(/\t/g, '#')).join('|') : '<refused>';
    },
  });
}

/** "$(tmb_gh_mutation "$(tmb_cmd_strip_literals "$cmd")")" */
export function ghm(cmd: string): Probe {
  return { ts: () => ghMutation(subst(stripLiterals(cmd))) };
}

/** tmb_gh_mutation of every statement tmb_cmd_statements lists. */
export function ghs(cmd: string, cwd: string): Probe {
  return {
    ts: async () => {
      const res = await cmdStatements(cmd, cwd);
      if (!res.ok) return '<refused>';
      return res.statements
        .map((s) => ghMutation(s.stmt))
        .filter((m) => m !== '')
        .join('\n');
    },
  };
}

export class Suite {
  readonly groups: Group[] = [];
  readonly tokens: [string, string][] = [];

  /** <name> picks the fixture tests/fixtures/cmd-analysis/l3/<name>.jsonl. */
  constructor(readonly name: string) {
    if (process.env.HOME) this.token('<HOME>', process.env.HOME);
  }

  /** A machine path the fixture stores as <name>. */
  token(name: string, value: string): this {
    this.tokens.push([name, value]);
    return this;
  }

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

  /** How many assertions the suite makes on the frozen shell answers and on the TS module. */
  counts(): { sh: number; ts: number } {
    const cases = this.groups.flatMap((g) => g.items.flatMap((i) => ('case' in i ? [i.case] : [])));
    return { sh: cases.length, ts: cases.filter((c) => c.probe.ts !== undefined).length };
  }

  /** Each case's key, in suite order. */
  keys(): string[] {
    return this.groups.flatMap((g) =>
      g.items.flatMap((i) => ('case' in i ? [i.case] : [])).map((c, index) => caseKey(g.name, index, c.label)),
    );
  }

  expand(s: string): string {
    return this.tokens.reduce((v, [name, value]) => v.split(name).join(value), s);
  }
}

const caseKey = (group: string, index: number, label: string): string => JSON.stringify([group, index, label]);

function judge(c: Case, got: string): string | null {
  const ok = c.kind === 'eq' ? got === c.want : c.kind === 'has' ? got.includes(c.want) : !got.includes(c.want);
  if (ok) return null;
  const how = c.kind === 'eq' ? 'want' : c.kind === 'has' ? 'missing' : 'unexpected';
  return `${c.label}: ${how} ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`;
}

async function runGroup(g: Group, frozen: ReadonlyMap<string, string>): Promise<string[]> {
  const fails: string[] = [];
  let index = 0;
  for (const item of g.items) {
    if (!('case' in item)) {
      await item.step();
      continue;
    }
    const c = item.case;
    const sh = frozen.get(caseKey(g.name, index++, c.label));
    if (sh === undefined) fails.push(`sh ${c.label}: no fixture line`);
    else {
      const shFail = judge(c, c.post(sh));
      if (shFail) fails.push(`sh ${shFail}`);
    }
    if (c.probe.ts) {
      const tsFail = judge(c, c.post(await c.probe.ts()));
      if (tsFail) fails.push(`ts ${tsFail}`);
    }
  }
  return fails;
}

export function runSuite(title: string, suite: Suite): void {
  const { sh, ts } = suite.counts();
  const file = join(FIXTURES, 'l3', `${suite.name}.jsonl`);
  const raw = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
  const lines = raw.map((l) => JSON.parse(l) as FrozenLine);
  const frozen = new Map(
    lines.map((l) => [caseKey(l.group, l.index, suite.expand(l.label)), suite.expand(l.sh)] as const),
  );
  describe(`${title}: ${sh} cases on the frozen shell answers, ${ts} also on the TS module`, () => {
    it(`l3/${suite.name}.jsonl holds one line per case and no machine path`, () => {
      const keys = suite.keys();
      assert.equal(new Set(keys).size, keys.length, 'two cases share a key');
      assert.equal(frozen.size, lines.length, 'two fixture lines share a key');
      assert.deepEqual([...frozen.keys()].sort(), [...keys].sort());
      for (const l of raw) assert.doesNotMatch(l, MACHINE_PATH);
    });
    for (const g of suite.groups) {
      it(`${g.name} [${g.items.filter((i) => 'case' in i).length}]`, async () => {
        assert.deepEqual(await runGroup(g, frozen), []);
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
