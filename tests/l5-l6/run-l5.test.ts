// node:test suite for run-l5.ts: the CLI's token and PATH checks, leaf-row discovery, the filter,
// a passing row, a failing setup-l5.sh, a failing setup-l5.ts preferred over its .sh, the per-row step env and the summary line. main runs
// against a fixture rows dir with a stub claude on PATH and a stubbed pre-flight; no test calls
// the real claude.
// Run: node --experimental-strip-types --experimental-sqlite --test tests/l5-l6/run-l5.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { discoverRows, main } from './run-l5.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_L5 = join(HERE, 'run-l5.ts');
const NO_SQLITE3 = spawnSync('sqlite3', ['-version']).status !== 0 && 'sqlite3 not installed';

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'tmb-run-l5.'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[2] === '--version') { process.stdout.write('9.9.9 (stub)\\n'); process.exit(0); }
fs.appendFileSync(process.env.STUB_RECORD, JSON.stringify({ cwd: process.cwd(), FLOW_NAME: process.env.FLOW_NAME, RUN_ID: process.env.RUN_ID, HOME: process.env.HOME, TRAJECTORY_DB_PATH: process.env.TRAJECTORY_DB_PATH }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }) + '\\n');
`;

function writeRow(root: string, rel: string, files: Record<string, string>): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function fixtureRows(): { rows: string; setupRecord: string; tsSetupRecord: string } {
  const rows = tempDir('tmb-run-l5-rows.');
  const setupRecord = join(rows, 'setup-project.txt');
  const tsSetupRecord = join(rows, 'ts-setup-project.txt');
  writeRow(rows, '01-pass', { 'prompt.txt': 'say done\n' });
  writeRow(rows, '02-setup-fail', {
    'prompt.txt': 'unused\n',
    'setup-l5.sh': `printf '%s' "$1" > ${JSON.stringify(setupRecord)}\nexit 3\n`,
  });
  writeRow(rows, '03/03.01-nested', { 'prompt.txt': 'nested\n', 'fixture.txt': 'onboarding-named\n' });
  writeRow(rows, '04-fixture-only', { 'fixture.txt': 'onboarding-named\n' });
  writeRow(rows, '05-container/nothing-here', { 'notes.md': 'x\n' });
  writeRow(rows, '06-setup-ts-fail', {
    'prompt.txt': 'unused\n',
    'setup-l5.ts': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(tsSetupRecord)}, process.argv[2]);\nprocess.exit(4);\n`,
    'setup-l5.sh': 'exit 0\n',
  });
  return { rows, setupRecord, tsSetupRecord };
}

function stubEnv(): { env: NodeJS.ProcessEnv; record: string } {
  const bin = tempDir('tmb-run-l5-bin.');
  writeFileSync(join(bin, 'claude'), STUB_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  const record = join(bin, 'record.jsonl');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    TMPDIR: realpathSync(tempDir('tmb-run-l5-tmp.')),
    TMB_DISABLE_REMOTE_SYNC: '1',
    STUB_RECORD: record,
  };
  delete env.FLOW_NAME;
  delete env.RUN_ID;
  delete env.TRAJECTORY_DB_PATH;
  return { env, record };
}

function calls(record: string): Record<string, string>[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function captured(fn: () => number): { code: number; stdout: string } {
  const write = process.stdout.write.bind(process.stdout);
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: fn(), stdout };
  } finally {
    process.stdout.write = write;
  }
}

function runMain(argv: string[], rows: string, env: NodeJS.ProcessEnv): { code: number; stdout: string; preFlights: number } {
  let preFlights = 0;
  const { code, stdout } = captured(() =>
    main(argv, {
      rowsRoot: rows,
      env,
      preFlight: () => {
        preFlights++;
      },
    }),
  );
  return { code, stdout, preFlights };
}

