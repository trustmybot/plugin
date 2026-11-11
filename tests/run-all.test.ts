// node:test suite for run-all.ts's pure helpers: TMB_L1_SKIP matching, the --l1-local step list, the
// unwired-lint self-check, the HOME footprint filter, the mise env derivation from PATH, the post-L1 env,
// the generated live-CLI stubs, SIGINT/SIGTERM stopping a run and --l1-local's SKIP lines (stub bun on
// PATH, so no real step runs).
// Run: node --experimental-strip-types --test tests/run-all.test.ts

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import {
  abortSignal,
  homeLeaks,
  l1LintFiles,
  l1LocalSteps,
  l1Skipped,
  l1Steps,
  miseEnv,
  parseArgs,
  postL1Env,
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
    assert.equal(parseArgs(['--l1-only']).l1Local, false);
  });
  test('--l1-local as the first arg stops after L1 and selects the local tier', () => {
    assert.deepEqual(parseArgs(['--l1-local']), { l1Only: true, l1Local: true });
    assert.deepEqual(parseArgs([]), { l1Only: false, l1Local: false });
    assert.deepEqual(parseArgs(['x', '--l1-local']), { l1Only: false, l1Local: false });
  });
});

describe('l1LocalSteps', () => {
  const table = l1Steps(HERE);
  const local = l1LocalSteps(table);
  const lintNames = (steps: typeof table) => steps.map(([, argv]) => argv.at(-1)!.split('/').pop());
  test('is the L1 table minus exactly its slow-flagged steps, in table order', () => {
    const slow = table.filter(([, , isSlow]) => isSlow === true);
    assert.ok(slow.length > 0, 'the L1 table flags at least one slow step');
    assert.equal(local.length, table.length - slow.length);
    assert.deepEqual(local, table.filter((step) => !slow.includes(step)));
    for (const step of slow) assert.ok(!local.includes(step), `${step[0]} is skipped`);
  });
  test('keeps the lints CI used to catch first', () => {
    const names = lintNames(local);
    for (const lint of [
      'tsc-noemit.test.mjs',
      'eslint.test.mjs',
      'agent-line-budget.test.mjs',
      'changelog-current.test.mjs',
      'link-check.test.mjs',
      'tool-description-budget.test.mjs',
    ]) {
      assert.ok(names.includes(lint), `${lint} runs under --l1-local`);
    }
  });
  test('runs every dashboard/test/*.test.mjs file, as pr-check does (GH 2866)', () => {
    const glob = join(dirname(HERE), 'dashboard', 'test', '*.test.mjs');
    const steps = local.filter(([, argv]) => argv.includes(glob));
    assert.equal(steps.length, 1, 'one --l1-local step runs the dashboard tests');
    assert.deepEqual(steps[0][1], ['node', '--test', glob]);
    assert.ok(readdirSync(dirname(glob)).some((name) => name.endsWith('.test.mjs')), 'the glob matches dashboard test files');
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
    assert.deepEqual(unwiredLints(['link-check.test.mjs', 'brand-new.test.mjs', 'brand-new.sh'], steps), [
      'brand-new.test.mjs',
      'brand-new.sh',
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

describe('postL1Env', () => {
  test('TMB_L1_OFFLINE is dropped for L2-L4, every other var is kept', () => {
    const env = postL1Env({ TMB_L1_OFFLINE: '1', PATH: '/usr/bin', TMB_DISABLE_REMOTE_SYNC: '1' });
    assert.deepEqual(env, { PATH: '/usr/bin', TMB_DISABLE_REMOTE_SYNC: '1' });
  });
});

describe('abortSignal', () => {
  test('a received signal wins, else a SIGINT or SIGTERM that killed the child', () => {
    assert.equal(abortSignal('SIGTERM', null), 'SIGTERM');
    assert.equal(abortSignal('SIGINT', 'SIGTERM'), 'SIGINT');
    assert.equal(abortSignal(undefined, 'SIGINT'), 'SIGINT');
    assert.equal(abortSignal(undefined, 'SIGTERM'), 'SIGTERM');
    assert.equal(abortSignal(undefined, 'SIGKILL'), undefined);
    assert.equal(abortSignal(undefined, null), undefined);
  });
});

describe('a run with a stub bun', () => {
  const runAll = join(HERE, 'run-all.ts');

  function fixture(bunBody: string): { env: NodeJS.ProcessEnv; tmp: string; root: string } {
    const root = tempDir();
    const bin = join(root, 'bin');
    const tmp = join(root, 'tmp');
    mkdirSync(bin);
    mkdirSync(tmp);
    writeFileSync(join(bin, 'bun'), `#!/usr/bin/env node\n${bunBody}\n`, { mode: 0o755 });
    const PATH = [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter);
    return { env: { ...process.env, PATH, TMPDIR: tmp }, tmp, root };
  }

  function runDirs(tmp: string): string[] {
    return readdirSync(tmp).filter((name) => name.startsWith('tmb-run-all.'));
  }

  test('a step killed by SIGINT (Ctrl-C) ends the run with 130, no later step, temp dir removed', () => {
    const { env, tmp } = fixture("process.kill(process.ppid, 'SIGINT');\nprocess.kill(process.pid, 'SIGINT');");
    const r = spawnSync(process.execPath, ['--experimental-strip-types', runAll, '--l1-only'], {
      encoding: 'utf8',
      env,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    assert.equal(r.status, 130, r.stdout);
    assert.match(r.stdout, /=== Build: generated payload/);
    assert.doesNotMatch(r.stdout, /=== L1 lint/);
    assert.deepEqual(runDirs(tmp), []);
  });

  test('SIGTERM to the orchestrator stops the current step, exits 143 and removes the temp dir', async () => {
    const { env, tmp, root } = fixture(
      "require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'bun.pid'), String(process.pid));\nsetInterval(() => {}, 1000);",
    );
    const child = spawn(process.execPath, ['--experimental-strip-types', runAll, '--l1-only'], { env });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const closed = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
    const pidFile = join(root, 'bun.pid');
    const deadline = Date.now() + 20000;
    while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') {
      assert.ok(Date.now() < deadline, 'bun stub never started');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill('SIGTERM');
    assert.equal(await closed, 143, stdout);
    assert.doesNotMatch(stdout, /=== L1 lint/);
    assert.deepEqual(runDirs(tmp), []);
    const stubPid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(stubPid, 0), { code: 'ESRCH' });
  });

  test('--l1-local prints SKIP for each slow step and wm-equivalence, then stops after L1', () => {
    const { env } = fixture('process.exit(0);');
    const everyStepFile = l1Steps(HERE)
      .map(([, argv]) => argv.at(-1)!.split('/').pop())
      .concat('selftest.test.mjs');
    const r = spawnSync(process.execPath, ['--experimental-strip-types', runAll, '--l1-local'], {
      encoding: 'utf8',
      env: { ...env, TMB_L1_SKIP: everyStepFile.join(' ') },
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    assert.equal(r.status, 0, r.stdout);
    for (const [label] of l1Steps(HERE).filter(([, , slow]) => slow === true)) {
      assert.ok(r.stdout.includes(`=== ${label} ===\n→ SKIP (--l1-local)`), `${label} skipped:\n${r.stdout}`);
    }
    assert.match(r.stdout, /=== L1 world model: incremental reindex equals a clean rebuild \(wm-equivalence\.test\.js\) ===\n→ SKIP \(--l1-local\)/);
    assert.match(r.stdout, /=== L1 lint: typescript-eslint against the suppressions baseline ===\n→ SKIP \(TMB_L1_SKIP\)/);
    assert.doesNotMatch(r.stdout, /=== L2/);
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
