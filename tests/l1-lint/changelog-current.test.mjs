// L1 lint: the CHANGELOG and its changelog.d/ fragments are current.
//
//   1. The top `## vX.Y.Z` section of CHANGELOG.md matches plugin.json.
//   2. Every changelog.d/ fragment is well formed (changelog.d/README.md).
//   3. On a feature branch (diff against origin/<TMB_PR_TARGET>, default dev):
//      - editing CHANGELOG.md and adding a fragment fails — pick one;
//      - after CUTOVER, any direct CHANGELOG.md edit fails, except on a version
//        bump branch, on the branches already in flight at the cut-over
//        (every GH issue its commits cite is in TRANSITION), and for a
//        redaction-only edit (no net added lines, no `#` line touched);
//      - each `GH <n>` cited in a branch commit subject needs a fragment
//        changelog.d/<n>-*.md or an entry in CHANGELOG.md.
//
// changelogCurrent(root, { today, baseBranch, env }) lints another checkout (tests).
// today defaults to TMB_CHANGELOG_TODAY, else today's UTC date (YYYY-MM-DD);
// baseBranch defaults to TMB_PR_TARGET, else dev; env is the environment for
// every git and fragments-lib spawn, default the inherited process.env.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = join(ROOT, 'scripts/maintenance/lib/changelog-fragments.ts');

const CUTOVER = '2026-10-12';
const TRANSITION = ['1226', '1229', '1245', '1277', '1294', '1295'];
const TOP_SECTION = /^## v[0-9].*$/m;
const CITED = /GH [0-9]+/g;

