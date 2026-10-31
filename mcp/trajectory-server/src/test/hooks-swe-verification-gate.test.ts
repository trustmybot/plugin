/**
 * Unit tests of the TypeScript swe-verification-gate (GH 1692): its budget
 * parse, awk's seconds rounding, the toolchain PATH join, and the divergences
 * from the .sh that decision 703 allows: on a PATH holding neither jq nor the
 * sqlite3 CLI, where the .sh lets every completion through, the gate still
 * runs verification[], denies a failing command and records a passing run.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findGate, gateNames } from '../hooks/registry.js';
import { commandOnPath } from '../hooks/lib/persona.js';
import { joinToolchainPath, msToS, parseBudget, sweVerificationGate, toolchainDirs, VERIFICATION_DEFAULT_S, VERIFICATION_MAX_S } from '../hooks/swe-verification-gate.js';
import { buildVerificationSandbox } from './hooks-swe-verification-parity.suite.js';

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
