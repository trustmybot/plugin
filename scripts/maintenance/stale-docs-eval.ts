#!/usr/bin/env node
// Replay eval of `cli.js stale-docs` (GH 1955): runs the built check with
// --head on four past diffs whose code-reviewer findings were stale docs or
// comments, and counts a finding as caught when a flag names its path and a
// line in its target range. Prints each finding caught or missed and each
// replay's flag count. Exits 0 only when at least 4 of the 8 findings are
// caught and the 114 and 142 replays print at most 100 flags each (the 180
// and 182 replays, 380-file renames, are reported uncapped), else 1; exits 2
// when a case commit is missing from the object store or the check fails to
// run.
// Needs the built server (mcp/trajectory-server/dist/cli.js).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Finding {
  id: string;
  path: string;
  from: number;
  to: number;
}

interface Replay {
  base: string;
  head: string;
  capped: boolean;
  findings: Finding[];
}

const MIN_CAUGHT = 4;
const MAX_FLAGS = 100;

const REPLAYS: readonly Replay[] = [
  {
    base: 'e7d943c28d4c4b98d75b10f26df62edf9f34eb76',
    head: 'b6d19338918beffbba7074996324419a88d7a796',
    capped: true,
    findings: [
      { id: 'F114-1', path: 'mcp/trajectory-server/src/tools/README.md', from: 44, to: 44 },
      { id: 'F114-2', path: 'mcp/trajectory-server/src/tools/composites.ts', from: 952, to: 952 },
    ],
  },
  {
    base: '6c7c6ab146e4707293b53f54e63b8cef3ae5027a',
    head: '6a095b716f4bcca654d882a8423f00d84c0f9861',
    capped: true,
    findings: [
      { id: 'F142-2', path: 'docs/architecture/ERD.md', from: 20, to: 20 },
      { id: 'F142-3', path: 'mcp/trajectory-server/src/schema.sql', from: 612, to: 613 },
    ],
  },
  {
    base: 'a38cc1012f5ce68e8cca7e893f087c8dd9b3b787',
    head: '68356bcadb9f5be837232b66aabbc7064f091c72',
    capped: false,
    findings: [
      { id: 'F180-1', path: 'docs/reference/REFERENCE.md', from: 106, to: 106 },
      { id: 'F180-2', path: 'scripts/hooks/README.md', from: 102, to: 102 },
      { id: 'F180-3', path: 'docs/reference/UPGRADE.md', from: 122, to: 122 },
    ],
  },
  {
    base: '943e85f44247f657bf9865fa341ecd633977890b',
    head: 'b27be9cf1aa02e43056620d83d65511410f00c6a',
    capped: false,
    findings: [{ id: 'F182-1', path: 'docs/reference/UPGRADE.md', from: 99, to: 99 }],
  },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'mcp/trajectory-server/dist/cli.js');

function fail(message: string): never {
  process.stderr.write(`stale-docs-eval: ${message}\n`);
  process.exit(2);
}

if (!existsSync(cli)) fail(`no built CLI at ${cli}; build mcp/trajectory-server first`);

for (const { base, head } of REPLAYS) {
  for (const sha of [base, head]) {
    const r = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root });
    if (r.status !== 0) fail(`case commit ${sha} is missing from the object store`);
  }
}

let caught = 0;
let total = 0;
let overBudget = false;
for (const { base, head, capped, findings } of REPLAYS) {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', cli, 'stale-docs', base, '--head', head], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) fail(`stale-docs ${base} --head ${head} exited ${r.status}: ${r.stderr.trim()}`);
  const flags = r.stdout.split('\n').flatMap((line) => {
    const m = /^(.+?):(\d+): /.exec(line);
    return m ? [{ path: m[1], line: Number(m[2]) }] : [];
  });
  const over = capped && flags.length > MAX_FLAGS;
  if (over) overBudget = true;
  process.stdout.write(`replay ${base.slice(0, 7)}..${head.slice(0, 7)}: ${flags.length} flags${over ? ` (over ${MAX_FLAGS})` : capped ? '' : ' (uncapped)'}\n`);
  for (const f of findings) {
    total++;
    const hit = flags.some((flag) => flag.path === f.path && flag.line >= f.from && flag.line <= f.to);
    if (hit) caught++;
    const range = f.from === f.to ? `${f.from}` : `${f.from}-${f.to}`;
    process.stdout.write(`  ${f.id} ${f.path}:${range}: ${hit ? 'caught' : 'missed'}\n`);
  }
}

process.stdout.write(`caught ${caught}/${total} (need ${MIN_CAUGHT}); flag budget ${overBudget ? 'exceeded' : 'met'}\n`);
process.exit(caught >= MIN_CAUGHT && !overBudget ? 0 : 1);
