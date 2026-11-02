// Prints the dev-build version for REF: X.Y.Z-dev.<n>[.gh<PR>].
//
// Usage:
//   node --experimental-strip-types scripts/maintenance/dev-build-version.ts --next X.Y.Z [--pr N] [--ref REF]
//
//   --next  the version the dev line is heading for (e.g. the open milestone)
//   --pr    the PR that produced REF; a label only, never used for ordering
//   --ref   the commit to stamp (default: HEAD)
//
// LAST = the highest stable vX.Y.Z tag in the repo by version sort, reachable
// from REF or not: release tags sit on main merge commits that dev never
// contains. n = first-parent commits in LAST..REF, the dev commits not yet in
// that release, so n resets after each release; every first-parent commit when
// there is no stable tag. --next must be above LAST by SemVer.
// Operates on the cwd's git repo. Prints exactly one line.

import { spawnSync } from 'node:child_process';

const USAGE = `Usage: ${process.argv[1] ?? 'dev-build-version.ts'} --next X.Y.Z [--pr N] [--ref REF]\n`;
const NEXT = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const PR = /^[1-9][0-9]*$/;
const STABLE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

function fail(message: string): never {
  process.stderr.write(message);
  process.exit(1);
}

function git(args: string[]): { status: number; stdout: string } {
  const r = spawnSync('git', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

function semverGt(a: string, b: string): boolean {
  const x = a.split('.').map(BigInt);
  const y = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    const p = x[i] ?? 0n;
    const q = y[i] ?? 0n;
    if (p !== q) return p > q;
  }
  return false;
}

function parseArgs(argv: string[]): { next: string; pr: string; ref: string } {
  const o = { next: '', pr: '', ref: 'HEAD' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) fail(USAGE);
    if (flag === '--next') o.next = value;
    else if (flag === '--pr') o.pr = value;
    else if (flag === '--ref') o.ref = value;
    else fail(USAGE);
  }
  if (o.next === '') fail(USAGE);
  if (!NEXT.test(o.next)) fail(`Error: --next '${o.next}' is not X.Y.Z\n`);
  if (o.pr !== '' && !PR.test(o.pr)) fail(`Error: --pr '${o.pr}' is not a PR number\n`);
  return o;
}

const { next, pr, ref } = parseArgs(process.argv.slice(2));

if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status !== 0) fail(`Error: '${ref}' is not a commit\n`);

const tag = git(['tag', '-l', 'v[0-9]*', '--sort=-v:refname']).stdout.split('\n').find((t) => STABLE_TAG.test(t)) ?? '';

if (tag !== '' && !semverGt(next, tag.slice(1))) fail(`Error: --next '${next}' is not above the latest release ${tag}\n`);
const count = git(['rev-list', '--first-parent', '--count', tag === '' ? ref : `${tag}..${ref}`]);
if (count.status !== 0) process.exit(count.status);

process.stdout.write(`${next}-dev.${count.stdout.replace(/\n+$/, '')}${pr === '' ? '' : `.gh${pr}`}\n`);
