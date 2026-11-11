/**
 * The swe-verification-gate l3 bash suite in node:test (GH 1692), part 2: the
 * run lock (one run per task and worktree HEAD), the lock-less path, the
 * verification_runs record, reuse within the hour, the budget sources, the
 * timeout and failure denies, an unresolvable HEAD (denied before any command,
 * GH 2866), and the trajectory-gates
 * chain (a call agent-arg-matches-caller denies never runs verification).
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PLUGIN_ROOT, type HookRun } from './hook-sandbox.js';
import { DENY, has, hasNot, sql } from './git-push-guard-l3.js';
import {
  addTask,
  gitCommit,
  gitWorktree,
  hook,
  hookAsync,
  lineCount,
  makeInput,
  makeWs,
  q,
  reasonOf,
  runHook,
  runsOf,
  unbornWorktree,
  type Ws,
} from './swe-verification-gate-l3.js';

describe('swe-verification-gate runs l3', () => {
  let w: Ws;
  const done = (task: number, sha = '') => makeInput('swe', 'completed', task, sha);

  before(() => {
    w = makeWs('swe-verification-gate-runs');
  });
  after(() => w.sb.remove());

  describe('run lock: one verification run per (task, worktree HEAD)', () => {
    let count: string;
    const sha: Record<string, string> = {};
    const lockGone = (task: number, slug: string) => !existsSync(join(w.lockRoot, `verify-${task}-${sha[slug]}`));

    before(() => {
      count = join(w.sb.dir, 'verify-runs.log');
      addTask(w.db, 60, 'lock-pass', [`echo run >> ${count}; sleep 2`]);
      addTask(w.db, 61, 'lock-fail', [`echo run >> ${count}.fail; sleep 2; echo boom; exit 3`]);
      addTask(w.db, 62, 'lock-stale', [`echo run >> ${count}.stale`]);
      addTask(w.db, 63, 'lock-unstamped', [`echo run >> ${count}.unstamped`]);
      for (const slug of ['lock-pass', 'lock-fail', 'lock-stale', 'lock-unstamped']) sha[slug] = gitWorktree(w, slug);
    });

    async function pair(task: number): Promise<[string, string]> {
      const a = hookAsync(w, done(task));
      await delay(500);
      const b = hookAsync(w, done(task));
      return [await a, await b];
    }

    it('run lock: concurrent passing invocations run verification[] once, both allow', async () => {
      const [a, b] = await pair(60);
      assert.equal(lineCount(count), 1, 'verification[] ran exactly once');
      hasNot(a, DENY, 'first invocation allows');
      hasNot(b, DENY, 'second invocation allows');
      has(a + b, 'verification reused run #', "the waiter reuses the holder's run");
      assert.ok(lockGone(60, 'lock-pass'), 'lock removed on exit');
      assert.equal(runsOf(w, 60), '1', 'one verification_runs row for the pair');
      const results = existsSync(w.lockRoot) ? findResults(w.lockRoot) : [];
      assert.deepEqual(results, [], 'no verdict file beside the lock');
    });

    it('run lock: after a failing run the waiter runs verification[] itself', async () => {
      const [c, d] = await pair(61);
      assert.equal(lineCount(`${count}.fail`), 2, 'a failing run is never reused');
      has(c, DENY, 'holder denies');
      has(d, DENY, 'waiter denies from its own run');
      has(d, 'boom', "waiter's deny carries the output tail");
      assert.equal(runsOf(w, 61), '2', 'two runs recorded');
      assert.ok(lockGone(61, 'lock-fail'), 'lock removed on exit');
    });

    it('run lock: a stale lock is reclaimed', () => {
      const lock = join(w.lockRoot, `verify-62-${sha['lock-stale']}`);
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'started'), '1000\n');
      hasNot(hook(w, done(62), { env: { TMB_VERIFICATION_TIMEOUT_S: '5' } }), DENY, 'reclaimed lock lets the run proceed');
      assert.equal(lineCount(`${count}.stale`), 1, 'verification[] ran after reclaiming');
      assert.ok(lockGone(62, 'lock-stale'), 'reclaimed lock removed');
    });

    it('run lock: a stale lock without a started stamp is reclaimed by mtime', () => {
      const lock = join(w.lockRoot, `verify-63-${sha['lock-unstamped']}`);
      mkdirSync(lock, { recursive: true });
      const y2000 = new Date('2000-01-01T00:00:00');
      utimesSync(lock, y2000, y2000);
      hasNot(hook(w, done(63), { env: { TMB_VERIFICATION_TIMEOUT_S: '5' } }), DENY, 'unstamped stale lock lets the run proceed');
      assert.equal(lineCount(`${count}.unstamped`), 1, 'verification[] ran after reclaiming the unstamped lock');
      assert.ok(lockGone(63, 'lock-unstamped'), 'unstamped lock removed');
    });
  });

  describe('lock-less path: the locks dir cannot be created', () => {
    before(() => {
      rmSync(w.lockRoot, { recursive: true, force: true });
      writeFileSync(w.lockRoot, '');
      mkdirSync(join(w.wtRoot, 'nolock-quiet'), { recursive: true });
      mkdirSync(join(w.wtRoot, 'nolock-loud'), { recursive: true });
      addTask(w.db, 70, 'nolock-quiet', ['echo quiet; exit 2']);
      addTask(w.db, 71, 'nolock-loud', ['for i in $(seq 1 20000); do echo FAIL line $i; done; exit 1']);
    });
    after(() => rmSync(w.lockRoot, { force: true }));

    it('no lock dir: a failing command with no failure line still denies', () => {
      const out = hook(w, done(70));
      has(out, DENY, 'lock-less failing verification should deny');
      has(out, 'quiet', 'deny carries the output tail');
      hasNot(out, 'Failure lines', 'no failure-lines section when nothing matched');
    });

    it('no lock dir: a failing command with 20000 failure lines denies with 15 shown', () => {
      const r = runHook(w, done(71));
      has(r.stdout + r.stderr, DENY, 'lock-less flood should deny');
      const reasonLines = reasonOf(r.stdout).split('\n');
      const start = reasonLines.findIndex((l) => l.startsWith('Failure lines'));
      const section: string[] = [];
      if (start >= 0) {
        for (const l of reasonLines.slice(start)) {
          if (l === '') break;
          section.push(l);
        }
      }
      assert.equal(section.filter((l) => l.startsWith('FAIL line')).length, 15, 'exactly 15 failure lines forwarded');
    });
  });

  describe('run record and reuse', () => {
    let mark: string;
    let recSha: string;
    const markLines = () => lineCount(mark);
    const cmdRows = "FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 80";

    before(() => {
      mark = join(w.sb.dir, 'rec-marker.log');
      addTask(w.db, 80, 'rec-pass', [`echo one >> ${mark}`, `sleep 1; echo two >> ${mark}`, `echo three >> ${mark}`]);
      recSha = gitWorktree(w, 'rec-pass');
    });

    it('run record: a passing run writes the row, one command row per command, and finishes it', () => {
      hasNot(hook(w, done(80, recSha.slice(0, 7))), DENY, 'passing run allows');
      assert.equal(runsOf(w, 80), '1', 'one run row');
      assert.equal(
        q(w.db, "SELECT commit_sha || '|' || source || '|' || exit_code || '|' || timed_out || '|' || budget_s || '|' || (finished_at IS NOT NULL AND finished_at >= started_at) FROM verification_runs WHERE task_id = 80;"),
        `${recSha}|gate|0|0|900|1`,
        'row: HEAD sha, gate, exit 0, not timed out, default budget, finished',
      );
      assert.equal(q(w.db, `SELECT COUNT(*) ${cmdRows};`), '3', 'three command rows');
      assert.equal(q(w.db, `SELECT group_concat(ordinal || '|' || exit_code, ';') FROM (SELECT c.ordinal, c.exit_code ${cmdRows} ORDER BY c.ordinal);`), '1|0;2|0;3|0', 'commands in order, each exit 0');
      assert.equal(q(w.db, `SELECT elapsed_s >= 0.9 ${cmdRows} AND c.ordinal = 2;`), '1', "the sleeping command's elapsed is recorded");
      assert.equal(q(w.db, `SELECT COUNT(*) ${cmdRows} AND c.elapsed_s IS NOT NULL;`), '3', 'every command carries elapsed_s');
    });

    it('reuse: a second close on the same HEAD within the hour allows without running verification[]', () => {
      const out = hook(w, done(80, recSha));
      hasNot(out, DENY, 'reuse allows');
      const run80 = q(w.db, 'SELECT id FROM verification_runs WHERE task_id = 80;');
      has(out, `verification reused run #${run80}`, 'additionalContext names the reused run');
      assert.equal(markLines(), 3, 'no command ran again');
      assert.equal(runsOf(w, 80), '1', 'no new run row');
    });

    it('reuse: refused when the worktree HEAD moved to a new commit', () => {
      const newSha = gitCommit(w, 'rec-pass', 'second');
      hasNot(hook(w, done(80)), 'verification reused', 'a new HEAD is verified afresh');
      assert.equal(markLines(), 6, 'the commands ran again');
      assert.equal(q(w.db, 'SELECT commit_sha FROM verification_runs WHERE task_id = 80 ORDER BY id DESC LIMIT 1;'), newSha, 'the new run records the new HEAD');
    });

    it('reuse: refused when tool_input.commit_sha names a commit other than the worktree HEAD', () => {
      hasNot(hook(w, done(80, recSha)), 'verification reused', 'commit_sha ≠ HEAD is verified afresh');
      assert.equal(markLines(), 9, 'the commands ran again');
    });

    it('reuse: refused for a passing run that finished more than an hour ago', () => {
      sql(w.db, "UPDATE verification_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-61 minutes') WHERE task_id = 80");
      hasNot(hook(w, done(80)), 'verification reused', 'an old run is not reused');
      assert.equal(markLines(), 12, 'the commands ran again');
    });

    it('reuse: refused after verification[] changes on the same HEAD (GH 1672)', () => {
      has(hook(w, done(80)), 'verification reused', 'the fresh run of the unchanged verification[] is reused');
      assert.equal(markLines(), 12, 'nothing ran');
      const amended = [`echo one >> ${mark}`, `sleep 1; echo two >> ${mark}`, `echo three >> ${mark}`, `echo four >> ${mark}`];
      sql(w.db, 'UPDATE tasks SET verification = ? WHERE id = 80', JSON.stringify(amended));
      let out = hook(w, done(80));
      hasNot(out, 'verification reused', 'a run of the earlier verification[] is not reused');
      hasNot(out, DENY, 'the amended verification[] passes');
      assert.equal(markLines(), 16, 'the amended commands ran');
      assert.equal(
        q(w.db, 'SELECT COUNT(*) FROM verification_run_commands WHERE run_id = (SELECT MAX(id) FROM verification_runs WHERE task_id = 80);'),
        '4',
        'the new run records four commands',
      );
      out = hook(w, done(80));
      has(out, 'verification reused', 'the run of the amended verification[] is reused');
      assert.equal(markLines(), 16, 'nothing ran again');
    });
  });

  it('failure deny: names the failing command, its exit, elapsed and cumulative time; the run records it', () => {
    addTask(w.db, 81, 'rec-fail', ['echo fine', 'echo FAIL step.test.sh; exit 4', 'echo never']);
    gitWorktree(w, 'rec-fail');
    const reason = reasonOf(runHook(w, done(81)).stdout);
    has(reason, 'Failing command (2/3): echo FAIL step.test.sh; exit 4', 'deny names the failing command and its position');
    has(reason, 'Exit 4 after ', 'deny carries the exit code and elapsed');
    has(reason, 's cumulative', 'deny carries the cumulative time');
    has(reason, 'FAIL step.test.sh', 'deny forwards the FAIL line');
    assert.equal(
      q(w.db, "SELECT r.exit_code || '|' || r.timed_out || '|' || (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) FROM verification_runs r WHERE r.task_id = 81;"),
      '4|0|2',
      'run exit 4, two command rows (the third never ran)',
    );
    has(
      q(w.db, 'SELECT output_tail FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 81 AND c.ordinal = 2;'),
      'FAIL step.test.sh',
      'the command row keeps the output tail',
    );
  });

  describe('budget: plugin_config, env override, cap', () => {
    const budgetOfLast = () => q(w.db, "SELECT budget_s || '|' || timed_out FROM verification_runs WHERE task_id = 82 ORDER BY id DESC LIMIT 1;");
    before(() => {
      addTask(w.db, 82, 'budget', ['sleep 3']);
      gitWorktree(w, 'budget');
    });
    after(() => sql(w.db, "DELETE FROM plugin_config WHERE key IN ('verification_timeout_s')"));

    it('budget: plugin_config.verification_timeout_s is honoured', () => {
      sql(w.db, "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('verification_timeout_s', '1')");
      const r = runHook(w, done(82));
      has(r.stdout + r.stderr, DENY, 'a 1 s budget from plugin_config times out a 3 s command');
      has(reasonOf(r.stdout), 'the 1s budget ran out', 'deny names the configured budget');
      assert.equal(budgetOfLast(), '1|1', 'run records budget_s 1 and timed_out');
    });

    it('budget: TMB_VERIFICATION_TIMEOUT_S overrides plugin_config', () => {
      gitCommit(w, 'budget', 'env budget');
      hasNot(hook(w, done(82), { env: { TMB_VERIFICATION_TIMEOUT_S: '30' } }), DENY, 'the env budget lets the command finish');
      assert.equal(budgetOfLast(), '30|0', 'run records the env budget');
    });

    it('budget: a configured budget above the cap is capped at 1800 s', () => {
      sql(w.db, "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('verification_timeout_s', '99999')");
      gitCommit(w, 'budget', 'capped budget');
      hasNot(hook(w, done(82)), DENY, 'capped budget still runs');
      assert.equal(budgetOfLast(), '1800|0', 'run records the capped budget');
    });
  });

  it('timeout: the run is marked timed_out and the deny names the running command and the cumulative time', () => {
    addTask(w.db, 83, 'rec-slow', ['echo quick', 'sleep 5', 'echo never']);
    gitWorktree(w, 'rec-slow');
    const reason = reasonOf(runHook(w, done(83), { env: { TMB_VERIFICATION_TIMEOUT_S: '2' } }).stdout);
    has(reason, 'timed out', 'deny says timed out');
    has(reason, 'while running command 2/3', "deny names the command's position");
    has(reason, 'sleep 5', 'deny names the running command');
    has(reason, 's in,', 'deny carries the cumulative time');
    assert.equal(
      q(w.db, "SELECT r.exit_code || '|' || r.timed_out || '|' || (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) FROM verification_runs r WHERE r.task_id = 83;"),
      '124|1|2',
      'run exit 124, timed_out, the cut-off command recorded',
    );
    assert.equal(
      q(w.db, 'SELECT c.exit_code FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 83 AND c.ordinal = 2;'),
      '124',
      'the cut-off command row carries exit 124',
    );
  });

  describe('HEAD unresolvable: the doc checks cannot be proven, so the close denies before verification[] (GH 2866)', () => {
    let nohead: string;
    before(() => {
      nohead = join(w.sb.dir, 'nohead.log');
      addTask(w.db, 90, 'no-head', [`echo ran >> ${nohead}`]);
      unbornWorktree(w, 'no-head');
    });

    it('HEAD unresolvable: denies naming the unresolvable HEAD, verification[] never runs, no run row', () => {
      const reason = reasonOf(runHook(w, done(90)).stdout);
      has(reason, '"check":"stale_doc_ref"', 'deny carries the doc check');
      has(reason, 'git rev-parse HEAD failed', 'deny says HEAD does not resolve');
      assert.equal(lineCount(nohead), 0, 'verification[] did not run');
      assert.equal(runsOf(w, 90), '0', 'no run row');
    });

    it('HEAD unresolvable: a waiver does not skip the doc checks', () => {
      const waived = makeInput('swe', 'completed', 90, '', { waive_verification_gate_reason: 'slow environment, waived for this close' });
      const reason = reasonOf(runHook(w, waived).stdout);
      has(reason, '"check":"stale_doc_ref"', 'the waiver still denies on the doc checks');
      assert.equal(lineCount(nohead), 0, 'verification[] did not run');
    });
  });

  it('own exit 124: recorded as exit 124 with timed_out 0, the deny names a failing command', () => {
    addTask(w.db, 91, 'own-124', ['echo own-124; exit 124']);
    gitWorktree(w, 'own-124');
    const reason = reasonOf(runHook(w, done(91)).stdout);
    has(reason, 'verification failed', 'deny says verification failed');
    has(reason, 'Failing command (1/1): echo own-124; exit 124', 'deny names the failing command');
    hasNot(reason, 'timed out', 'deny does not call it a timeout');
    assert.equal(q(w.db, "SELECT exit_code || '|' || timed_out FROM verification_runs WHERE task_id = 91;"), '124|0', 'run exit 124, not timed out');
    assert.equal(
      q(w.db, 'SELECT c.exit_code FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 91;'),
      '124',
      'command row exit 124',
    );
  });

  it('finish write fails (DB read-only after start): allow stands, stderr says unfinished, row unfinished', () => {
    addTask(w.db, 92, 'ro-finish', [`chmod 444 ${w.db}`]);
    gitWorktree(w, 'ro-finish');
    let r: HookRun;
    try {
      r = runHook(w, done(92));
    } finally {
      chmodSync(w.db, 0o644);
    }
    hasNot(r.stdout, DENY, 'the passing verification still allows');
    has(r.stderr, 'record unfinished', 'stderr says the record is unfinished');
    has(r.stderr, 'failed 3 times', 'stderr says the finish write was tried 3 times');
    assert.equal(q(w.db, 'SELECT COUNT(*) FROM verification_runs WHERE task_id = 92 AND finished_at IS NULL;'), '1', 'the run row stays unfinished');
  });

  // Command 1 holds the DB write lock for 4 s, so its command-row write waits
  // out its 3 s record budget; command 2 then needs 2 s of a 4 s budget.
  // Counting the write against the budget would leave 1 s and time command 2 out.
  it('slow record write: the command budget excludes the time spent writing the record', () => {
    addTask(w.db, 93, 'slow-record', [`( { echo "BEGIN IMMEDIATE;"; sleep 4; echo "COMMIT;"; } | sqlite3 ${w.db} ) >/dev/null 2>&1 & sleep 0.5`, 'sleep 2']);
    gitWorktree(w, 'slow-record');
    const r = runHook(w, done(93), { env: { TMB_VERIFICATION_TIMEOUT_S: '4' } });
    hasNot(r.stdout, DENY, 'command 2 finishes inside the budget');
    has(r.stderr, 'tmb_db_write', 'the command-row write did wait on the held lock');
    assert.equal(q(w.db, "SELECT exit_code || '|' || timed_out FROM verification_runs WHERE task_id = 93;"), '0|0', 'run finished exit 0, not timed out');
  });

  it("chain: main-loop task_update_status(agent='swe') is denied and records no verification run", () => {
    addTask(w.db, 95, 'chain-close', ['echo ok']);
    gitWorktree(w, 'chain-close');
    const chainIn = JSON.stringify({ ...JSON.parse(done(95)), hook_event_name: 'PreToolUse', session_id: 'main-1', tool_use_id: 'tu-chain-1' });
    const routed = runHook(w, chainIn, { gate: 'PreToolUse', env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } }).stdout;
    has(routed, DENY, 'denied');
    has(reasonOf(routed), "call with agent='bro'", 'by agent-arg-matches-caller');
    assert.equal(runsOf(w, 95), '0', 'no verification run recorded');
    hook(w, chainIn);
    assert.equal(runsOf(w, 95), '1', 'the gate alone would have recorded one');
  });
});

function findResults(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.result')) out.push(p);
    }
  };
  walk(dir);
  return out;
}
