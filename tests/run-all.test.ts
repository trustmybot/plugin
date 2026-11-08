// node:test suite for run-all.ts's pure helpers: TMB_L1_SKIP matching, the unwired-lint self-check,
// the HOME footprint filter, the mise env derivation from PATH, and the generated live-CLI stubs.
// Run: node --experimental-strip-types --test tests/run-all.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import {
  homeLeaks,
  l1LintFiles,
  l1Skipped,
  l1Steps,
  miseEnv,
  parseArgs,
  unwiredLints,
  walkTree,
  writeStubs,
} from './run-all.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-run-all-test.'));
  roots.push(dir);
  return dir;
}

describe('parseArgs', () => {
  test('--l1-only as the first arg', () => {
    assert.equal(parseArgs(['--l1-only']).l1Only, true);
    assert.equal(parseArgs([]).l1Only, false);
    assert.equal(parseArgs(['x', '--l1-only']).l1Only, false);
  });
});

describe('l1Skipped', () => {
  const argv = ['node', '--test', '/p/tests/l1-lint/tool-description-budget.test.mjs'];
  test('matches a basename in the space-separated list', () => {
    assert.equal(l1Skipped(argv, 'tool-description-budget.test.mjs'), true);
    assert.equal(l1Skipped(argv, '  other.test.mjs   tool-description-budget.test.mjs '), true);
  });
  test('no list, a partial name or another lint does not match', () => {
    assert.equal(l1Skipped(argv, undefined), false);
    assert.equal(l1Skipped(argv, ''), false);
    assert.equal(l1Skipped(argv, 'tool-description-budget'), false);
    assert.equal(l1Skipped(argv, 'link-check.test.mjs'), false);
  });
});

describe('unwiredLints', () => {
  test('a lint with no step is reported', () => {
    const steps = l1Steps('/p/tests');
    assert.deepEqual(unwiredLints(['link-check.test.mjs', 'brand-new.test.mjs', 'codex-scope4-contract.sh'], steps), [
      'brand-new.test.mjs',
    ]);
  });
  test('every lint in tests/l1-lint is wired', () => {
    assert.deepEqual(unwiredLints(l1LintFiles(join(HERE, 'l1-lint')), l1Steps(HERE)), []);
  });
});

describe('HOME footprint', () => {
  test('.cache/huggingface is allowed, anything else is reported', () => {
    const home = tempDir();
    mkdirSync(join(home, '.cache', 'huggingface', 'hub'), { recursive: true });
    writeFileSync(join(home, '.cache', 'huggingface', 'hub', 'model.bin'), 'x');
    mkdirSync(join(home, '.cache', 'bun'), { recursive: true });
    writeFileSync(join(home, '.npmrc'), 'x');
    assert.deepEqual(homeLeaks(walkTree(home)), ['.cache/bun', '.npmrc']);
  });
  test('a HOME holding only .cache/huggingface has no leaks', () => {
    assert.deepEqual(homeLeaks(['.cache', '.cache/huggingface', '.cache/huggingface/hub']), []);
  });
});

describe('miseEnv', () => {
  const runTmp = '/run';
  test('MISE_DATA_DIR comes from the first PATH entry under mise/installs', () => {
    const PATH = ['/usr/bin', '/h/.local/share/mise/installs/node/24/bin', '/o/mise/installs/bun/1/bin'].join(delimiter);
    const env = miseEnv({ PATH }, runTmp, (p) => p === '/h/.config/mise');
    assert.equal(env.MISE_DATA_DIR, '/h/.local/share/mise');
    assert.equal(env.MISE_CONFIG_DIR, '/h/.config/mise');
    assert.equal(env.MISE_STATE_DIR, join(runTmp, 'mise-state'));
    assert.equal(env.MISE_CACHE_DIR, join(runTmp, 'mise-cache'));
  });
  test('no mise on PATH falls back under the run dir and sets no config dir', () => {
    const env = miseEnv({ PATH: '/usr/bin' }, runTmp, () => true);
    assert.equal(env.MISE_DATA_DIR, join(runTmp, 'mise-data'));
    assert.equal(env.MISE_CONFIG_DIR, undefined);
  });
  test('a set MISE_DATA_DIR or MISE_CONFIG_DIR is kept', () => {
    const env = miseEnv({ PATH: '/x/mise/installs/a', MISE_DATA_DIR: '/h/.local/share/mise', MISE_CONFIG_DIR: '/c' }, runTmp, () => true);
    assert.equal(env.MISE_DATA_DIR, undefined);
    assert.equal(env.MISE_CONFIG_DIR, undefined);
  });
  test('no config dir when the derived home lacks .config/mise', () => {
    const env = miseEnv({ PATH: '/h/.local/share/mise/installs/node/bin' }, runTmp, () => false);
    assert.equal(env.MISE_CONFIG_DIR, undefined);
  });
});

describe('writeStubs', () => {
  test('a stub appends to the sentinel, prints the stderr line and exits 97', () => {
    const dir = join(tempDir(), 'stubs');
    const sentinel = join(dir, 'live-cli-sentinel');
    writeStubs(dir, sentinel);
    assert.equal(readFileSync(sentinel, 'utf8'), '');
    for (const cli of ['gh', 'glab', 'claude']) assert.equal(statSync(join(dir, cli)).mode & 0o777, 0o755);
    const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
    const r = spawnSync(join(dir, 'gh'), ['issue', 'list'], { encoding: 'utf8', env });
    assert.equal(r.status, 97);
    assert.equal(r.stderr, 'tmb test-stub: gh blocked (exit 97)\n');
    spawnSync(join(dir, 'claude'), [], { env });
    assert.equal(readFileSync(sentinel, 'utf8'), 'LIVE-CLI BLOCKED: gh issue list\nLIVE-CLI BLOCKED: claude \n');
  });
});
