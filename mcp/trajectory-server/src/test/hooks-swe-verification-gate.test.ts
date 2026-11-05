/**
 * Unit tests of the TypeScript swe-verification-gate (GH 1692): its budget
 * parse, awk's seconds rounding, the toolchain PATH join, and the divergences
 * from the .sh that decision 703 allows: on a PATH holding neither jq nor the
 * sqlite3 CLI, where the .sh lets every completion through, the gate still
 * runs verification[], denies a failing command and records a passing run.
 * Then the suite-slot lock (GH 2092): concurrent gate runs of full suites
 * serialize outside the budget, a wait past the cap denies unrecorded, a
 * nested test-run shares the gate's slot and a targeted command never waits.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { findGate, gateNames } from '../hooks/registry.js';
import { commandOnPath } from '../hooks/lib/persona.js';
import {
  joinToolchainPath,
  msToS,
  parseBudget,
  suiteWaitCapS,
  sweVerificationGate,
  toolchainDirs,
  TRAJECTORY_PRETOOLUSE_TIMEOUT_S,
  VERIFICATION_DEFAULT_S,
  VERIFICATION_MAX_S,
} from '../hooks/swe-verification-gate.js';
import { acquireSuiteSlot } from '../suite-lock.js';
import { buildVerificationSandbox } from './hooks-swe-verification-parity.suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '../../../..');

const ALLOWED = { stdout: '', code: 0 };

function decision(stdout: string): { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } {
  assert.ok(stdout.endsWith('\n'));
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  return out.hookSpecificOutput;
}

function completion(taskId: unknown, agent = 'swe', status = 'completed'): string {
  return JSON.stringify({ tool_name: 'mcp__plugin_tmb_trajectory-server__task_update_status', tool_input: { agent, task_id: taskId, status } });
}

describe('swe-verification-gate is registered', () => {
  it('is a gate dist/hooks-gates.txt lists', () => {
    assert.equal(findGate('swe-verification-gate'), sweVerificationGate);
    assert.ok(gateNames().includes('swe-verification-gate'));
  });
});

describe('swe-verification-gate budget', () => {
  it('defaults to 900s with no warning when unset', () => {
    assert.deepEqual(parseBudget(''), { timeoutS: VERIFICATION_DEFAULT_S, warning: '' });
  });
  it('takes an integer from 1 to 1800 as is', () => {
    assert.deepEqual(parseBudget('1'), { timeoutS: 1, warning: '' });
    assert.deepEqual(parseBudget('0042'), { timeoutS: 42, warning: '' });
    assert.deepEqual(parseBudget('1800'), { timeoutS: 1800, warning: '' });
  });
  it('caps a larger integer at 1800 silently, ten digits or more included', () => {
    assert.deepEqual(parseBudget('1801'), { timeoutS: VERIFICATION_MAX_S, warning: '' });
    assert.deepEqual(parseBudget('99999999999999'), { timeoutS: VERIFICATION_MAX_S, warning: '' });
  });
  it('warns and falls back to 900s on 0 or a non-integer, newlines shown as spaces', () => {
    const warning = (raw: string): string => `swe-verification-gate: verification_timeout_s '${raw}' is not an integer from 1 to 1800; using the default 900s\n`;
    assert.deepEqual(parseBudget('0'), { timeoutS: 900, warning: warning('0') });
    assert.deepEqual(parseBudget('abc'), { timeoutS: 900, warning: warning('abc') });
    assert.deepEqual(parseBudget('-5'), { timeoutS: 900, warning: warning('-5') });
    assert.deepEqual(parseBudget('1\n2'), { timeoutS: 900, warning: warning('1 2') });
  });
});

describe('swe-verification-gate helpers', () => {
  it("msToS rounds as awk's %.1f does, an exact tie to even", () => {
    assert.equal(msToS(0), '0.0');
    assert.equal(msToS(50), '0.1');
    assert.equal(msToS(150), '0.1');
    assert.equal(msToS(250), '0.2');
    assert.equal(msToS(750), '0.8');
    assert.equal(msToS(1250), '1.2');
    assert.equal(msToS(61_000), '61.0');
  });
  it('joinToolchainPath puts the toolchain dirs first and keeps each dir once', () => {
    assert.equal(joinToolchainPath(['/a', '', '/b'], '/usr/bin:/a:/bin'), '/a:/b:/usr/bin:/bin');
    assert.equal(joinToolchainPath([], '/usr/bin::/bin'), '/usr/bin:/bin');
  });
  it('toolchainDirs asks mise for the bin-paths of the worktree, not the hook process cwd (GH 2134)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'toolchain-dirs-')));
    try {
      const mise = join(dir, 'mise');
      const worktree = join(dir, 'worktree');
      mkdirSync(worktree);
      writeFileSync(mise, '#!/bin/bash\npwd -P\n');
      chmodSync(mise, 0o755);
      assert.ok(toolchainDirs({ HOME: dir, MISE_INSTALL_PATH: mise }, worktree).includes(worktree));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('swe-verification-gate without jq or the sqlite3 CLI (decision 703)', () => {
  let base: string;
  let s: string;
  let bin: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-verification-unit-')));
    s = join(base, 'sandbox');
    buildVerificationSandbox(s);
    bin = join(base, 'bin');
    mkdirSync(bin);
    const dirs = (process.env.PATH ?? '').split(':').filter((d) => d !== '');
    for (const cmd of ['bash', 'git', 'sleep', 'mkdir', 'rm']) {
      const dir = dirs.find((d) => existsSync(join(d, cmd)));
      if (dir !== undefined) symlinkSync(join(dir, cmd), join(bin, cmd));
    }
  });
  after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
    MISE_DATA_DIR: join(base, 'mise'),
    PATH: bin,
    LC_ALL: 'C',
    ...extra,
  });

  it('the PATH under test holds neither jq nor sqlite3', () => {
    assert.equal(commandOnPath('jq', env()), false);
    assert.equal(commandOnPath('sqlite3', env()), false);
  });
  it('lets a non-swe caller, a status other than completed and a missing task id through', async () => {
    assert.deepEqual(await sweVerificationGate(completion(31, 'bro'), env()), ALLOWED);
    assert.deepEqual(await sweVerificationGate(completion(31, 'swe', 'running'), env()), ALLOWED);
    assert.deepEqual(await sweVerificationGate(completion(undefined), env()), ALLOWED);
  });
  it('denies a failing command', async () => {
    const r = await sweVerificationGate(completion(31), env());
    assert.equal(r.code, 0);
    const out = decision(r.stdout);
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason ?? '', /^BLOCKED: verification failed\.\nFailing command \(2\/2\): /);
  });
  it('allows a passing run and records it', async () => {
    assert.deepEqual(await sweVerificationGate(completion(30), env()), ALLOWED);
    const db = new DatabaseSync(join(s, 'project/.claude/tmb/trajectory.db'), { readOnly: true });
    try {
      const run = db.prepare("SELECT exit_code, timed_out FROM verification_runs WHERE task_id = 30 AND source = 'gate'").get() as { exit_code: number; timed_out: number };
      assert.deepEqual({ ...run }, { exit_code: 0, timed_out: 0 });
      const commands = db.prepare('SELECT ordinal, command, exit_code FROM verification_run_commands WHERE run_id = (SELECT id FROM verification_runs WHERE task_id = 30) ORDER BY ordinal').all();
      assert.deepEqual(
        commands.map((c) => ({ ...c })),
        [
          { ordinal: 1, command: 'true', exit_code: 0 },
          { ordinal: 2, command: 'echo verified', exit_code: 0 },
        ],
      );
    } finally {
      db.close();
    }
  });
  it('denies on a corrupt DB rather than letting the completion through', async () => {
    const r = await sweVerificationGate(completion(31), env({ TRAJECTORY_DB_PATH: join(s, 'bad/.claude/tmb/trajectory.db'), CLAUDE_PROJECT_DIR: join(s, 'bad') }));
    assert.match(decision(r.stdout).permissionDecisionReason ?? '', /^BLOCKED: trajectory DB unavailable/);
  });
});

describe('swe-verification-gate suite-slot lock (GH 2092)', { timeout: 120_000 }, () => {
  const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
  const GATE_URL = pathToFileURL(resolve(HERE, '../hooks/swe-verification-gate.js')).href;
  const WRAPPER = resolve(HERE, '../test-run.js');
  const T1 = '2026-11-02T10:00:00.000Z';
  const RUN_ALL = `#!/usr/bin/env bash
stamp() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }
printf 'start %s %s\\n' "$1" "$(stamp)" >> "$MARKS"
sleep "\${HOLD_S:-0}"
printf 'end %s %s\\n' "$1" "$(stamp)" >> "$MARKS"
`;
  const TASKS: { id: number; slug: string; verification: string[] }[] = [
    { id: 50, slug: 'suite-a', verification: ['bash tests/run-all.sh A'] },
    { id: 51, slug: 'suite-b', verification: ['bash tests/run-all.sh B'] },
    { id: 52, slug: 'suite-busy', verification: ['bash tests/run-all.sh C'] },
    { id: 53, slug: 'suite-nested', verification: [`${process.execPath} ${WRAPPER} -- bash tests/run-all.sh N`] },
    { id: 54, slug: 'suite-targeted', verification: ['node --test probe.test.js'] },
  ];
  let base: string;
  let lockRoot: string;
  let marksFile: string;
  let dbFile: string;

  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Suite',
    GIT_AUTHOR_EMAIL: 'suite@example.invalid',
    GIT_COMMITTER_NAME: 'Suite',
    GIT_COMMITTER_EMAIL: 'suite@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (dir: string, args: string[]): void => {
    const r = spawnSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-verification-suite-')));
    lockRoot = join(base, 'locks');
    marksFile = join(base, 'marks');
    mkdirSync(join(base, 'home'));
    const checkout = join(base, 'project/checkout');
    for (const t of TASKS) {
      const wt = join(checkout, '.claude/worktrees', t.slug);
      mkdirSync(join(wt, 'tests'), { recursive: true });
      writeFileSync(join(wt, 'tests/run-all.sh'), RUN_ALL);
      writeFileSync(join(wt, 'probe.test.js'), "import test from 'node:test';\ntest('probe', () => {});\n");
      git(wt, ['init', '-q']);
      git(wt, ['add', '.']);
      git(wt, ['commit', '-q', '-m', t.slug]);
    }
    dbFile = join(base, 'project/.claude/tmb/trajectory.db');
    mkdirSync(dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(SCHEMA);
      db.prepare('INSERT INTO repos (name, path, last_scanned_at) VALUES (?, ?, ?)').run('plugin', checkout, T1);
      db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'suite lock', 'open', ?, ?)").run(T1, T1);
      const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, verification, created_at, updated_at) VALUES (?, 1, ?, 'd', 'running', 'plugin', ?, ?, ?)");
      for (const t of TASKS) task.run(t.id, `feat/${t.slug}`, JSON.stringify(t.verification), T1, T1);
    } finally {
      db.close();
    }
  });
  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = {
      HOME: join(base, 'home'),
      CLAUDE_PROJECT_DIR: join(base, 'project'),
      TRAJECTORY_DB_PATH: dbFile,
      MISE_DATA_DIR: join(base, 'mise'),
      PATH: process.env.PATH,
      TMPDIR: base,
      TMB_SUITE_LOCK_DIR: lockRoot,
      TMB_TEST_SUITE_SLOTS: '1',
      MARKS: marksFile,
    };
    return { ...e, ...extra };
  };
  const runs = (taskId: number): { exit_code: number; timed_out: number }[] => {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      return db
        .prepare("SELECT exit_code, timed_out FROM verification_runs WHERE task_id = ? AND source = 'gate' ORDER BY id")
        .all(taskId)
        .map((r) => ({ ...(r as { exit_code: number; timed_out: number }) }));
    } finally {
      db.close();
    }
  };
  interface GateChild {
    stderr: () => string;
    done: Promise<{ stdout: string; stderr: string }>;
  }
  const gateChild = (taskId: number, e: NodeJS.ProcessEnv): GateChild => {
    const script = `const { sweVerificationGate } = await import(process.argv[1]); const r = await sweVerificationGate(process.argv[2], process.env); process.stdout.write(r.stdout);`;
    const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script, GATE_URL, completion(taskId)], {
      env: e,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    return { stderr: () => stderr, done: new Promise((ok) => child.on('exit', () => ok({ stdout, stderr }))) };
  };
  const waitFor = async (what: string, ok: () => boolean): Promise<void> => {
    const deadline = Date.now() + 30_000;
    while (!ok()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  };

  it('TRAJECTORY_PRETOOLUSE_TIMEOUT_S is the hooks.json timeout of the trajectory-server PreToolUse matcher', () => {
    const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')) as {
      hooks: { PreToolUse: { matcher: string; hooks: { timeout: number }[] }[] };
    };
    const entry = hooks.hooks.PreToolUse.find((e) => e.matcher === 'mcp__.*trajectory-server__.*');
    assert.equal(entry?.hooks[0]?.timeout, TRAJECTORY_PRETOOLUSE_TIMEOUT_S);
  });
  it('GH 2297: waits up to 1800s for a suite slot at the 1800s budget', () => {
    assert.equal(TRAJECTORY_PRETOOLUSE_TIMEOUT_S, 3630);
    assert.equal(suiteWaitCapS(VERIFICATION_MAX_S), 1800);
  });
  it('serializes two concurrent gate runs of full suites outside the budget: both pass, neither times out', async () => {
    rmSync(marksFile, { force: true });
    const e = env({ TMB_VERIFICATION_TIMEOUT_S: '8', HOLD_S: '5' });
    const held = await acquireSuiteSlot({ command: 'npm test', worktree: '/w/other', env: env() });
    assert.equal(held.kind, 'held');
    const children = [gateChild(50, e), gateChild(51, e)];
    try {
      await waitFor('both gate runs to wait for the slot', () => children.every((c) => c.stderr().includes(`waiting for a suite slot: held by pid ${process.pid}`)));
    } finally {
      if (held.kind === 'held') held.release();
    }
    const [a, b] = await Promise.all(children.map((c) => c.done));
    assert.equal(a.stdout, '', a.stdout + a.stderr);
    assert.equal(b.stdout, '', b.stdout + b.stderr);
    assert.deepEqual([...runs(50), ...runs(51)], [
      { exit_code: 0, timed_out: 0 },
      { exit_code: 0, timed_out: 0 },
    ]);
    const m = new Map(
      readFileSync(marksFile, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => {
          const [kind, id, ms] = l.split(' ');
          return [`${kind} ${id}`, Number(ms)] as const;
        }),
    );
    const [first, second] = (m.get('start A') ?? 0) < (m.get('start B') ?? 0) ? ['A', 'B'] : ['B', 'A'];
    assert.ok((m.get(`start ${second}`) ?? 0) >= (m.get(`end ${first}`) ?? Infinity), JSON.stringify([...m]));
  });
  it('denies with suite slot busy past the wait cap and records no verification run', async () => {
    const held = await acquireSuiteSlot({ command: 'npm test', worktree: '/w/other', env: env() });
    assert.equal(held.kind, 'held');
    try {
      const r = await sweVerificationGate(completion(52), env({ TMB_VERIFICATION_TIMEOUT_S: String(VERIFICATION_MAX_S), TMB_SUITE_WAIT_CAP_S: '3' }));
      const out = decision(r.stdout);
      assert.equal(out.permissionDecision, 'deny');
      assert.match(out.permissionDecisionReason ?? '', new RegExp(`^BLOCKED: suite slot busy — every suite slot is held by pid ${process.pid} \\(worktree /w/other\\) for \\d+s; waited \\d+s, the cap of 3s \\(set by TMB_SUITE_WAIT_CAP_S\\)`));
      assert.match(out.permissionDecisionReason ?? '', /Retry task_update_status/);
      assert.deepEqual(runs(52), []);
    } finally {
      if (held.kind === 'held') held.release();
    }
  });
  it('runs a nested test-run of a full suite inside the gate run on one slot', async () => {
    assert.deepEqual(await sweVerificationGate(completion(53), env({ TMB_VERIFICATION_TIMEOUT_S: '60' })), ALLOWED);
    assert.deepEqual(runs(53), [{ exit_code: 0, timed_out: 0 }]);
    assert.equal(existsSync(join(lockRoot, 'slot-0')), false);
  });
  it('runs a targeted command with no wait while the slot is held', async () => {
    const held = await acquireSuiteSlot({ command: 'npm test', worktree: '/w/other', env: env() });
    assert.equal(held.kind, 'held');
    try {
      assert.deepEqual(await sweVerificationGate(completion(54), env({ TMB_VERIFICATION_TIMEOUT_S: String(VERIFICATION_MAX_S) })), ALLOWED);
      assert.deepEqual(runs(54), [{ exit_code: 0, timed_out: 0 }]);
    } finally {
      if (held.kind === 'held') held.release();
    }
  });
});
