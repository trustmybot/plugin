/**
 * The swe-verification-gate l3 bash suite in node:test (GH 1692), part 1: the
 * caller and status filters, waivers, budget fallback, worktree resolution,
 * the minimal-PATH toolchain and the unreadable or WAL DB. The PreToolUse gate
 * on task_update_status(agent=swe, status=completed) runs the typed
 * verification[] in the task worktree, records the run, and denies on a
 * non-zero exit or a spent budget (Typed Rails #673).
 */
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { PLUGIN_ROOT } from './hook-sandbox.js';
import { DENY, git, has, hasNot } from './git-push-guard-l3.js';
import { walGateCases } from './wal-gate-cases.js';
import {
  GATE,
  TOOL_NAME,
  addTask,
  gateEnvOf,
  gitCommit,
  gitWorktree,
  hasDenyReasonKey,
  hook,
  makeInput,
  makeWs,
  q,
  reasonOf,
  runHook,
  type Ws,
} from './swe-verification-gate-l3.js';

/** <cmd>'s path on the test's PATH, '' when absent (a `command -v`). */
function which(cmd: string): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return join(dir, cmd);
    } catch {
      /* not in this dir */
    }
  }
  return '';
}

const TOOL = ['node', 'npm', 'shellcheck'].find((c) => which(c) !== '') ?? '';
const REAL_HOME = process.env.TMB_TEST_REAL_HOME || process.env.HOME || homedir();
const TOOLCHAIN_MISE_DATA = process.env.MISE_DATA_DIR || join(REAL_HOME, '.local/share/mise');
const MINIMAL_DEPS = 'bash sh jq sqlite3 git timeout gtimeout perl date dirname basename tail head sort tr cat sed awk grep mktemp rm mkdir env cut wc tee sleep uname id ls readlink stat touch chmod mv cp ps od shasum xargs find'.split(' ');

