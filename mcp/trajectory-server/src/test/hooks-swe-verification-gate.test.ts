/**
 * Unit tests of the TypeScript swe-verification-gate (GH 1692): its budget
 * parse, awk's seconds rounding, the toolchain PATH join, and the divergences
 * from the .sh that decision 703 allows: on a PATH holding neither jq nor the
 * sqlite3 CLI, where the .sh lets every completion through, the gate still
 * runs verification[], denies a failing command and records a passing run.
 * Then the suite-slot lock (GH 2092): concurrent gate runs of full suites
 * serialize outside the budget, a wait past the cap denies unrecorded, a
 * nested test-run shares the gate's slot and a targeted command never waits.
 * Last the changelog and stale-doc checks (GH 2866) on a linked worktree: one
 * deny and one allow per check, each deny recording no run, and neither the
 * reuse of a passing run, the waiver nor the preflight bypass skipping them.
 * Their paths come from the project's .config/tmb/doc-checks.json at HEAD: an
 * invalid file denies, an absent file or key skips with a note, and a temp
 * project with another layout (decision 3334) gets both checks from its own file.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BYPASS_ENV as PREFLIGHT_BYPASS_ENV } from '../hooks/code-reviewer-preflight.js';
import { DOC_CHECKS_FILE, DOC_CHECKS_SHAPE } from '../hooks/lib/doc-checks.js';
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
  it('allows a passing run and records it, noting the doc checks a project without doc-checks.json skips', async () => {
    const r = await sweVerificationGate(completion(30), env());
    assert.equal(r.code, 0);
    const out = decision(r.stdout);
    assert.equal(out.permissionDecision, undefined);
    assert.match(out.additionalContext ?? '', /^TMB: missing_changelog and stale_doc_ref skipped: no \.config\/tmb\/doc-checks\.json at /);
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
      mkdirSync(dirname(join(wt, DOC_CHECKS_FILE)), { recursive: true });
      writeFileSync(join(wt, DOC_CHECKS_FILE), readFileSync(join(PLUGIN_ROOT, DOC_CHECKS_FILE)));
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
      assert.match(out.permissionDecisionReason ?? '', /Allowed form: task_update_status\(status='completed', commit_sha, report\) again once that suite finishes$/);
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

describe('swe-verification-gate changelog and doc checks (GH 2866)', () => {
  const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
  const NOW = '2026-11-10T10:00:00.000Z';
  const TASK_ID = 3;
  const SLUG = '3-x';
  const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const BASE_FILES: Record<string, string> = {
    'README.md': 'See docs/guide.md.\n',
    'docs/guide.md': 'Run `scripts/old.sh` first.\n',
    'scripts/old.sh': 'echo old\n',
    'skills/s/SKILL.md': 'Call `keep_tool`.\n',
    'mcp/srv/src/tools/t.ts': "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n  {\n    name: 'old_tool',\n  },\n];\n",
    'changelog.d/README.md': 'One file per change.\n',
    'src/a.txt': 'one\ntwo\nthree\n',
    [DOC_CHECKS_FILE]: readFileSync(join(PLUGIN_ROOT, DOC_CHECKS_FILE), 'utf8'),
  };

  interface Fixture {
    checkout: string;
    worktree: string;
    db: string;
    env: NodeJS.ProcessEnv;
    git(...args: string[]): string;
    write(path: string, text: string): void;
    commit(message: string): string;
  }

  let sandbox: string;
  let seq = 0;
  before(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gate-doc-checks-')));
  });
  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** A checkout on dev holding <files>, the task's linked worktree on feat/3-x, and a running task 3 whose verification[] is `true`. */
  function fixture(files: Record<string, string> = BASE_FILES): Fixture {
    seq += 1;
    const root = join(sandbox, `case-${seq}`);
    const checkout = join(root, 'project/checkout');
    const worktree = join(checkout, '.claude/worktrees', SLUG);
    const db = join(root, 'project/.claude/tmb/trajectory.db');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(dirname(db), { recursive: true });
    for (const d of ['data', 'state', 'cache']) mkdirSync(join(root, 'mise', d), { recursive: true });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      CLAUDE_PROJECT_DIR: join(root, 'project'),
      TRAJECTORY_DB_PATH: db,
      MISE_DATA_DIR: join(root, 'mise/data'),
      MISE_STATE_DIR: join(root, 'mise/state'),
      MISE_CACHE_DIR: join(root, 'mise/cache'),
      ...GIT_ENV,
    };
    const gitIn = (dir: string, args: string[]) =>
      spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' });
    const git = (...args: string[]) => {
      const r = gitIn(worktree, args);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(worktree, path)), { recursive: true });
      writeFileSync(join(worktree, path), text);
    };
    const commit = (message: string) => {
      git('add', '-A');
      git('commit', '-qm', message);
      return git('rev-parse', 'HEAD');
    };
    assert.equal(gitIn(checkout, ['init', '-q', '-b', 'dev']).status, 0);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(checkout, path)), { recursive: true });
      writeFileSync(join(checkout, path), text);
    }
    writeFileSync(join(checkout, '.git/info/exclude'), '.claude/\n');
    assert.equal(gitIn(checkout, ['add', '-A']).status, 0);
    assert.equal(gitIn(checkout, ['commit', '-qm', 'base']).status, 0);
    assert.equal(gitIn(checkout, ['worktree', 'add', '-q', worktree, '-b', `feat/${SLUG}`]).status, 0);

    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.prepare("INSERT INTO repos (name, path, target_branch) VALUES ('checkout', ?, 'dev')").run(checkout);
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(NOW, NOW);
    d.prepare(
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, repo, verification, created_at, updated_at)
       VALUES (?, 9, ?, 'dev', 'd', 'running', 'checkout', '["true"]', ?, ?)`,
    ).run(TASK_ID, `feat/${SLUG}`, NOW, NOW);
    d.close();
    return { checkout, worktree, db, env, git, write, commit };
  }

  /** A feature commit that changes src/a.txt and adds its changelog fragment. */
  function featureCommit(f: Fixture): void {
    f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
    f.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
    f.commit('feature');
  }

  function runCount(f: Fixture): number {
    const d = new DatabaseSync(f.db, { readOnly: true });
    try {
      return (d.prepare('SELECT COUNT(*) AS n FROM verification_runs WHERE task_id = ?').get(TASK_ID) as { n: number }).n;
    } finally {
      d.close();
    }
  }

  function recordPassingRun(f: Fixture, sha: string): void {
    const d = new DatabaseSync(f.db);
    d.prepare(
      "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (?, ?, 'gate', ?, ?, 0, 600, 0)",
    ).run(TASK_ID, sha, NOW, NOW);
    d.close();
  }

  const close = (f: Fixture, extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = f.env) =>
    sweVerificationGate(
      JSON.stringify({ tool_name: 'mcp__plugin_tmb_trajectory-server__task_update_status', tool_input: { agent: 'swe', task_id: String(TASK_ID), status: 'completed', ...extra } }),
      env,
    );

  /** The typed {check, expected, actual} of a doc deny, after checking it names the retry fix. */
  async function denial(f: Fixture, extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = f.env): Promise<{ check: string; expected: string | null; actual: string | null }> {
    const r = await close(f, extra, env);
    assert.equal(r.code, 0);
    const out = decision(r.stdout);
    assert.equal(out.permissionDecision, 'deny');
    const { fix, ...failure } = JSON.parse(out.permissionDecisionReason ?? '') as { check: string; expected: string | null; actual: string | null; fix: { allowed?: string } };
    assert.match(fix.allowed ?? '', /task_update_status\(status='completed'/);
    return failure;
  }

  async function assertAllowed(f: Fixture): Promise<void> {
    assert.deepEqual(await close(f), ALLOWED);
  }

  it('allows a feature commit with its fragment and no stale reference, and records the run', async () => {
    const f = fixture();
    featureCommit(f);
    await assertAllowed(f);
    assert.equal(runCount(f), 1);
  });

  describe('stale_doc_ref', () => {
    it('denies a deleted path a docs/ file still names, before verification[] runs', async () => {
      const f = fixture();
      featureCommit(f);
      f.git('rm', '-q', 'scripts/old.sh');
      f.commit('drop old.sh');
      const d = await denial(f);
      assert.equal(d.check, 'stale_doc_ref');
      assert.match(d.actual ?? '', /docs\/guide\.md mentions removed path 'scripts\/old\.sh'/);
      assert.equal(runCount(f), 0);
    });

    it('denies a renamed path whose old name README.md still carries', async () => {
      const f = fixture();
      featureCommit(f);
      f.git('mv', 'docs/guide.md', 'docs/handbook.md');
      f.commit('rename guide');
      const d = await denial(f);
      assert.equal(d.check, 'stale_doc_ref');
      assert.match(d.actual ?? '', /README\.md mentions removed path 'docs\/guide\.md'/);
    });

    it('denies an MCP tool the diff removes that a skills/*/SKILL.md still mentions', async () => {
      const files = { ...BASE_FILES, 'skills/s/SKILL.md': 'Call `mcp__plugin_tmb_trajectory-server__old_tool` then `keep_tool`.\n' };
      const f = fixture(files);
      featureCommit(f);
      f.write('mcp/srv/src/tools/t.ts', "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n];\n");
      f.commit('drop old_tool');
      const d = await denial(f);
      assert.equal(d.check, 'stale_doc_ref');
      assert.match(d.actual ?? '', /skills\/s\/SKILL\.md mentions removed tool 'old_tool'/);
    });

    it('allows a deletion and a tool removal once the docs drop them', async () => {
      const f = fixture();
      featureCommit(f);
      f.git('rm', '-q', 'scripts/old.sh');
      f.write('docs/guide.md', 'Nothing to run first.\n');
      f.write('mcp/srv/src/tools/t.ts', "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n];\n");
      f.commit('drop old.sh and old_tool');
      await assertAllowed(f);
    });

    describe('a sibling of the doc named by its same-directory spelling (GH 2928)', () => {
      const siblingFixture = (other: string) =>
        fixture({ ...BASE_FILES, 'docs/x/README.md': 'Index.\n', 'docs/x/other.md': other });

      const dropReadme = (f: Fixture) => {
        featureCommit(f);
        f.git('rm', '-q', 'docs/x/README.md');
        f.commit('drop docs/x/README.md');
      };

      for (const prose of ['touched dirs whose README.md is stale\n', 'See ../README.md and sub/README.md.\n', '`README.md` and [README.md] in prose.\n']) {
        it(`allows the removal when other.md says ${JSON.stringify(prose.trim())}`, async () => {
          const f = siblingFixture(prose);
          dropReadme(f);
          await assertAllowed(f);
        });
      }

      for (const link of ['[index](README.md)', '[index](./README.md#top)', '[index](<README.md>)', '[index]: ./README.md', '[index]: README.md', 'see ./README.md', 'see docs/x/README.md']) {
        it(`denies the removal when other.md holds ${JSON.stringify(link)}`, async () => {
          const f = siblingFixture(`Start here.\n${link}\n`);
          dropReadme(f);
          const d = await denial(f);
          assert.equal(d.check, 'stale_doc_ref');
          assert.equal(d.actual, "docs/x/other.md mentions removed path 'docs/x/README.md'");
        });
      }

      it('denies when a doc in another directory names the full path', async () => {
        const f = siblingFixture('No index here.\n');
        f.write('docs/guide.md', 'Run `scripts/old.sh` first; the index is docs/x/README.md.\n');
        dropReadme(f);
        const d = await denial(f);
        assert.equal(d.check, 'stale_doc_ref');
        assert.equal(d.actual, "docs/guide.md mentions removed path 'docs/x/README.md'");
      });
    });

    describe('a path untracked as build output (GH 2054)', () => {
      const BUILT_FILES: Record<string, string> = {
        ...BASE_FILES,
        'docs/guide.md': 'Run `scripts/old.sh` first, then `node pkg/dist/out.js`.\n',
        'pkg/dist/out.js': 'built\n',
      };

      it('allows a path the diff drops from the index that the commit .gitignore ignores', async () => {
        const f = fixture(BUILT_FILES);
        featureCommit(f);
        f.write('pkg/.gitignore', 'dist/\n');
        f.git('rm', '-q', '--cached', 'pkg/dist/out.js');
        f.commit('untrack dist');
        assert.equal(f.git('ls-files', 'pkg/dist'), '');
        await assertAllowed(f);
      });

      it('still denies a plain deletion beside the untracked build output', async () => {
        const f = fixture(BUILT_FILES);
        featureCommit(f);
        f.write('pkg/.gitignore', 'dist/\n');
        f.git('rm', '-q', '--cached', 'pkg/dist/out.js');
        f.git('rm', '-q', 'scripts/old.sh');
        f.commit('untrack dist and drop old.sh');
        const d = await denial(f);
        assert.equal(d.check, 'stale_doc_ref');
        assert.equal(d.actual, "docs/guide.md mentions removed path 'scripts/old.sh'");
      });

      it('denies when only the local exclude file, not the commit, ignores the path', async () => {
        const f = fixture(BUILT_FILES);
        featureCommit(f);
        writeFileSync(join(f.checkout, '.git/info/exclude'), '.claude/\ndist/\n');
        f.git('rm', '-q', '--cached', 'pkg/dist/out.js');
        f.commit('untrack dist without a .gitignore');
        const d = await denial(f);
        assert.equal(d.check, 'stale_doc_ref');
        assert.match(d.actual ?? '', /docs\/guide\.md mentions removed path 'pkg\/dist\/out\.js'/);
      });

      it('counts the path as removed when git check-ignore fails (fail-closed)', async () => {
        const f = fixture(BUILT_FILES);
        featureCommit(f);
        f.write('pkg/.gitignore', 'dist/\n');
        f.git('rm', '-q', '--cached', 'pkg/dist/out.js');
        f.commit('untrack dist');
        const bin = join(dirname(dirname(f.checkout)), 'bin');
        mkdirSync(bin);
        const wrapper = join(bin, 'git');
        const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
        writeFileSync(
          wrapper,
          [
            '#!/usr/bin/env node',
            "const { spawnSync } = require('node:child_process');",
            "if (process.argv.includes('check-ignore')) process.exit(128);",
            `const r = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });`,
            'process.exit(r.status ?? 1);',
            '',
          ].join('\n'),
        );
        chmodSync(wrapper, 0o755);
        const d = await denial(f, {}, { ...f.env, PATH: `${bin}:${f.env.PATH}` });
        assert.equal(d.check, 'stale_doc_ref');
        assert.match(d.actual ?? '', /docs\/guide\.md mentions removed path 'pkg\/dist\/out\.js'/);
      });
    });
  });

  describe('missing_changelog', () => {
    it('denies a diff that adds no file under changelog.d/ and records no run', async () => {
      const f = fixture();
      f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
      f.commit('feature without fragment');
      const d = await denial(f);
      assert.equal(d.check, 'missing_changelog');
      assert.equal(d.actual, 'no file added under changelog.d/');
      assert.equal(runCount(f), 0);
    });

    it('allows a repo without changelog.d/ that adds no fragment', async () => {
      const files = { ...BASE_FILES };
      delete files['changelog.d/README.md'];
      const f = fixture(files);
      f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
      f.commit('feature');
      await assertAllowed(f);
    });
  });

  describe('no way around the doc checks', () => {
    function fragmentless(): Fixture {
      const f = fixture();
      f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
      f.commit('feature without fragment');
      return f;
    }

    it('runs them before reusing a passing run recorded for HEAD', async () => {
      const f = fragmentless();
      recordPassingRun(f, f.git('rev-parse', 'HEAD'));
      assert.equal((await denial(f)).check, 'missing_changelog');
      assert.equal(runCount(f), 1);
    });

    it('runs them under waive_verification_gate_reason, writing no waiver row', async () => {
      const f = fragmentless();
      assert.equal((await denial(f, { waive_verification_gate_reason: 'the suite needs a GPU this host lacks' })).check, 'missing_changelog');
      const d = new DatabaseSync(f.db, { readOnly: true });
      try {
        const n = (d.prepare("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'verification_gate_waived'").get() as { n: number }).n;
        assert.equal(n, 0);
      } finally {
        d.close();
      }
    });

    it('runs them under the code-reviewer preflight bypass', async () => {
      const f = fragmentless();
      assert.equal((await denial(f, {}, { ...f.env, [PREFLIGHT_BYPASS_ENV]: '1' })).check, 'missing_changelog');
    });

    it('runs them with an empty verification[] too', async () => {
      const f = fragmentless();
      const d = new DatabaseSync(f.db);
      d.prepare("UPDATE tasks SET verification = '[]' WHERE id = ?").run(TASK_ID);
      d.close();
      assert.equal((await denial(f)).check, 'missing_changelog');
    });

    it('denies an unprovable state: a HEAD with no merge base on the PR target', async () => {
      const f = fixture();
      f.git('checkout', '-q', '--orphan', 'feat/unrelated');
      f.git('rm', '-rq', '--cached', '.');
      f.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
      f.git('add', 'changelog.d/3-x.md');
      f.git('commit', '-qm', 'unrelated root');
      const d = await denial(f);
      assert.equal(d.check, 'stale_doc_ref');
      assert.equal(d.actual, 'no merge-base');
      assert.equal(runCount(f), 0);
    });
  });

  /** The additionalContext of an allow, after checking it is no deny. */
  async function allowNote(f: Fixture): Promise<string> {
    const r = await close(f);
    assert.equal(r.code, 0);
    const out = decision(r.stdout);
    assert.equal(out.permissionDecision, undefined, out.permissionDecisionReason);
    return out.additionalContext ?? '';
  }

  describe(`the project's ${DOC_CHECKS_FILE}`, () => {
    const withConfig = (config: string): Record<string, string> => ({ ...BASE_FILES, [DOC_CHECKS_FILE]: config });

    for (const [name, config, actual] of [
      ['not JSON', '{"version":1,', /not valid JSON/],
      ['an unknown key', '{"version":1,"doc_path":["docs/**/*.md"]}', /unknown key\(s\) doc_path/],
      ['another version', '{"version":2}', /version must be 1, got 2/],
      ['a changelog_dir outside the repo', '{"version":1,"changelog_dir":"../notes"}', /changelog_dir must be a repo-relative directory/],
      ['an empty doc_paths', '{"version":1,"doc_paths":[]}', /doc_paths must be a non-empty array/],
      ['a tool_name_pattern with no capture group', '{"version":1,"tool_name_pattern":"name: \\\\w+"}', /exactly one capture group, has 0/],
      ['a tool_name_pattern that does not compile', '{"version":1,"tool_name_pattern":"(a"}', /not a valid regex/],
    ] as const) {
      it(`denies ${name}, naming the file and its shape, and records no run`, async () => {
        const f = fixture(withConfig(config));
        featureCommit(f);
        const d = await denial(f);
        assert.equal(d.check, 'doc_checks_config');
        assert.ok(d.expected?.includes(DOC_CHECKS_FILE), d.expected ?? '');
        assert.ok(d.expected?.includes(DOC_CHECKS_SHAPE), d.expected ?? '');
        assert.match(d.actual ?? '', actual);
        assert.equal(runCount(f), 0);
      });
    }

    it('skips both checks with a note for each key a version-only file leaves out', async () => {
      const f = fixture(withConfig('{"version":1}'));
      f.git('rm', '-q', 'scripts/old.sh');
      f.commit('drop old.sh with no fragment');
      const note = await allowNote(f);
      assert.match(note, /missing_changelog skipped: \.config\/tmb\/doc-checks\.json sets no "changelog_dir"\./);
      assert.match(note, /stale_doc_ref skipped: \.config\/tmb\/doc-checks\.json sets no "doc_paths"\./);
      assert.equal(runCount(f), 1);
    });

    it('skips only the tool-name half when the tool keys are absent', async () => {
      const files = withConfig('{"version":1,"changelog_dir":"changelog.d","doc_paths":["skills/**/*.md"]}');
      files['skills/s/SKILL.md'] = 'Call `old_tool`.\n';
      const f = fixture(files);
      featureCommit(f);
      f.write('mcp/srv/src/tools/t.ts', "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n];\n");
      f.commit('drop old_tool');
      const note = await allowNote(f);
      assert.match(note, /stale_doc_ref's removed-tool-name half skipped: \.config\/tmb\/doc-checks\.json sets no "tool_sources" or "tool_name_pattern"\./);
      assert.doesNotMatch(note, /missing_changelog/);
    });

    it('adds the note to the allow that already carries context', async () => {
      const files = { ...BASE_FILES };
      delete files[DOC_CHECKS_FILE];
      const f = fixture(files);
      featureCommit(f);
      const d = new DatabaseSync(f.db);
      d.prepare("UPDATE tasks SET verification = '[]' WHERE id = ?").run(TASK_ID);
      d.close();
      const note = await allowNote(f);
      assert.match(note, /task has no typed verification\[\]/);
      assert.match(note, /missing_changelog and stale_doc_ref skipped: no \.config\/tmb\/doc-checks\.json at [0-9a-f]{40}/);
    });

    it('reads the file at HEAD, never from the working tree', async () => {
      const f = fixture();
      f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
      f.commit('feature without fragment');
      f.write(DOC_CHECKS_FILE, '{"version":1}');
      assert.equal((await denial(f)).check, 'missing_changelog');
    });
  });

  describe('a project that is not the plugin repo (decision 3334)', () => {
    const CONFIG = JSON.stringify({
      version: 1,
      changelog_dir: 'notes/changes/',
      doc_paths: ['documentation/**/*.md'],
      tool_sources: ['tools/*.py'],
      tool_name_pattern: '^def cmd_([a-z_]+)\\(',
    });
    const PROJECT_FILES: Record<string, string> = {
      'README.md': 'Start with documentation/setup.md, which runs scripts/legacy.sh.\n',
      'documentation/setup.md': 'Run `scripts/legacy.sh` once.\n',
      'documentation/commands/list.md': 'Commands: `keep_it`, `old_one`.\n',
      'scripts/legacy.sh': 'echo legacy\n',
      'tools/commands.py': 'def cmd_keep_it(args):\n    pass\n\ndef cmd_old_one(args):\n    pass\n',
      'notes/changes/README.md': 'One note per change.\n',
      'src/a.txt': 'one\ntwo\nthree\n',
      [DOC_CHECKS_FILE]: CONFIG,
    };

    function change(f: Fixture, withNote = true): void {
      f.write('src/a.txt', 'one\ntwo\nthree\nfour\n');
      if (withNote) f.write('notes/changes/3-x.md', '- x\n');
    }

    it('has no changelog.d/ and no docs/', () => {
      const f = fixture(PROJECT_FILES);
      assert.equal(f.git('ls-tree', '-d', '--name-only', 'HEAD', '--', 'changelog.d', 'docs'), '');
    });

    it('allows a change with its note under notes/changes/', async () => {
      const f = fixture(PROJECT_FILES);
      change(f);
      f.commit('feature');
      await assertAllowed(f);
      assert.equal(runCount(f), 1);
    });

    it('denies a change with no file under notes/changes/', async () => {
      const f = fixture(PROJECT_FILES);
      change(f, false);
      f.commit('feature without a note');
      const d = await denial(f);
      assert.equal(d.check, 'missing_changelog');
      assert.equal(d.actual, 'no file added under notes/changes/');
      assert.equal(runCount(f), 0);
    });

    it('denies a deleted path documentation/ still names, counting no README.md outside doc_paths', async () => {
      const f = fixture(PROJECT_FILES);
      change(f);
      f.git('rm', '-q', 'scripts/legacy.sh');
      f.commit('drop legacy.sh');
      const d = await denial(f);
      assert.equal(d.check, 'stale_doc_ref');
      assert.equal(d.actual, "documentation/setup.md mentions removed path 'scripts/legacy.sh'");

      f.write('documentation/setup.md', 'Nothing to run once.\n');
      f.commit('drop the setup step');
      await assertAllowed(f);
    });

    it('denies a command its tool_name_pattern no longer finds that documentation/ still names', async () => {
      const f = fixture(PROJECT_FILES);
      change(f);
      f.write('tools/commands.py', 'def cmd_keep_it(args):\n    pass\n');
      f.commit('drop old_one');
      const d = await denial(f);
      assert.equal(d.check, 'stale_doc_ref');
      assert.equal(d.actual, "documentation/commands/list.md mentions removed tool 'old_one'");
    });

    it('with no config file skips both checks with the note, and the close passes', async () => {
      const files = { ...PROJECT_FILES };
      delete files[DOC_CHECKS_FILE];
      const f = fixture(files);
      change(f, false);
      f.git('rm', '-q', 'scripts/legacy.sh');
      f.commit('drop legacy.sh with no note');
      const note = await allowNote(f);
      assert.ok(note.includes(`missing_changelog and stale_doc_ref skipped: no ${DOC_CHECKS_FILE} at `), note);
      assert.ok(note.includes(DOC_CHECKS_SHAPE), note);
      assert.equal(runCount(f), 1);
    });
  });
});
