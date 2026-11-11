/**
 * The swe-atomic-close l3 bash suite in node:test (GH 1692), part 1: one repo
 * with a bare origin and two attached task worktrees. The gate runs as
 * `node dist/hooks.js swe-atomic-close` from the repo, CLAUDE_PROJECT_DIR
 * pinned to the sandbox and PWD set. It binds the task named by task_id=<N> in
 * the spawn transcript (any status), auto-completes a pending task whose
 * worktree has commits and a passing verification run at HEAD, otherwise
 * leaves it pending with a gate_pending audit row (GH 2866), warns bro when
 * the worktree has no commits, and records metrics only
 * for any other status; a spawn with no resolvable task id writes an
 * agent_runs_capture_skipped audit row and touches no task.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, type Sandbox } from './hook-sandbox.js';
import { git, has, hasNot } from './git-push-guard-l3.js';
import { commitIn, execDb, gatePendingCount, hook, newMinDb, NO_COMMITS, q, recordRun, skippedCount, spawnInput, spawnTranscript, writeTranscript } from './swe-atomic-close-l3.js';

describe('swe-atomic-close l3: one repo', () => {
  let sb: Sandbox;
  let repo: string;
  let db: string;
  let wt: string;
  let wtNv: string;

  const run = (payload: object) => hook(sb, repo, db, payload);
  const sweInput = (task = 42) => spawnInput(sb.dir, task);
  const nonSweInput = { subagent_type: 'architect' };
  const status = (task: number) => q(db, 'SELECT status FROM tasks WHERE id=?', task);
  const runs = (task: number) => Number(q(db, 'SELECT COUNT(*) FROM agent_runs WHERE task_id=?', task));
  const resetPending = () =>
    execDb(db, "UPDATE tasks SET status='pending', commit_sha=NULL, completed_at=NULL, updated_at=datetime('now', '+60 seconds') WHERE id=42;");

  before(() => {
    sb = makeSandbox('swe-atomic-close');
    const remote = join(sb.dir, 'remote.git');
    git(sb.env, sb.dir, 'init', '-q', '--bare', remote);
    repo = join(sb.dir, 'repo');
    git(sb.env, sb.dir, 'init', '-q', '-b', 'dev', repo);
    git(sb.env, repo, 'config', 'user.email', 't@t.io');
    git(sb.env, repo, 'config', 'user.name', 't');
    git(sb.env, repo, 'remote', 'add', 'origin', remote);
    writeFileSync(join(repo, 'README.md'), 'init\n');
    git(sb.env, repo, 'add', '.');
    git(sb.env, repo, 'commit', '-qm', 'init');
    git(sb.env, repo, 'push', '-q', 'origin', 'dev');

    db = newMinDb(repo);
    execDb(
      db,
      `INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (42, 'fix/test-branch', 'dev', 'pending', datetime('now', '+10 seconds'));
       INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (43, 'fix/other-branch', 'dev', 'completed', datetime('now'));
       INSERT INTO tasks (id, branch_id, parent_branch_id, status, updated_at) VALUES (44, 'fix/nv-branch', 'dev', 'needs_validation', datetime('now'));`,
    );

    wt = join(repo, '.claude/worktrees/test-branch');
    git(sb.env, repo, 'branch', 'fix/test-branch', 'HEAD');
    git(sb.env, repo, 'worktree', 'add', '-q', wt, 'fix/test-branch');
    wtNv = join(repo, '.claude/worktrees/nv-branch');
    git(sb.env, repo, 'branch', 'fix/nv-branch', 'HEAD');
    git(sb.env, repo, 'worktree', 'add', '-q', wtNv, 'fix/nv-branch');
  });
  after(() => sb.remove());

  it('non-swe subagent: silent no-op', () => {
    assert.equal(run(nonSweInput), '', 'no output for non-swe');
  });

  let arBefore = 0;
  it('swe + pending task + no worktree commits → warn no-commits', () => {
    arBefore = runs(42);
    const out = run(sweInput());
    has(out, NO_COMMITS, 'warn body');
    has(out, 'additionalContext', 'additionalContext key present');
    hasNot(out, 'auto-completed', 'should not auto-complete');
    assert.equal(status(42), 'pending', 'task status unchanged');
  });

  it('swe + pending task + no worktree commits → agent_runs row written', () => {
    assert.equal(runs(42), arBefore + 1, 'agent_runs row written even on warn-no-commits');
  });

  describe('swe + pending task + worktree commits, no passing verification run at HEAD (GH 2866)', () => {
    let head = '';
    let out = '';
    before(() => {
      head = commitIn(sb.env, wt, 'work.txt', 'feat: work');
      out = run(sweInput());
    });

    it('task stays pending with no commit_sha', () => {
      assert.equal(status(42), 'pending', 'no auto-complete without a gate run');
      assert.equal(q(db, 'SELECT commit_sha FROM tasks WHERE id=42'), '', 'commit_sha untouched');
      assert.equal(Number(q(db, "SELECT COUNT(*) FROM audit WHERE event_type='swe_atomic_close_auto_completed'")), 0, 'no auto_completed row');
    });

    it('exactly one swe_atomic_close_gate_pending audit row naming task and HEAD', () => {
      assert.equal(gatePendingCount(db, 42), 1, 'one gate_pending row');
      const content = JSON.parse(q(db, "SELECT content_json FROM audit WHERE event_type='swe_atomic_close_gate_pending'")) as object;
      assert.deepEqual(content, { task_id: 42, commit_sha: head });
    });

    it('additionalContext tells bro to resume the swe through the gate', () => {
      has(out, 'additionalContext', 'context for bro');
      has(out, head, 'context names the HEAD');
      has(out, 'Resume the swe', 'context says resume swe');
      has(out, 'task_update_status', 'context names the close path');
    });

    it('a failing or timed-out run at HEAD does not count as passing', () => {
      recordRun(db, 42, head, 1, 0);
      recordRun(db, 42, head, 0, 1);
      execDb(db, "UPDATE tasks SET updated_at=datetime('now', '+15 seconds') WHERE id=42;");
      has(run(sweInput()), 'Resume the swe', 'still gate-pending');
      assert.equal(status(42), 'pending', 'still pending');
      assert.equal(gatePendingCount(db, 42), 2, 'one more gate_pending row');
    });

    it('a passing run at an older commit does not count for HEAD', () => {
      const old = git(sb.env, repo, 'rev-parse', 'dev');
      recordRun(db, 42, old);
      run(sweInput());
      assert.equal(status(42), 'pending', 'still pending');
    });
  });

  it('swe + pending task + worktree commits + passing run at HEAD (detached HEAD) → auto-completed', () => {
    const head = git(sb.env, wt, 'rev-parse', 'HEAD');
    recordRun(db, 42, head);
    const pendingBefore = gatePendingCount(db, 42);
    assert.equal(run(sweInput()), '', 'no additionalContext on auto-close');
    assert.equal(gatePendingCount(db, 42), pendingBefore, 'no gate_pending row on auto-close');
    assert.equal(status(42), 'completed', 'task auto-closed to completed');
    assert.equal(q(db, 'SELECT commit_sha FROM tasks WHERE id=42'), head, 'commit_sha written from worktree HEAD');
  });

  it('swe + completed task → metrics-only, no additionalContext', () => {
    execDb(db, "UPDATE tasks SET updated_at=datetime('now', '+20 seconds') WHERE id=42;");
    arBefore = runs(42);
    assert.equal(run(sweInput()), '', 'no additionalContext on metrics-only');
  });

  it('swe + completed task → agent_runs row written', () => {
    assert.equal(runs(42), arBefore + 1, 'agent_runs row written for completed task');
  });

  describe('needs_validation + worktree commit → metrics-only', () => {
    before(() => {
      execDb(db, "UPDATE tasks SET updated_at=datetime('now', '+30 seconds') WHERE id=44;");
      commitIn(sb.env, wtNv, 'nv-work.txt', 'feat: nv work');
    });

    it('needs_validation + worktree commit → no additionalContext', () => {
      arBefore = runs(44);
      assert.equal(run(sweInput(44)), '', 'no additionalContext for metrics-only');
    });

    it('needs_validation + worktree commit → status stays needs_validation', () => {
      assert.equal(status(44), 'needs_validation', 'status not flipped by hook');
    });

    it('needs_validation + worktree commit → agent_runs row written', () => {
      assert.equal(runs(44), arBefore + 1, 'agent_runs row inserted');
    });
  });

  describe('needs_validation + no worktree commit → metrics-only', () => {
    before(() => {
      git(sb.env, wtNv, 'reset', '--hard', '-q', git(sb.env, repo, 'rev-parse', 'dev'));
      execDb(db, "UPDATE tasks SET updated_at=datetime('now', '+35 seconds') WHERE id=44;");
    });

    it('needs_validation + no commit → no additionalContext', () => {
      arBefore = runs(44);
      assert.equal(run(sweInput(44)), '', 'no additionalContext even with no commits');
    });

    it('needs_validation + no commit → status stays needs_validation', () => {
      assert.equal(status(44), 'needs_validation', 'status unchanged');
    });

    it('needs_validation + no commit → agent_runs row written', () => {
      assert.equal(runs(44), arBefore + 1, 'agent_runs written for no-commit needs_validation spawn');
    });
  });

  it('entry-log fires regardless of subagent_type (#94)', () => {
    const log = join(repo, '.claude/tmb/logs/mcp-health.log');
    const count = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').length - 1 : 0);
    const before = count();
    run(nonSweInput);
    assert.equal(count() - before, 1, 'non-swe input should write exactly 1 entry-log line');
    const last = readFileSync(log, 'utf8').trimEnd().split('\n').at(-1) ?? '';
    has(last, '"kind":"swe-atomic-close-entry"', 'last log line is not entry-log');
    has(last, '"agent_type_resolved":"architect"', 'entry-log missing resolved agent_type architect');
  });

  it('hook recognizes the real CC payload (.agent_type=tmb:swe) (#103)', () => {
    resetPending();
    recordRun(db, 42, commitIn(sb.env, wt, 'work-103.txt', 'feat: 103 work'));
    run({
      agent_id: 'test-id-real-cc',
      agent_transcript_path: spawnTranscript(sb.dir, 42),
      agent_type: 'tmb:swe',
      cwd: repo,
      hook_event_name: 'SubagentStop',
      last_assistant_message: '',
      permission_mode: 'default',
      session_id: 'test-session',
      transcript_path: '/tmp/t',
    });
    assert.equal(status(42), 'completed', 'hook should auto-complete pending task with real CC payload (.agent_type=tmb:swe)');
  });

  it("hook also accepts the bare 'swe' agent_type value", () => {
    resetPending();
    recordRun(db, 42, commitIn(sb.env, wt, 'work-bare.txt', 'feat: bare swe work'));
    run(spawnInput(sb.dir, 42, 'swe'));
    assert.equal(status(42), 'completed', "hook should also accept bare 'swe' agent_type value");
  });

  describe('transcript parsed → agent_runs has real token/duration values', () => {
    let row: string[] = [];
    before(() => {
      const transcript = join(sb.dir, 'synthetic-transcript.jsonl');
      writeFileSync(
        transcript,
        [
          '{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=42 branch_id=fix/test-branch do the work"}]}}',
          '{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]}}',
          '{"timestamp":"2026-04-01T00:00:01.500Z","message":{"role":"assistant","usage":{"input_tokens":200,"output_tokens":75},"content":[]}}',
          '',
        ].join('\n'),
      );
      resetPending();
      commitIn(sb.env, wt, 'work-transcript.txt', 'feat: transcript work');
      run({ subagent_type: 'swe', agent_transcript_path: transcript });
      row = q(db, 'SELECT tokens_in, tokens_out, tool_uses, duration_ms, started_at, usage_source FROM agent_runs ORDER BY id DESC LIMIT 1').split('|');
    });

    it('transcript parsed: tokens_in=300', () => {
      assert.equal(row[0], '300', 'tokens_in');
    });

    it('transcript parsed: tokens_out=125', () => {
      assert.equal(row[1], '125', 'tokens_out');
    });

    it('transcript parsed: started_at = first transcript timestamp, usage_source=subagent_stop', () => {
      assert.equal(row[4], '2026-04-01T00:00:00.000Z', 'started_at');
      assert.equal(row[5], 'subagent_stop', 'usage_source');
    });

    it('transcript parsed: tool_uses=1', () => {
      assert.equal(row[2], '1', 'tool_uses');
    });

    it('transcript parsed: duration_ms close to 1500', () => {
      const ms = Number(row[3]);
      assert.ok(ms >= 1490 && ms <= 1510, `duration_ms expected ~1500, got ${row[3]}`);
    });
  });

  describe('no task id → capture-skipped audit row; no task or agent_runs write', () => {
    let arTotal = '';
    let out = '';
    let skipBefore = 0;
    before(() => {
      resetPending();
      commitIn(sb.env, wt, 'work-nopath.txt', 'feat: nopath work');
      arTotal = q(db, 'SELECT COUNT(*) FROM agent_runs');
      skipBefore = Number(skippedCount(db));
      out = run({ subagent_type: 'swe' });
    });

    it('no transcript path: no output, task 42 stays pending (no updated_at guess)', () => {
      assert.equal(out, '', 'no additionalContext');
      assert.equal(status(42), 'pending', 'most recently updated task untouched');
    });

    it('no transcript path: agent_runs_capture_skipped audit row, no agent_runs write', () => {
      assert.equal(Number(skippedCount(db)), skipBefore + 1, 'one capture-skipped audit row');
      assert.equal(q(db, 'SELECT COUNT(*) FROM agent_runs'), arTotal, 'no agent_runs row');
      assert.equal(
        q(db, "SELECT issue_id, from_node FROM audit WHERE event_type='agent_runs_capture_skipped' ORDER BY id DESC LIMIT 1"),
        '-1|hook:swe-atomic-close',
        'audit row on the system issue, written as the hook',
      );
    });

    it('missing file: capture-skipped audit row, task 42 untouched, no agent_runs write', () => {
      const before = Number(skippedCount(db));
      run({ subagent_type: 'swe', agent_transcript_path: join(sb.dir, 'does-not-exist-tmb-test.jsonl') });
      assert.equal(Number(skippedCount(db)), before + 1, 'one capture-skipped audit row');
      assert.equal(status(42), 'pending', 'task untouched');
      assert.equal(q(db, 'SELECT COUNT(*) FROM agent_runs'), arTotal, 'no agent_runs row');
    });
  });

  describe('swe waits on a background command (GH 2206)', () => {
    const waitRows = () => Number(q(db, "SELECT COUNT(*) FROM audit WHERE event_type='swe_atomic_close_background_wait'"));
    const closeRows = () => Number(q(db, "SELECT COUNT(*) FROM audit WHERE event_type='swe_atomic_close_auto_completed'"));
    const bgTranscript = (ended: boolean) => {
      const lines: object[] = [
        { type: 'user', timestamp: '2026-04-01T00:00:00.000Z', message: { role: 'user', content: 'task_id=42 You are swe. Implement the spec.' } },
        {
          type: 'assistant',
          timestamp: '2026-04-01T00:00:00.500Z',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 60', run_in_background: true } }] },
        },
        {
          type: 'user',
          timestamp: '2026-04-01T00:00:01.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Command running in background with ID: bgw2206. Output is being written to: /tmp/bgw2206.output.' }] },
        },
      ];
      if (ended) {
        lines.push({
          type: 'attachment',
          timestamp: '2026-04-01T00:00:03.000Z',
          attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>bgw2206</task-id>\n<status>completed</status>\n</task-notification>' },
        });
      }
      lines.push({ type: 'assistant', timestamp: '2026-04-01T00:00:02.000Z', message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 }, content: [] } });
      return writeTranscript(join(sb.dir, `bg-${ended ? 'ended' : 'live'}.jsonl`), lines);
    };
    const bgInput = (ended: boolean) => ({ agent_type: 'swe', agent_id: `bg-${ended}`, agent_transcript_path: bgTranscript(ended), hook_event_name: 'SubagentStop', session_id: 'sess-test' });

    it('live background id: task stays running, commit_sha unchanged, one background_wait row, no auto_completed row', () => {
      resetPending();
      execDb(db, "UPDATE tasks SET status='running' WHERE id=42;");
      const head = commitIn(sb.env, wt, 'work-bg.txt', 'feat: bg work');
      const closeBefore = closeRows();
      const out = run(bgInput(false));
      assert.equal(status(42), 'running', 'task stays running');
      assert.equal(q(db, 'SELECT commit_sha FROM tasks WHERE id=42'), '', 'commit_sha unchanged');
      assert.equal(waitRows(), 1, 'one swe_atomic_close_background_wait row');
      assert.equal(closeRows(), closeBefore, 'no swe_atomic_close_auto_completed row');
      const content = JSON.parse(q(db, "SELECT content_json FROM audit WHERE event_type='swe_atomic_close_background_wait'")) as object;
      assert.deepEqual(content, { task_id: 42, commit_sha: head, background_ids: ['bgw2206'] });
      has(q(db, "SELECT summary FROM audit WHERE event_type='swe_atomic_close_background_wait'"), 'bgw2206', 'summary names the id');
      has(out, 'additionalContext', 'context for bro');
      has(out, 'bgw2206', 'context names the id');
      has(out, 'resumed turn closes', 'context says swe closes it');
    });

    it('every background id ended: auto-completes', () => {
      const head = git(sb.env, wt, 'rev-parse', 'HEAD');
      recordRun(db, 42, head);
      const closeBefore = closeRows();
      assert.equal(run(bgInput(true)), '', 'no additionalContext on auto-close');
      assert.equal(status(42), 'completed', 'task auto-completed');
      assert.equal(q(db, 'SELECT commit_sha FROM tasks WHERE id=42'), head, 'commit_sha written');
      assert.equal(closeRows(), closeBefore + 1, 'one auto_completed row');
      assert.equal(waitRows(), 1, 'no new background_wait row');
    });
  });
});