describe('swe-verification-gate l3', () => {
  let w: Ws;
  const waive = (task: string, reason: string) =>
    JSON.stringify({ tool_name: TOOL_NAME, tool_input: { agent: 'swe', status: 'completed', task_id: task, waive_verification_gate_reason: reason } });

  before(() => {
    w = makeWs('swe-verification-gate');
  });
  after(() => w.sb.remove());

  it('non-SWE caller (bro) completing task: allowed', () => {
    hasNot(hook(w, makeInput('bro', 'completed', 1), { cwd: w.ws }), DENY, 'bro completing should not be gated');
  });

  it('SWE setting status=running: allowed (not completing)', () => {
    hasNot(hook(w, makeInput('swe', 'running', 1), { cwd: w.ws }), DENY, 'status=running should not trigger gate');
  });

  it('SWE setting status=failed: allowed', () => {
    hasNot(hook(w, makeInput('swe', 'failed', 1), { cwd: w.ws }), DENY, 'status=failed should not trigger gate');
  });

  it('SWE completing task with empty typed verification[]: allowed with advisory', () => {
    const out = hook(w, makeInput('swe', 'completed', 2), { cwd: w.ws });
    hasNot(out, DENY, 'empty verification[] should allow');
    has(out, 'additionalContext', 'should emit advisory additionalContext');
    has(out, 'no typed verification', 'advisory should mention missing typed field');
  });

  it('SWE completing task with passing verification: allowed', () => {
    hasNot(hook(w, makeInput('swe', 'completed', 1)), DENY, 'passing verification should allow');
  });

  it('SWE completing task with failing verification command: DENIED', () => {
    const out = hook(w, makeInput('swe', 'completed', 3));
    has(out, DENY, 'failing verification should deny');
    has(out, 'verification failed', 'deny reason should say verification failed');
  });

  it('failing verification: deny uses permissionDecisionReason with a non-empty value, no denyReason', () => {
    const r = runHook(w, makeInput('swe', 'completed', 3));
    has(reasonOf(r.stdout), 'verification failed', 'deny must carry a non-empty permissionDecisionReason');
    assert.equal(hasDenyReasonKey(r.stdout), false, 'deny must not carry a denyReason key');
  });

  it('failing verification: deny reason names the failing file from FAIL lines beyond the tail', () => {
    mkdirSync(join(w.wtRoot, 'l3-fail'), { recursive: true });
    addTask(w.db, 5, 'l3-fail', ['echo FAIL x.test.sh; for i in $(seq 1 40); do echo filler $i; done; exit 1']);
    const reason = reasonOf(runHook(w, makeInput('swe', 'completed', 5)).stdout);
    has(reason, 'FAIL x.test.sh', 'deny reason should forward the FAIL line');
    has(reason, 'Failure lines', 'deny reason should label the forwarded failure lines');
    has(reason, 'filler 40', 'deny reason should still carry the output tail');
  });

  it('SWE completing task with multi-command verification (all pass): allowed', () => {
    hasNot(hook(w, makeInput('swe', 'completed', 4)), DENY, 'multi-command all-pass should allow');
  });

  it('SWE completing with valid waiver (>=10 chars): allowed', () => {
    hasNot(hook(w, waive('3', 'emergency hotfix, tests not applicable here'), { cwd: w.ws }), DENY, 'valid waiver should allow');
    assert.equal(q(w.db, "SELECT COUNT(*) FROM audit WHERE event_type='verification_gate_waived';"), '1', 'waiver should write audit row');
  });

  it('SWE completing with short waiver (<10 chars): not treated as waiver', () => {
    has(hook(w, waive('3', 'short')), DENY, 'short waiver should not bypass verification');
  });

  it('No DB: gate allows silently', () => {
    const out = hook(w, '{"tool_input":{"agent":"swe","status":"completed","task_id":"1"}}', {
      cwd: w.ws,
      env: { TRAJECTORY_DB_PATH: join(w.sb.dir, 'nonexistent.db') },
    });
    hasNot(out, DENY, 'no DB should allow');
  });

  describe('budget floor: 0 or a non-integer falls back to the default', () => {
    before(() => {
      addTask(w.db, 99, 'zero-budget', ['sleep 1; echo done']);
      gitWorktree(w, 'zero-budget');
    });
    const lastBudget = () => q(w.db, "SELECT budget_s || '|' || timed_out FROM verification_runs WHERE task_id = 99 ORDER BY id DESC LIMIT 1;");

    it('budget 0: falls back to the default 900 s with a warning naming the value', () => {
      const r = runHook(w, makeInput('swe', 'completed', 99), { env: { TMB_VERIFICATION_TIMEOUT_S: '0' } });
      hasNot(r.stdout, DENY, 'a 0 budget does not time the command out');
      has(r.stderr, "verification_timeout_s '0' is not an integer from 1 to 1800; using the default 900s", 'stderr warns naming the bad value');
      assert.equal(lastBudget(), '900|0', 'run records the default budget');
    });

    it('budget non-integer: falls back to the default with a warning naming the value', () => {
      gitCommit(w, 'zero-budget', 'abc');
      const r = runHook(w, makeInput('swe', 'completed', 99), { env: { TMB_VERIFICATION_TIMEOUT_S: 'abc' } });
      hasNot(r.stdout, DENY, 'a non-integer budget does not deny');
      has(r.stderr, "verification_timeout_s 'abc'", 'stderr warns naming the bad value');
      assert.equal(lastBudget(), '900|0', 'run records the default budget');
    });
  });

  it('timeout path: deny uses permissionDecisionReason mentioning the timeout, no denyReason', () => {
    addTask(w.db, 98, 'slow-mid', ['sleep 5']);
    mkdirSync(join(w.wtRoot, 'slow-mid'), { recursive: true });
    const r = runHook(w, makeInput('swe', 'completed', 98), { env: { TMB_VERIFICATION_TIMEOUT_S: '1' } });
    has(r.stdout + r.stderr, DENY, 'mid-command timeout should deny');
    has(reasonOf(r.stdout), 'timed out', 'timeout deny must carry permissionDecisionReason mentioning the timeout');
    assert.equal(hasDenyReasonKey(r.stdout), false, 'timeout deny must not carry a denyReason key');
  });

  it("Injection: task_id='1; DROP TABLE tasks;--' treated as missing (no SQL error, no row)", () => {
    const auditBefore = q(w.db, 'SELECT COUNT(*) FROM audit;');
    const out = hook(w, waive('1; DROP TABLE tasks;--', 'waiver text long enough'), { cwd: w.ws });
    hasNot(out, DENY, 'injected task_id should be treated as missing (allow)');
    hasNot(out, 'Error', 'injected task_id should not surface a SQL error');
    assert.equal(q(w.db, "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks';"), 'tasks', 'tasks table must survive injection attempt');
    assert.equal(q(w.db, 'SELECT COUNT(*) FROM audit;'), auditBefore, 'no audit row should be written for injected task_id');
  });

  it('Waiver reason containing single quotes: allowed, audit row intact', () => {
    hasNot(hook(w, waive('4', "tests can't run here — it's a doc-only change"), { cwd: w.ws }), DENY, 'quoted waiver should allow');
    const row = q(w.db, "SELECT content_json FROM audit WHERE event_type='verification_gate_waived' ORDER BY id DESC LIMIT 1;");
    has(row, "it's a doc-only change", 'stored content_json should retain single quotes');
    const extracted = q(w.db, "SELECT json_extract(content_json, '$.waiver_reason') FROM audit WHERE event_type='verification_gate_waived' ORDER BY id DESC LIMIT 1;");
    has(extracted, "can't run here", 'content_json should be valid JSON (json_extract works)');
  });

  it('Two waiver invocations for the same (task, sha) write one verification_gate_waived row', () => {
    addTask(w.db, 50, 'waive-twice', ['exit 1'], { status: 'running', commitSha: 'aaa1111' });
    mkdirSync(join(w.wtRoot, 'waive-twice'), { recursive: true });
    const waiveInput = (sha: string) =>
      makeInput('swe', 'completed', 50, sha, { waive_verification_gate_reason: 'doc-only change, nothing to run' });
    const waivedRows = (sha: string) =>
      q(
        w.db,
        "SELECT COUNT(*) FROM audit WHERE event_type='verification_gate_waived' AND json_extract(content_json, '$.task_id') = 50 AND json_extract(content_json, '$.commit_sha') = ?",
        sha,
      );
    const out12 = hook(w, waiveInput(''), { cwd: w.ws }) + hook(w, waiveInput(''), { cwd: w.ws });
    hasNot(out12, DENY, 'both waiver invocations allow');
    assert.equal(waivedRows('aaa1111'), '1', 'same (task, task commit_sha) twice → one row');
    const out34 = hook(w, waiveInput('bbb2222'), { cwd: w.ws }) + hook(w, waiveInput('bbb2222'), { cwd: w.ws });
    hasNot(out34, DENY, 'waiver with an explicit commit_sha allows');
    assert.equal(waivedRows('bbb2222'), '1', 'same (task, tool_input commit_sha) twice → one row');
    assert.equal(waivedRows('aaa1111'), '1', "the earlier commit's row is untouched");
  });

  it('a waiver on a task whose worktree is missing denies: the doc checks cannot run (GH 2866)', () => {
    addTask(w.db, 51, 'waive-no-worktree', ['exit 1']);
    const auditBefore = q(w.db, "SELECT COUNT(*) FROM audit WHERE event_type='verification_gate_waived';");
    const out = hook(w, waive('51', 'doc-only change, nothing to run'), { cwd: w.ws });
    has(out, DENY, 'missing worktree denies despite the waiver');
    has(out, 'changelog and doc checks', 'the deny names the doc checks');
    assert.equal(q(w.db, "SELECT COUNT(*) FROM audit WHERE event_type='verification_gate_waived';"), auditBefore, 'no waiver row');
  });

  it('multi-command typed verification[]: all pass → allowed', () => {
    addTask(w.db, 10, 'typed-pass', ['echo typed-ok', 'exit 0']);
    mkdirSync(join(w.wtRoot, 'typed-pass'), { recursive: true });
    hasNot(hook(w, makeInput('swe', 'completed', 10)), DENY, 'typed multi-command all-pass should allow');
  });

  it('typed verification[]: failing command → DENIED', () => {
    addTask(w.db, 11, 'typed-fail', ['exit 1']);
    mkdirSync(join(w.wtRoot, 'typed-fail'), { recursive: true });
    const out = hook(w, makeInput('swe', 'completed', 11));
    has(out, DENY, 'typed failing cmd should deny');
    has(out, 'verification failed', 'deny reason should say verification failed');
  });

  it('typed verification[]: command with pipes/redirects runs verbatim → allowed', () => {
    addTask(w.db, 12, 'typed-shell', ['echo a | grep a']);
    mkdirSync(join(w.wtRoot, 'typed-shell'), { recursive: true });
    hasNot(hook(w, makeInput('swe', 'completed', 12)), DENY, 'shell-metachar command should run and pass');
  });

  it('repo-subdir layout: gate resolves worktree under the repo root and runs', () => {
    addTask(w.db, 20, 'repo-subdir', ['echo repo-subdir-ok']);
    mkdirSync(join(w.wtRoot, 'repo-subdir'), { recursive: true });
    // A decoy at the workspace root: a workspace-rooted resolver would pick it up.
    mkdirSync(join(w.ws, '.claude/worktrees/repo-subdir'), { recursive: true });
    const out = hook(w, makeInput('swe', 'completed', 20));
    hasNot(out, 'verification gate skipped', 'repo-subdir gate must not skip');
    hasNot(out, DENY, 'repo-subdir passing cmd should allow');
  });

  describe('minimal hook PATH: a toolchain (mise/homebrew) tool resolves (#673)', { skip: TOOL === '' ? 'no node, npm or shellcheck on PATH' : false }, () => {
    let minimal: string;
    const minPathHook = (input: string) =>
      hook(w, input, { env: { MISE_DATA_DIR: TOOLCHAIN_MISE_DATA, PATH: minimal, HOME: REAL_HOME } });

    before(() => {
      minimal = join(w.sb.dir, 'minimal-path-bin');
      mkdirSync(minimal, { recursive: true });
      for (const dep of MINIMAL_DEPS) {
        const p = which(dep);
        if (p !== '' && !existsSync(join(minimal, dep))) symlinkSync(p, join(minimal, dep));
      }
    });

    it(`minimal PATH: chosen toolchain tool (${TOOL}) is unresolvable before gate resolution`, () => {
      assert.equal(existsSync(join(minimal, TOOL)), false, `${TOOL} must be off the minimal PATH (${minimal}) for this test to be meaningful`);
    });

    it('minimal PATH: passing verification using mise/homebrew tool resolves and ALLOWS (#673)', () => {
      addTask(w.db, 30, 'toolchain-pass', [`${TOOL} --version`]);
      mkdirSync(join(w.wtRoot, 'toolchain-pass'), { recursive: true });
      hasNot(minPathHook(makeInput('swe', 'completed', 30)), DENY, 'toolchain tool should resolve and pass (no false 127 DENY)');
    });

    it('minimal PATH: failing verification using mise/homebrew tool resolves and DENIES (#673)', () => {
      addTask(w.db, 31, 'toolchain-fail', [`${TOOL} --no-such-flag-xyz; exit 1`]);
      mkdirSync(join(w.wtRoot, 'toolchain-fail'), { recursive: true });
      const out = minPathHook(makeInput('swe', 'completed', 31));
      has(out, DENY, 'genuinely failing toolchain command should still DENY');
      has(out, 'verification failed', 'deny reason should say verification failed');
    });
  });

  it('no worktree + non-empty verification[]: fail CLOSED with a named reason (deny)', () => {
    addTask(w.db, 40, 'no-worktree', ['echo should-not-run']);
    const active = git(w.sb.env, PLUGIN_ROOT, 'rev-parse', '--show-toplevel');
    const out = hook(w, makeInput('swe', 'completed', 40), { cwd: active });
    hasNot(out, 'verification gate skipped', 'no-worktree gate must not emit the silent-skip note');
    has(out, DENY, 'unlocatable worktree must DENY (fail closed)');
    has(out, 'could not locate the task worktree', 'deny reason should name the missing-worktree remediation');
    has(out, '.claude/worktrees/no-worktree', 'deny reason should name the expected repo-rooted worktree path');
  });

  it('unreadable trajectory DB: verification gate fails closed (tmb_gate_read __ERR__)', () => {
    const bad = join(w.sb.dir, 'corrupt-trajectory.db');
    writeFileSync(bad, 'not a sqlite database '.repeat(8));
    const out = hook(w, makeInput('swe', 'completed', 1), { env: { TRAJECTORY_DB_PATH: bad } });
    has(out, DENY, 'DB read error must deny, not skip the gate');
    has(out, 'trajectory DB unavailable', 'deny names the unavailable DB');
  });

  describe('WAL DB', () => {
    let walWs: string;
    let walDb: string;
    before(() => {
      walWs = join(w.sb.dir, 'wal-ws');
      walDb = join(walWs, '.claude/tmb/trajectory.db');
      mkdirSync(join(walWs, '.claude/tmb'), { recursive: true });
      const d = new DatabaseSync(w.db);
      try {
        d.prepare('VACUUM INTO ?').run(walDb);
      } finally {
        d.close();
      }
    });

    // Task 3's verification[] fails: an empty verification[] read would print
    // the "no typed verification" skip instead of the deny.
    walGateCases({
      label: GATE,
      gate: GATE,
      get db() {
        return walDb;
      },
      get proj() {
        return walWs;
      },
      input: makeInput('swe', 'completed', 3),
      expect: 'verification failed',
      forbid: 'no typed verification',
      get cwd() {
        return w.repo;
      },
      env: () => gateEnvOf(w, w.repo),
      work: () => join(w.sb.dir, 'wal-work'),
    });
  });
});