describe('CLI checks', () => {
  const cli = (env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-sqlite', '--no-warnings', RUN_L5], { env, encoding: 'utf8' });

  test('a missing CLAUDE_CODE_OAUTH_TOKEN exits 1 with the .sh message', () => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const r = cli(env);
    assert.equal(r.status, 1);
    assert.equal(
      r.stdout,
      '❌ CLAUDE_CODE_OAUTH_TOKEN not set.\n   For local runs: export CLAUDE_CODE_OAUTH_TOKEN=...\n   For CI: configure as a repo secret (Settings → Secrets).\n',
    );
  });

  test('claude missing from PATH exits 1 with the .sh message', () => {
    const r = cli({ ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'tok', PATH: tempDir() });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '❌ claude not found in PATH.\n');
  });

  test('sqlite3 missing from PATH exits 1 with the .sh message; jq is not required', () => {
    const bin = tempDir();
    writeFileSync(join(bin, 'claude'), STUB_CLAUDE);
    chmodSync(join(bin, 'claude'), 0o755);
    const r = cli({ ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'tok', PATH: bin });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '❌ sqlite3 not found in PATH.\n');
  });

  test('importing the module does not run main', () => {
    assert.equal(typeof main, 'function');
  });
});

describe('discoverRows', () => {
  test('finds leaves one and two levels deep, level one first, and skips marker-less dirs', () => {
    const { rows } = fixtureRows();
    assert.deepEqual(
      discoverRows(rows).map((r) => r.name),
      ['01-pass', '02-setup-fail', '04-fixture-only', '06-setup-ts-fail', '03.01-nested'],
    );
  });
});

describe('main (stub claude, stubbed pre-flight)', { skip: NO_SQLITE3 }, () => {
  test('runs every prompt row: a pass, a failed setup-l5.sh and a failed setup-l5.ts with their projects removed, a skipped fixture-only row; exits 1', () => {
    const { rows, setupRecord, tsSetupRecord } = fixtureRows();
    const { env, record } = stubEnv();
    const before = JSON.stringify(process.env);
    const { code, stdout, preFlights } = runMain([], rows, env);
    assert.equal(JSON.stringify(process.env), before);
    assert.equal(preFlights, 1);
    assert.equal(code, 1);
    assert.match(stdout, /=== claude --version \(informational\) ===\n {2}9\.9\.9 \(stub\)\n/);
    assert.match(stdout, /=== L5 row: 01-pass ===[\s\S]* {2}✓ 01-pass passed\n/);
    assert.match(stdout, / {2}✗ 02-setup-fail: setup-l5\.sh failed\n/);
    assert.match(stdout, / {2}✓ 03\.01-nested passed\n/);
    assert.doesNotMatch(stdout, /04-fixture-only|nothing-here/);
    assert.match(stdout, / {2}✗ 06-setup-ts-fail: setup-l5\.ts failed\n/);
    assert.match(stdout, /\nL5: 2 passed, 2 failed\nFailed rows: 02-setup-fail 06-setup-ts-fail\n$/);

    for (const file of [setupRecord, tsSetupRecord]) {
      const setupProject = readFileSync(file, 'utf8');
      assert.ok(setupProject.startsWith(join(env.TMPDIR as string, 'tmb-l5-')));
      assert.equal(existsSync(setupProject), false);
    }

    const runs = calls(record);
    assert.deepEqual(runs.map((c) => c.FLOW_NAME), ['01-pass', '03.01-nested']);
    for (const run of runs) {
      assert.match(run.RUN_ID, new RegExp(`^\\d+-${process.pid}-${run.FLOW_NAME.replace('.', '\\.')}$`));
      assert.equal(run.HOME, join(run.cwd, '_home'));
      assert.equal(run.TRAJECTORY_DB_PATH, join(run.cwd, '.claude', 'tmb', 'trajectory.db'));
      assert.equal(existsSync(run.cwd), false);
    }
  });

  test('the filter keeps rows whose name holds it; all passing exits 0', () => {
    const { rows } = fixtureRows();
    const { env, record } = stubEnv();
    const { code, stdout } = runMain(['pass'], rows, env);
    assert.equal(code, 0);
    assert.deepEqual(calls(record).map((c) => c.FLOW_NAME), ['01-pass']);
    assert.doesNotMatch(stdout, /02-setup-fail|03\.01-nested/);
    assert.match(stdout, /\nL5: 1 passed, 0 failed\n$/);
  });
});