function run(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function outputLines(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function jqVersion(text) {
  const version = JSON.parse(text)?.version;
  if (version === undefined || version === null) return 'null';
  return typeof version === 'string' ? version : JSON.stringify(version);
}

function readOr(path, fallback) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function hasFragmentFor(root, n) {
  const dir = join(root, 'changelog.d');
  if (!existsSync(dir)) return false;
  const prefix = `${n}-`;
  return readdirSync(dir).some((name) => name.startsWith(prefix) && name.endsWith('.md') && name.length >= prefix.length + 3);
}

/** The CHANGELOG.md diff since mergeBase adds no more lines than it removes and touches no `#` line. */
function isRedactionOnly(git, mergeBase) {
  const [added, removed] = git('diff', '--numstat', mergeBase, '--', 'CHANGELOG.md').stdout.trim().split('\t').map(Number);
  if (!Number.isInteger(added) || !Number.isInteger(removed) || added > removed) return false;
  const diff = outputLines(git('diff', '-U0', mergeBase, '--', 'CHANGELOG.md').stdout);
  const hunks = diff.slice(diff.findIndex((line) => line.startsWith('@@')));
  return !hunks.some((line) => /^[+-]#/.test(line));
}

export function changelogCurrent(rootDir, { today, baseBranch, env } = {}) {
  const root = resolve(rootDir);
  const TODAY = today || process.env.TMB_CHANGELOG_TODAY || new Date().toISOString().slice(0, 10);
  const BASE_BRANCH = baseBranch || process.env.TMB_PR_TARGET || 'dev';
  const out = [];
  let failed = false;
  const fail = (msg) => {
    out.push(`  ✗ ${msg}`);
    failed = true;
  };
  const finish = (code) => ({ code, output: out.length ? `${out.join('\n')}\n` : '' });
  const git = (...args) => run('git', args, root, env);
  const fragments = (...args) => run(process.execPath, ['--experimental-strip-types', '--no-warnings', LIB, ...args], root, env);

  // ---- 1. top section matches plugin.json ------------------------------------

  const CANON = jqVersion(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
  const EXPECTED_HEADER = `## v${CANON}`;
  const changelog = readOr(join(root, 'CHANGELOG.md'), '');
  const TOP_HEADER = changelog.match(TOP_SECTION)?.[0] ?? '';

  if (TOP_HEADER === '') {
    out.push("✗ CHANGELOG.md has no '## v<X.Y.Z>' section at all");
    return finish(1);
  }

  const TOP_VERSION = TOP_HEADER.trim().split(/\s+/).slice(0, 2).join(' ');

  if (TOP_VERSION !== EXPECTED_HEADER) {
    out.push(
      `✗ CHANGELOG.md top section is '${TOP_HEADER}'`,
      `  but plugin.json version is ${CANON}`,
      `  Expected top section to begin with: ${EXPECTED_HEADER}`,
      '',
      '  Either bump plugin.json to match the top CHANGELOG section,',
      `  or run scripts/maintenance/bump-version.ts, which writes the '${EXPECTED_HEADER} — YYYY-MM-DD' section.`,
    );
    return finish(1);
  }
  out.push(`  ✓ CHANGELOG top section matches plugin.json version: ${CANON}`);

  // ---- 2. fragments well formed ----------------------------------------------

  const frags = outputLines(fragments('list', 'changelog.d').stdout);
  if (frags.length > 0) {
    for (const p of outputLines(fragments('validate', ...frags).stdout)) fail(p);
  }
  if (!failed) out.push(`  ✓ ${frags.length} changelog.d/ fragment(s) well formed`);

  // ---- 3. feature-branch rules -----------------------------------------------

  const head = git('symbolic-ref', '--short', '-q', 'HEAD');
  let BRANCH = head.status === 0 ? head.stdout.trim() : '';
  const BASE_REF = `origin/${BASE_BRANCH}`;
  if (['', 'dev', 'main', 'master', BASE_BRANCH].includes(BRANCH)) {
    out.push(`  ⊘ not on a feature branch (${BRANCH || 'detached HEAD'}) — branch rules skipped`);
    BRANCH = '';
  }
  if (BRANCH !== '' && git('rev-parse', '--verify', '-q', BASE_REF).status !== 0) {
    out.push(`  ⊘ ${BASE_REF} not found — branch rules skipped (git fetch origin ${BASE_BRANCH})`);
    BRANCH = '';
  }

  if (BRANCH !== '') {
    const mergeBase = git('merge-base', 'HEAD', BASE_REF);
    assert.equal(mergeBase.status, 0, `git merge-base HEAD ${BASE_REF} failed`);
    const MB = mergeBase.stdout.trim();
    const CHANGED = [
      ...new Set([
        ...outputLines(git('diff', '--name-only', MB).stdout),
        ...outputLines(git('ls-files', '--others', '--exclude-standard').stdout),
      ]),
    ].sort();

    const changelogEdited = CHANGED.includes('CHANGELOG.md');
    const branchFragments = CHANGED.filter(
      (p) => p !== 'changelog.d/README.md' && p.startsWith('changelog.d/') && p.endsWith('.md') && isFile(join(root, p)),
    )
      .map((p) => ` ${p}`)
      .join('');

    const shown = git('show', `${MB}:.claude-plugin/plugin.json`);
    let baseVersion = '';
    if (shown.status === 0 && shown.stdout.trim() !== '') {
      try {
        baseVersion = jqVersion(shown.stdout);
      } catch {
        baseVersion = '';
      }
    }
    const bumpBranch = baseVersion !== '' && baseVersion !== CANON;

    const seen = new Set();
    const cited = [...git('log', '--format=%s', `${MB}..HEAD`).stdout.matchAll(CITED)]
      .map((m) => m[0].slice(3))
      .sort((a, b) => Number(a) - Number(b))
      .filter((n) => !seen.has(Number(n)) && seen.add(Number(n)));

    if (bumpBranch) {
      out.push(`  ⊘ version bump branch (${baseVersion} → ${CANON}) — CHANGELOG.md is assembled here`);
    } else {
      if (changelogEdited && branchFragments !== '') {
        fail(`branch ${BRANCH} edits CHANGELOG.md and adds fragment(s):${branchFragments} — pick one (a fragment)`);
      }
      if (changelogEdited && TODAY > CUTOVER) {
        const inFlight = cited.length > 0 && cited.every((n) => TRANSITION.includes(n));
        if (!inFlight && isRedactionOnly(git, MB)) {
          out.push('  ⊘ redaction-only CHANGELOG.md edit');
        } else if (!inFlight) {
          fail(
            `branch ${BRANCH} edits CHANGELOG.md directly; since ${CUTOVER} a change adds changelog.d/<gh-issue>-<slug>.md instead (changelog.d/README.md)`,
          );
        }
      }
    }

    for (const n of cited) {
      if (hasFragmentFor(root, n)) continue;
      if (new RegExp(`GH ${n}(?:[^0-9]|$)`, 'm').test(changelog)) continue;
      fail(`branch ${BRANCH} cites GH ${n} but there is no changelog.d/${n}-<slug>.md fragment (and no CHANGELOG.md entry)`);
    }
    if (!failed) out.push(`  ✓ branch ${BRANCH}: changelog rules hold vs ${BASE_REF}`);
  }

  out.push('');
  if (failed) {
    out.push('Changelog-current: FAIL');
    return finish(1);
  }
  out.push('Changelog-current: PASS');
  return finish(0);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  test('CHANGELOG.md and changelog.d/ are current', () => {
    const { code, output } = changelogCurrent(ROOT);
    assert.equal(code, 0, output);
  });
}
