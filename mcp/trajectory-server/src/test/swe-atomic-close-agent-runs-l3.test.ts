/**
 * The swe-atomic-close-agent-runs l3 bash suite in node:test (GH 1692): the
 * agent_runs write path of `node dist/hooks.js swe-atomic-close` on the real
 * schema, run from a temp repo with CLAUDE_PROJECT_DIR pinned to the sandbox,
 * PWD set and CLAUDE_PLUGIN_ROOT on the plugin.
 *
 *   1. Binding: the row lands on the task named by task_id=<N> in the spawn
 *      prompt, for any task status; no task id writes a capture-skipped row.
 *   2. Status: a running task with commits auto-completes; a failed one gets
 *      metrics only.
 *   3. One row per spawn: the task_brief row is UPDATEd, a re-fire never
 *      duplicates.
 *   4. Measures: every token column is a per-message sum.
 *   5. Effort: swe rows copy tasks.effort; code-reviewer rows carry the
 *      task's assigned reviewer effort (GH 1955), else
 *      plugin_config.reviewer_effort (medium when unset).
 *   6. No usage: closes the row unmeasured and keeps earlier metering.
 *   7. Plugin version (GH 1884): the insert writes the manifest version, an
 *      UPDATE leaves it, no CLAUDE_PLUGIN_ROOT writes NULL.
 *   8. Checkpoint (GH 1905): one from this run keeps the task running with
 *      stop_cause budget; an older one auto-completes and is cleared.
 *   9. Hook block (GH 1914): a last PreToolUse deny with no completion report
 *      records stop_cause hook_block and names the block to bro.
 *  10. Tool output (GH 1957): one agent_run_tool_output row per tool, idempotent.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { contextOf, makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';
import { gateEnv, git, has, hasNot, newDb, sql } from './git-push-guard-l3.js';
import { commitIn, GATE, NO_COMMITS, q, recordRun, writeTranscript } from './swe-atomic-close-l3.js';

const NOW = '2026-06-16T19:00:00.000Z';
const BLOCK_DENY = 'PreToolUse:Bash hook error: BLOCKED: write target "python3" cannot be judged; use Edit or Write on the literal path.';
const BLOCK_SENTENCE = 'ended on a hook block with no completion report';

describe('swe-atomic-close l3: agent_runs write path', () => {
  let sb: Sandbox;
  let repo: string;
  let db: string;
  let pluginVersion: string;
  let otherRoot: string;

  /** The gate run from the repo; <pluginRoot> null leaves CLAUDE_PLUGIN_ROOT unset. */
  function runHook(payload: object, pluginRoot: string | null = PLUGIN_ROOT) {
    const env: NodeJS.ProcessEnv = { ...gateEnv(sb, repo), TRAJECTORY_DB_PATH: db };
    if (pluginRoot !== null) env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    return runGate(GATE, { cwd: repo, input: `${JSON.stringify(payload)}\n`, env });
  }
  const hook = (payload: object, pluginRoot: string | null = PLUGIN_ROOT) => {
    const r = runHook(payload, pluginRoot);
    return r.stdout + r.stderr;
  };

  const stopInput = (tp: string, id: string) => ({ agent_type: 'tmb:swe', agent_id: id, session_id: 'sess-1', agent_transcript_path: tp, hook_event_name: 'SubagentStop' });
  const prStopInput = (tp: string, id: string) => ({ agent_type: 'tmb:code-reviewer', agent_id: id, session_id: 'sess-1', agent_transcript_path: tp, hook_event_name: 'SubagentStop' });

  /** A two-message spawn with plain-string prompt content naming <task>. */
  const transcript = (task: number, name: string) =>
    writeTranscript(join(sb.dir, name), [
      `{"type":"user","timestamp":"2026-06-16T19:30:00.000Z","message":{"role":"user","content":"task_id=${task} You are swe."}}`,
      '{"type":"assistant","timestamp":"2026-06-16T19:30:04.000Z","message":{"id":"m1","usage":{"input_tokens":40,"output_tokens":4},"content":[]}}',
    ]);
  const promptOnly = (task: number, name: string) =>
    writeTranscript(join(sb.dir, name), [`{"type":"user","timestamp":"2026-06-16T19:30:00.000Z","message":{"role":"user","content":"task_id=${task} You are swe."}}`]);

  const runs = (task: number) => q(db, 'SELECT COUNT(*) FROM agent_runs WHERE task_id=?', task);
  const skipped = () => q(db, "SELECT COUNT(*) FROM audit WHERE event_type='agent_runs_capture_skipped' AND from_node='hook:swe-atomic-close' AND issue_id=-1");
  const insertTask = (id: number, status: string, effort?: string) =>
    effort === undefined
      ? sql(db, "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (?, 1, ?, 'dev', 'd', ?, ?, ?)", id, `fix/task-${id}`, status, NOW, NOW)
      : sql(
          db,
          "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, effort, created_at, updated_at) VALUES (?, 1, ?, 'dev', 'd', ?, ?, ?, ?)",
          id,
          `fix/task-${id}`,
          status,
          effort,
          NOW,
          NOW,
        );
  const openRow = (task: number, startedAt: string, completedAt: string | null = null) =>
    sql(db, "INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at) VALUES (?, 1, 'swe', ?, ?)", task, startedAt, completedAt);
  const wtHead = (task: number) => git(sb.env, join(repo, `.claude/worktrees/task-${task}`), 'rev-parse', 'HEAD');

  /** A running task whose worktree carries one commit with a passing verification run. */
  function committedTask(id: number): void {
    insertTask(id, 'running');
    git(sb.env, repo, 'branch', `fix/task-${id}`, 'dev');
    const wt = join(repo, `.claude/worktrees/task-${id}`);
    git(sb.env, repo, 'worktree', 'add', '-q', wt, `fix/task-${id}`);
    writeFileSync(join(wt, `c${id}.txt`), `c${id}\n`);
    git(sb.env, wt, 'add', `c${id}.txt`);
    git(sb.env, wt, 'commit', '-qm', `feat: c${id}`);
    recordRun(db, id, wtHead(id));
  }

  before(() => {
    sb = makeSandbox('swe-atomic-close-agent-runs');
    repo = join(sb.dir, 'repo');
    mkdirSync(repo);
    git(sb.env, repo, 'init', '-q', '-b', 'dev');
    git(sb.env, repo, 'config', 'user.email', 't@t.io');
    git(sb.env, repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'init\n');
    git(sb.env, repo, 'add', '.');
    git(sb.env, repo, 'commit', '-qm', 'init');

    db = newDb(repo);
    sql(db, "UPDATE issues SET objective='metering', created_at=?, updated_at=? WHERE id=1", NOW, NOW);
    insertTask(137, 'completed');
    sql(db, "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (138, 1, 'fix/task-138', 'dev', 'd', 'completed', ?, '2026-06-16T19:59:00.000Z')", NOW);
    insertTask(140, 'running');
    insertTask(141, 'failed');
    insertTask(142, 'pending');
    pluginVersion = (JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')) as { version: string }).version;

    git(sb.env, repo, 'branch', 'fix/task-140', 'HEAD');
    const wt140 = join(repo, '.claude/worktrees/task-140');
    git(sb.env, repo, 'worktree', 'add', '-q', wt140, 'fix/task-140');
    recordRun(db, 140, commitIn(sb.env, wt140, 'w.txt', 'feat: w'));

    otherRoot = join(sb.dir, 'other-plugin');
    mkdirSync(join(otherRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(otherRoot, '.claude-plugin/plugin.json'), '{"name":"tmb","version":"0.0.1-other"}\n');
  });
  after(() => sb.remove());

  describe('task 137: block content, cumulative cache', () => {
    let t137: string;
    before(() => {
      t137 = writeTranscript(join(sb.dir, 'transcript-137.jsonl'), [
        '{"timestamp":"2026-06-16T19:10:00.000Z","message":{"role":"user","content":[{"type":"text","text":"task_id=137 branch_id=fix/task-137 implement the thing"}]}}',
        '{"timestamp":"2026-06-16T19:10:05.000Z","message":{"id":"a","role":"assistant","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200000,"cache_creation_input_tokens":50000},"content":[{"type":"text","text":"thinking"}]}}',
        '{"timestamp":"2026-06-16T19:10:05.000Z","message":{"id":"a","role":"assistant","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200000,"cache_creation_input_tokens":50000},"content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]}}',
        '{"timestamp":"2026-06-16T19:10:30.000Z","message":{"id":"b","role":"assistant","usage":{"input_tokens":2000,"output_tokens":800,"cache_read_input_tokens":17200000,"cache_creation_input_tokens":60000},"content":[{"type":"tool_use","id":"t2","name":"edit","input":{}}]}}',
        '{"timestamp":"2026-06-16T19:10:55.000Z","message":{"id":"c","role":"assistant","usage":{"input_tokens":3000,"output_tokens":900,"cache_read_input_tokens":18400000,"cache_creation_input_tokens":70000},"content":[]}}',
      ]);
    });

    it('first SubagentStop writes exactly one agent_runs row for task 137', () => {
      hook(stopInput(t137, 'agent-137'));
      assert.equal(runs(137), '1', 'one row after first stop');
      assert.equal(
        q(db, 'SELECT agent_type, spawn_id, session_id, usage_source, started_at, issue_id FROM agent_runs WHERE task_id=137'),
        'swe|agent-137|sess-1|subagent_stop|2026-06-16T19:10:00.000Z|1',
        'spawn_id = agent_id; started_at = first transcript timestamp',
      );
    });

    it('re-fire with the same agent_id updates the row, never duplicates', () => {
      hook(stopInput(t137, 'agent-137'));
      assert.equal(runs(137), '1', 'still one row after second stop');
    });

    it('no row bled onto sibling task 138', () => {
      assert.equal(runs(138), '0', 'sibling task 138 has zero rows');
    });

    it('tokens_in/out are summed once per message (split content-block lines dedupe)', () => {
      assert.equal(q(db, 'SELECT tokens_in, tokens_out FROM agent_runs WHERE task_id=137'), '6000|2200', 'in = 1000+2000+3000, out = 500+800+900');
    });

    it('cache_read / cache_creation are per-message sums (split content-block lines dedupe)', () => {
      assert.equal(q(db, 'SELECT cache_read_tokens, cache_creation_tokens FROM agent_runs WHERE task_id=137'), '35800000|180000', '200K+17.2M+18.4M and 50K+60K+70K');
    });

    it('tool_uses counts the tool_use blocks', () => {
      assert.equal(q(db, 'SELECT tool_uses FROM agent_runs WHERE task_id=137'), '2', 'two tool_use blocks');
    });
  });

  it('the swe row task_brief opened is UPDATEd with started_at preserved', () => {
    openRow(142, '2026-06-16T19:30:01.000Z');
    const opened = q(db, 'SELECT MAX(id) FROM agent_runs');
    hook(stopInput(transcript(142, 't142.jsonl'), 'agent-142'));
    assert.equal(runs(142), '1', 'no second row');
    assert.equal(
      q(db, 'SELECT id, started_at, spawn_id, tokens_in, tokens_out, usage_source FROM agent_runs WHERE task_id=142'),
      `${opened}|2026-06-16T19:30:01.000Z|agent-142|40|4|subagent_stop`,
      'same row, started_at kept, metrics + spawn_id written',
    );
    assert.equal(q(db, 'SELECT completed_at IS NOT NULL FROM agent_runs WHERE task_id=142'), '1', 'row closed');
  });

  it("a resumed spawn's duplicate unkeyed swe row is marked unmeasured, the metered row untouched", () => {
    insertTask(150, 'failed');
    insertTask(151, 'running');
    openRow(150, '2026-06-16T19:30:01.000Z', '2026-06-16T19:30:02.000Z');
    openRow(150, '2026-06-16T19:30:03.000Z');
    openRow(151, '2026-06-16T19:30:03.000Z');
    hook(stopInput(transcript(150, 't150.jsonl'), 'agent-150'));
    assert.equal(runs(150), '2', 'no third row');
    assert.equal(
      q(db, "SELECT COUNT(*), MAX(tokens_in), MAX(tokens_out) FROM agent_runs WHERE task_id=150 AND usage_source='subagent_stop'"),
      '1|40|4',
      'exactly one row carries the transcript sums',
    );
    assert.equal(
      q(db, "SELECT usage_source, exit_reason, completed_at IS NOT NULL FROM agent_runs WHERE task_id=150 AND COALESCE(usage_source, '') <> 'subagent_stop'"),
      'unmeasured|swept_orphan|1',
      'the other row is unmeasured, swept_orphan, closed',
    );
    assert.equal(q(db, "SELECT COALESCE(usage_source, ''), completed_at IS NOT NULL FROM agent_runs WHERE task_id=151"), '|0', 'sibling task row unchanged');
    assert.equal(
      q(
        db,
        "SELECT COUNT(*) FROM agent_runs WHERE task_id=150 AND completed_at IS NOT NULL AND (usage_source IS NULL OR usage_source <> 'unmeasured') AND COALESCE(tokens_in, 0)=0 AND COALESCE(tokens_out, 0)=0 AND COALESCE(cache_read_tokens, 0)=0 AND COALESCE(cache_creation_tokens, 0)=0",
      ),
      '0',
      'swe_runs_metered predicate returns 0',
    );
  });

  it('a row already closed by a terminal status update still takes the spawn metrics', () => {
    openRow(141, '2026-06-16T19:30:01.000Z', '2026-06-16T19:30:03.000Z');
    hook(stopInput(transcript(141, 't141.jsonl'), 'agent-141'));
    assert.equal(runs(141), '1', 'the closed task_brief row is reused, no duplicate');
    assert.equal(q(db, 'SELECT tokens_in, spawn_id FROM agent_runs WHERE task_id=141'), '40|agent-141', 'metrics written');
  });

  it('a failed task gets metrics only — status unchanged', () => {
    assert.equal(q(db, 'SELECT status FROM tasks WHERE id=141'), 'failed', 'still failed');
  });

  it('a running task with commits is auto-completed', () => {
    assert.equal(hook(stopInput(transcript(140, 't140.jsonl'), 'agent-140')), '', 'no additionalContext');
    assert.equal(q(db, "SELECT status, COALESCE(commit_sha, '') FROM tasks WHERE id=140"), `completed|${wtHead(140)}`, 'completed at the worktree HEAD');
    assert.equal(runs(140), '1', 'metrics row written for the running task');
  });

  it('a running task with no commits stays running and bro is warned', () => {
    insertTask(145, 'running');
    has(hook(stopInput(transcript(145, 't145.jsonl'), 'agent-145')), NO_COMMITS, 'warn-no-commits context');
    assert.equal(q(db, 'SELECT status FROM tasks WHERE id=145'), 'running', 'still running');
  });

  describe('no usage (GH 1673)', () => {
    let empty146: string;
    it('a stop with no usage in its transcript closes the row unmeasured (GH 1673)', () => {
      insertTask(146, 'failed');
      sql(db, "INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id) VALUES (146, 1, 'swe', '2026-06-16T19:30:01.000Z', 'agent-146')");
      empty146 = promptOnly(146, 't146-empty.jsonl');
      hook(stopInput(empty146, 'agent-146'));
      assert.equal(
        q(db, 'SELECT completed_at IS NOT NULL, usage_source, exit_reason, tokens_in, tokens_out FROM agent_runs WHERE task_id=146'),
        '1|unmeasured|failed|0|0',
        'closed, failed, unmeasured, zero tokens',
      );
    });

    it('a later stop with no usage keeps the tokens and source an earlier stop metered', () => {
      hook(stopInput(transcript(146, 't146.jsonl'), 'agent-146'));
      assert.equal(q(db, 'SELECT usage_source, tokens_in, tokens_out FROM agent_runs WHERE task_id=146'), 'subagent_stop|40|4', 'metered');
      hook(stopInput(empty146, 'agent-146'));
      assert.equal(
        q(db, 'SELECT COUNT(*), MAX(usage_source), MAX(tokens_in), MAX(tokens_out) FROM agent_runs WHERE task_id=146'),
        '1|subagent_stop|40|4',
        'one row, metering kept',
      );
    });

    it('a stop with no usage and no open row inserts an unmeasured row', () => {
      insertTask(147, 'failed');
      hook(stopInput(promptOnly(147, 't147.jsonl'), 'agent-147'));
      assert.equal(q(db, 'SELECT COUNT(*), MAX(usage_source) FROM agent_runs WHERE task_id=147'), '1|unmeasured', 'one unmeasured row');
    });
  });

  let noId: string;
  it('transcript without task_id → capture-skipped audit row, no agent_runs write', () => {
    noId = writeTranscript(join(sb.dir, 'transcript-no-id.jsonl'), [
      '{"timestamp":"2026-06-16T19:20:00.000Z","message":{"role":"user","content":"do the work, no id here"}}',
      '{"timestamp":"2026-06-16T19:20:05.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":300000},"content":[]}}',
    ]);
    const total = q(db, 'SELECT COUNT(*) FROM agent_runs');
    hook(stopInput(noId, 'agent-noid'));
    assert.equal(skipped(), '1', 'one agent_runs_capture_skipped audit row');
    assert.equal(q(db, 'SELECT COUNT(*) FROM agent_runs'), total, 'no agent_runs row');
    assert.equal(runs(138), '0', 'the most recently updated sibling is not guessed');
    has(q(db, "SELECT content_json FROM audit WHERE event_type='agent_runs_capture_skipped'"), '"spawn_id":"agent-noid"', 'audit row names the spawn');
  });

  it('foreign keys stay clean', () => {
    assert.equal(q(db, 'PRAGMA foreign_key_check'), '', 'foreign_key_check empty');
  });

  it('the spawn row carries the dominant model, host, worktree root_dir and exit_reason', () => {
    insertTask(143, 'completed');
    const t143 = writeTranscript(join(sb.dir, 't143.jsonl'), [
      '{"type":"user","timestamp":"2026-06-16T19:40:00.000Z","message":{"role":"user","content":"task_id=143 You are swe."}}',
      '{"type":"assistant","timestamp":"2026-06-16T19:40:01.000Z","message":{"id":"x1","model":"claude-small-1","usage":{"input_tokens":10,"output_tokens":1},"content":[]}}',
      '{"type":"assistant","timestamp":"2026-06-16T19:40:02.000Z","message":{"id":"x2","model":"claude-big-9","usage":{"input_tokens":900,"output_tokens":1},"content":[]}}',
      '{"type":"assistant","timestamp":"2026-06-16T19:40:03.000Z","message":{"id":"x3","model":"<synthetic>","usage":{"input_tokens":5000,"output_tokens":0},"content":[]}}',
    ]);
    hook(stopInput(t143, 'agent-143'));
    assert.equal(
      q(db, 'SELECT model, host, root_dir, exit_reason FROM agent_runs WHERE task_id=143'),
      `claude-big-9|claude|${repo}/.claude/worktrees/task-143|completed`,
      'model by tokens (<synthetic> ignored); root_dir = the task worktree; a completed task ends completed',
    );
    assert.equal(q(db, 'SELECT exit_reason FROM agent_runs WHERE task_id=140'), 'completed', 'a spawn that auto-completes its task ends completed');
    assert.equal(q(db, 'SELECT exit_reason FROM agent_runs WHERE task_id=145'), 'failed', 'a spawn that stops on a running task without commits ends failed');
    assert.equal(q(db, 'SELECT DISTINCT host FROM agent_runs WHERE task_id IS NOT NULL'), 'claude', 'every spawn row carries host claude');
  });

  describe('effort', () => {
    let t144: string;
    let tr1: string;
    const prRuns = (task: number) => q(db, "SELECT COUNT(*) FROM agent_runs WHERE task_id=? AND agent_type='code-reviewer'", task);

    it("a swe row carries its task's effort", () => {
      assert.equal(q(db, 'SELECT effort FROM agent_runs WHERE task_id=137'), 'medium', 'task 137 defaults to medium');
      insertTask(144, 'completed', 'high');
      t144 = transcript(144, 't144.jsonl');
      hook(stopInput(t144, 'agent-144'));
      assert.equal(q(db, 'SELECT agent_type, effort FROM agent_runs WHERE task_id=144'), 'swe|high', 'the swe row copies tasks.effort high');
    });

    it('a code-reviewer spawn gets one metering row carrying reviewer_effort (medium when unset)', () => {
      tr1 = writeTranscript(join(sb.dir, 'tr1.jsonl'), [
        '{"type":"user","timestamp":"2026-06-16T19:50:00.000Z","message":{"role":"user","content":"task_id=144 commit_sha=abc1234 branch_id=fix/task-144 repo=plugin attempt_n=1 subagent_session_id=s"}}',
        '{"type":"assistant","timestamp":"2026-06-16T19:50:09.000Z","message":{"id":"r1","model":"claude-opus-9","usage":{"input_tokens":70,"output_tokens":7},"content":[]}}',
      ]);
      hook(prStopInput(tr1, 'agent-rev-1'));
      assert.equal(prRuns(144), '1', 'one code-reviewer row');
      assert.equal(
        q(
          db,
          "SELECT spawn_id, tokens_in, tokens_out, usage_source, model, host, root_dir, exit_reason, effort, started_at FROM agent_runs WHERE task_id=144 AND agent_type='code-reviewer'",
        ),
        `agent-rev-1|70|7|subagent_stop|claude-opus-9|claude|${repo}|completed|medium|2026-06-16T19:50:00.000Z`,
        'metered, root_dir = the project root, effort = reviewer_effort default medium',
      );
      assert.equal(q(db, "SELECT status, COALESCE(commit_sha, '') FROM tasks WHERE id=144"), 'completed|', 'no task status side effect');
    });

    it('a code-reviewer re-fire updates its row in place', () => {
      hook(prStopInput(tr1, 'agent-rev-1'));
      assert.equal(prRuns(144), '1', 'still one code-reviewer row');
    });

    it('a configured reviewer_effort lands on the next code-reviewer row', () => {
      sql(db, `INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_effort', '"high"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
      hook(prStopInput(tr1, 'agent-rev-2'));
      assert.equal(
        q(db, "SELECT effort FROM agent_runs WHERE task_id=144 AND agent_type='code-reviewer' ORDER BY id"),
        'medium\nhigh',
        'the earlier row keeps medium, the new one carries high',
      );
    });

    it("the task's assigned reviewer effort lands on the code-reviewer row over the config (GH 1955)", () => {
      sql(
        db,
        "INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (1, 'fix/task-144', 'bro', 'reviewer_effort_assigned', 's', ?, ?)",
        JSON.stringify({ task_id: 144, commit_sha: 'abc1234', effort: 'low', reason: 'docs_tests' }),
        NOW,
      );
      try {
        hook(prStopInput(tr1, 'agent-rev-3'));
        assert.equal(q(db, "SELECT effort FROM agent_runs WHERE spawn_id='agent-rev-3'"), 'low', 'effort = the assigned low, not the configured high');
      } finally {
        sql(db, "DELETE FROM audit WHERE event_type='reviewer_effort_assigned'");
      }
    });

    it('an unbound code-reviewer spawn writes nothing', () => {
      const total = q(db, 'SELECT COUNT(*) FROM agent_runs');
      hook(prStopInput(noId, 'agent-rev-noid'));
      assert.equal(q(db, 'SELECT COUNT(*) FROM agent_runs'), total, 'no agent_runs row');
      assert.equal(skipped(), '1', 'no capture-skipped audit row for a code-reviewer');
    });

    describe('plugin_version (GH 1884)', () => {
      it('an inserted swe row carries the manifest plugin_version; a later UPDATE leaves it', () => {
        assert.equal(q(db, "SELECT plugin_version FROM agent_runs WHERE task_id=144 AND agent_type='swe'"), pluginVersion, 'swe insert');
        hook(stopInput(t144, 'agent-144'), otherRoot);
        assert.equal(
          q(db, "SELECT COUNT(*), MAX(plugin_version) FROM agent_runs WHERE task_id=144 AND agent_type='swe'"),
          `1|${pluginVersion}`,
          'the re-fire under another version updates the row and keeps its plugin_version',
        );
        assert.equal(q(db, "SELECT COALESCE(plugin_version, '') FROM agent_runs WHERE task_id=142"), '', 'the UPDATE of a row opened without a version writes none');
      });

      it('an inserted code-reviewer row carries the manifest plugin_version; a re-fire leaves it', () => {
        assert.equal(q(db, "SELECT plugin_version FROM agent_runs WHERE spawn_id='agent-rev-1'"), pluginVersion, 'code-reviewer insert');
        hook(prStopInput(tr1, 'agent-rev-1'), otherRoot);
        assert.equal(q(db, "SELECT COUNT(*), MAX(plugin_version) FROM agent_runs WHERE spawn_id='agent-rev-1'"), `1|${pluginVersion}`, 'the re-fire under another version keeps it');
      });

      it('with CLAUDE_PLUGIN_ROOT unset the insert still succeeds and writes NULL', () => {
        insertTask(148, 'completed');
        hook(stopInput(transcript(148, 't148.jsonl'), 'agent-148'), null);
        assert.equal(
          q(db, 'SELECT COUNT(*), MAX(tokens_in), MAX(plugin_version IS NULL) FROM agent_runs WHERE task_id=148'),
          '1|40|1',
          'one metered row, plugin_version NULL',
        );
      });
    });
  });

  describe('checkpoint handback and stop_cause (GH 1905)', () => {
    it('a checkpoint from this run plus commits keeps the task running and records stop_cause budget', () => {
      committedTask(160);
      sql(db, "UPDATE tasks SET checkpoint = json_object('done', 'half', 'left', 'rest', 'files', json_array('a.ts'), 'at', '2026-06-16T19:30:02.000Z') WHERE id=160");
      const out = hook(stopInput(transcript(160, 't160.jsonl'), 'agent-160'));
      has(out, 'handed back a checkpoint', 'checkpoint context for bro');
      has(out, 'task_brief.checkpoint', 'context points at task_brief.checkpoint');
      assert.equal(q(db, 'SELECT status, checkpoint IS NOT NULL FROM tasks WHERE id=160'), 'running|1', 'still running, checkpoint kept');
      assert.equal(q(db, "SELECT stop_cause, COALESCE(stop_detail, ''), exit_reason FROM agent_runs WHERE task_id=160"), 'budget||failed', 'the spawn row records budget');
    });

    it('an older checkpoint plus commits auto-completes and clears the checkpoint', () => {
      committedTask(161);
      sql(db, "UPDATE tasks SET checkpoint = json_object('done', 'half', 'left', 'rest', 'files', json_array(), 'at', '2026-06-16T19:00:00.000Z') WHERE id=161");
      assert.equal(hook(stopInput(transcript(161, 't161.jsonl'), 'agent-161')), '', 'no additionalContext');
      assert.equal(
        q(db, "SELECT status, COALESCE(commit_sha, ''), checkpoint IS NULL FROM tasks WHERE id=161"),
        `completed|${wtHead(161)}|1`,
        'completed at the worktree HEAD, checkpoint NULL',
      );
      assert.equal(q(db, "SELECT COALESCE(stop_cause, ''), exit_reason FROM agent_runs WHERE task_id=161"), '|completed', 'no stop_cause');
    });
  });

  describe('a run that ends on a hook block with no completion report (GH 1914)', () => {
    /** The spawn's last tool_result is a PreToolUse:Bash deny; with <report>, a successful completed task_update_status call follows it. */
    function denyTranscript(task: number, name: string, report = false): string {
      const lines: Array<string | object> = [
        `{"type":"user","timestamp":"2026-06-16T19:30:00.000Z","message":{"role":"user","content":"task_id=${task} You are swe."}}`,
        '{"type":"assistant","timestamp":"2026-06-16T19:30:04.000Z","message":{"id":"m1","usage":{"input_tokens":40,"output_tokens":4},"content":[{"type":"tool_use","id":"tb1","name":"Bash","input":{"command":"python3 x.py"}}]}}',
        { type: 'user', timestamp: '2026-06-16T19:30:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tb1', is_error: true, content: BLOCK_DENY }] } },
      ];
      if (report)
        lines.push(
          `{"type":"assistant","timestamp":"2026-06-16T19:30:06.000Z","message":{"id":"m2","usage":{"input_tokens":10,"output_tokens":2},"content":[{"type":"tool_use","id":"tr1","name":"mcp__plugin_tmb_trajectory-server__task_update_status","input":{"agent":"swe","task_id":"${task}","status":"completed"}}]}}`,
          '{"type":"user","timestamp":"2026-06-16T19:30:07.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tr1","content":"{\\"ok\\":true}"}]}}',
        );
      return writeTranscript(join(sb.dir, name), lines);
    }

    it('a deny with no report and no commits records hook_block and names the block beside the no-commit warning', () => {
      insertTask(170, 'running');
      const r = runHook(stopInput(denyTranscript(170, 't170.jsonl'), 'agent-170'));
      assert.equal(
        q(db, 'SELECT stop_cause, substr(stop_detail, 1, length(?1)) = ?1 AS starts FROM agent_runs WHERE task_id=170', BLOCK_DENY),
        'hook_block|1',
        'stop_cause hook_block, stop_detail starts with the deny',
      );
      const ctx = contextOf(r.stdout);
      has(ctx, NO_COMMITS, 'the no-commit warning stays');
      has(ctx, `SWE for task #170 ${BLOCK_SENTENCE}`, 'the hook-block sentence follows it');
      has(ctx, 'PreToolUse:Bash hook error: BLOCKED', 'the sentence quotes the deny');
      has(ctx, 'task_brief.last_stop', 'the sentence points at task_brief.last_stop');
      has(ctx, 'rework spawn_note', 'the sentence asks bro to name the block in the spawn_note');
    });

    it('a deny with no report and commits auto-completes and still names the block', () => {
      committedTask(171);
      const r = runHook(stopInput(denyTranscript(171, 't171.jsonl'), 'agent-171'));
      assert.equal(q(db, 'SELECT status FROM tasks WHERE id=171'), 'completed', 'the task auto-completes');
      assert.equal(q(db, 'SELECT stop_cause FROM agent_runs WHERE task_id=171'), 'hook_block', 'stop_cause hook_block');
      has(contextOf(r.stdout), `SWE for task #171 ${BLOCK_SENTENCE}`, 'the context names the block');
    });

    it('a deny followed by a successful completed report records no stop_cause and no hook-block sentence', () => {
      committedTask(172);
      const out = hook(stopInput(denyTranscript(172, 't172.jsonl', true), 'agent-172'));
      assert.equal(q(db, "SELECT COALESCE(stop_cause, '') FROM agent_runs WHERE task_id=172"), '', 'stop_cause NULL');
      hasNot(out, BLOCK_SENTENCE, 'no hook-block sentence');
    });
  });

  it('a spawn whose transcript calls no tool completes with no tool-output rows', () => {
    committedTask(162);
    const t162 = transcript(162, 't162.jsonl');
    assert.ok(!readFileSync(t162, 'utf8').includes('"tool_use"'), 'the transcript calls no tool');
    assert.equal(runHook(stopInput(t162, 'agent-162')).status, 0, 'the hook exits 0');
    assert.equal(q(db, 'SELECT status FROM tasks WHERE id=162'), 'completed', 'the task auto-completes');
    assert.equal(
      q(db, "SELECT COUNT(*), MAX(tokens_in), COALESCE(MAX(stop_cause), '') FROM agent_runs WHERE task_id=162"),
      '1|40|',
      'the row is metered, no stop_cause written',
    );
    assert.equal(q(db, 'SELECT COUNT(*) FROM agent_run_tool_output o JOIN agent_runs r ON r.id = o.run_id WHERE r.task_id=162'), '0', 'no tool-output rows');
  });

  describe('tool output (GH 1957)', () => {
    /** A spawn that calls Read and Bash and gets a 10-char and a 5-char result back. */
    const toolTranscript = (task: number, name: string, suffix: string) =>
      writeTranscript(join(sb.dir, name), [
        `{"type":"user","timestamp":"2026-06-16T19:40:00.000Z","message":{"role":"user","content":"task_id=${task} ${suffix}"}}`,
        '{"type":"assistant","timestamp":"2026-06-16T19:40:01.000Z","message":{"id":"m1","model":"claude-opus-9","usage":{"input_tokens":40,"output_tokens":4},"content":[{"type":"tool_use","id":"tu_r","name":"Read","input":{}}]}}',
        '{"type":"user","timestamp":"2026-06-16T19:40:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_r","content":"0123456789"}]}}',
        '{"type":"assistant","timestamp":"2026-06-16T19:40:03.000Z","message":{"id":"m2","model":"claude-opus-9","usage":{"input_tokens":40,"output_tokens":4},"content":[{"type":"tool_use","id":"tu_b","name":"Bash","input":{}}]}}',
        '{"type":"user","timestamp":"2026-06-16T19:40:04.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_b","content":[{"type":"text","text":"abcde"}]}]}}',
      ]);
    const toolRows = (task: number, agent: string) =>
      q(
        db,
        "SELECT o.tool_name || ':' || o.calls || ':' || o.result_chars || ':' || o.est_tokens FROM agent_run_tool_output o JOIN agent_runs r ON r.id = o.run_id WHERE r.task_id=? AND r.agent_type=? ORDER BY o.tool_name",
        task,
        agent,
      );
    const BOTH = 'Bash:1:5:2\nRead:1:10:3';

    it('a swe stop records its run per-tool result sizes in agent_run_tool_output (GH 1957)', () => {
      committedTask(180);
      const t180 = toolTranscript(180, 't180.jsonl', 'You are swe.');
      hook(stopInput(t180, 'agent-180'));
      assert.equal(toolRows(180, 'swe'), BOTH, 'one row per tool on the swe run');
      hook(stopInput(t180, 'agent-180'));
      assert.equal(toolRows(180, 'swe'), BOTH, 'a re-fire rewrites the rows, no duplicates');
    });

    it('a code-reviewer stop records its run per-tool result sizes (GH 1957)', () => {
      hook(prStopInput(toolTranscript(180, 'tr180.jsonl', 'commit_sha=abc1234 branch_id=fix/task-180 repo=plugin attempt_n=1'), 'agent-rev-180'));
      assert.equal(toolRows(180, 'code-reviewer'), BOTH, 'one row per tool on the code-reviewer run');
      assert.equal(toolRows(180, 'swe'), BOTH, 'the swe run rows are untouched');
    });
  });
});
