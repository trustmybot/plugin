/**
 * Unit tests of the TypeScript task-close gate (GH 1692): swe-atomic-close.
 * They cover the transcript reduction the .sh ran through `jq -rsc` (message
 * grouping, the resume window, the dominant model, zeros wherever jq stopped
 * on an error), the entry log's key list and the decision matrix run
 * in-process on a PATH with neither jq nor the sqlite3 CLI (decision 703).
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findGate, gateNames } from '../hooks/registry.js';
import { entryKeys, sweAtomicClose, transcriptStats, transcriptStatsOf } from '../hooks/swe-atomic-close.js';
import { buildCloseSandbox } from './hooks-task-close-parity.suite.js';
import { noCmdPath } from './hooks-swe-run-parity.suite.js';

const ALLOWED = { stdout: '', code: 0 };
const jsonl = (...entries: unknown[]): string => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
const usage = (input: number, output: number, read = 0, created = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: created,
});

describe('swe-atomic-close is a registered gate', () => {
  it('resolves by name and is listed', () => {
    assert.equal(typeof findGate('swe-atomic-close'), 'function');
    assert.ok(gateNames().includes('swe-atomic-close'));
  });
});

describe('transcriptStatsOf: the .sh jq reduction', () => {
  it('groups lines by message id, the last usage of a group winning, and counts every tool_use block', () => {
    const text = jsonl(
      { timestamp: '2026-10-01T10:00:00Z', message: { id: 'm1', model: 'claude-opus', usage: usage(10, 5, 100, 7), content: [{ type: 'tool_use' }, { type: 'text' }] } },
      { timestamp: '2026-10-01T10:00:01.5Z', message: { id: 'm1', model: 'claude-opus', usage: usage(11, 6, 100, 7), content: [{ type: 'tool_use' }] } },
      { timestamp: '2026-10-01T10:00:09Z', message: { id: 'm2', model: 'claude-haiku', usage: usage(1000, 1), content: 'hi' } },
    );
    assert.equal(transcriptStatsOf(text), '1011|7|2|9000|100|7|2026-10-01T10:00:00.000Z|claude-haiku');
  });

  it('keeps only the entries at or after the resume instant', () => {
    const text = jsonl(
      { timestamp: '2026-10-01T10:00:00Z', message: { id: 'a', model: 'm', usage: usage(5, 5) } },
      { timestamp: '2026-10-01T10:00:02Z', message: { id: 'b', model: 'm', usage: usage(1, 2) } },
    );
    assert.equal(transcriptStatsOf(text, '2026-10-01T10:00:01.000Z'), '1|2|0|0|0|0|2026-10-01T10:00:02.000Z|m');
  });

  it('breaks a model tie by name and strips <synthetic> to no model', () => {
    const tie = jsonl({ message: { id: 'a', model: 'mB', usage: usage(5, 5) } }, { message: { id: 'b', model: 'mA', usage: usage(5, 5) } });
    assert.equal(transcriptStatsOf(tie), '10|10|0|0|0|0||mA');
    assert.equal(transcriptStatsOf(jsonl({ message: { id: 's', model: '<synthetic>', usage: usage(1, 1) } })), '1|1|0|0|0|0||');
  });

  it('prints zeros wherever jq stops on an error: a bad line, a non-object entry, a string message or a bad month', () => {
    for (const text of ['{bad\n', jsonl(5), jsonl({ message: 'x' }), jsonl({ timestamp: '2026-13-01T10:00:00Z' }), ''])
      assert.equal(transcriptStatsOf(text), '0|0|0|0|0|0||', JSON.stringify(text));
  });

  it('reads a transcript file with a leading UTF-8 BOM like the plain file (GH 2112)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-bom-'));
    try {
      const line = jsonl({ timestamp: '2026-10-01T10:00:00Z', message: { id: 'm1', model: 'claude-opus', usage: usage(10, 5, 100, 7), content: [{ type: 'tool_use' }] } });
      const plain = join(dir, 'plain.jsonl');
      const bom = join(dir, 'bom.jsonl');
      writeFileSync(plain, line);
      writeFileSync(bom, `﻿${line}`);
      assert.equal(transcriptStats(plain), '10|5|1|0|100|7|2026-10-01T10:00:00.000Z|claude-opus');
      assert.equal(transcriptStats(bom), transcriptStats(plain));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints zeros for a missing transcript', () => {
    assert.equal(transcriptStats('/nonexistent/transcript.jsonl'), '0|0|0|0|0|0||');
  });
});

describe('entryKeys: the entry log key list', () => {
  it('lists the sorted unique dotted paths of non-null, non-false scalars', () => {
    assert.equal(entryKeys({ b: 1, a: { c: 'x', d: null, e: false }, f: [true, 2] }), '["a.c","b","f.0","f.1"]');
  });
});

describe('swe-atomic-close in-process, with neither jq nor the sqlite3 CLI on PATH (decision 703)', () => {
  let base: string;
  let s: string;
  let env: NodeJS.ProcessEnv;
  const db = (): DatabaseSync => new DatabaseSync(join(s, 'project/.claude/tmb/trajectory.db'), { readOnly: true });
  const stop = (task: string, agentType = 'swe'): string =>
    JSON.stringify({ hook_event_name: 'SubagentStop', agent_type: agentType, agent_id: `agent-${task}`, agent_transcript_path: join(s, 'transcripts', `${task}.jsonl`) });

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-task-close-unit-')));
    s = join(base, 'sandbox');
    const path = noCmdPath(join(base, 'nosqlite'), 'sqlite3', noCmdPath(join(base, 'nojq'), 'jq', process.env.PATH ?? ''));
    env = {
      PATH: path,
      HOME: join(s, 'home'),
      CLAUDE_PROJECT_DIR: join(s, 'project'),
      TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
      LC_ALL: 'C',
    };
  });
  before(() => {
    buildCloseSandbox(s);
    cpSync(s, join(base, 'template'), { recursive: true });
  });
  beforeEach(() => {
    rmSync(s, { recursive: true, force: true });
    cpSync(join(base, 'template'), s, { recursive: true });
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it('auto-completes a running task whose worktree carries a commit', async () => {
    assert.deepEqual(await sweAtomicClose(stop('30'), { ...env }), ALLOWED);
    const d = db();
    try {
      const task = d.prepare('SELECT status, commit_sha FROM tasks WHERE id = 30').get() as { status: string; commit_sha: string };
      assert.equal(task.status, 'completed');
      assert.match(task.commit_sha, /^[0-9a-f]{40}$/);
      const audit = d.prepare("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'swe_atomic_close_auto_completed'").get() as { n: number };
      assert.equal(audit.n, 1);
      const run = d.prepare("SELECT tokens_in, tokens_out, model, effort, exit_reason FROM agent_runs WHERE spawn_id = 'agent-30'").get();
      assert.deepEqual({ ...run }, { tokens_in: 110, tokens_out: 50, model: 'claude-opus-5-5', effort: 'high', exit_reason: 'completed' });
    } finally {
      d.close();
    }
  });

  const adoptTask = (id: number, branch: string, withCommit: boolean): string => {
    const repo = join(s, 'project/checkout');
    const session = join(s, 'project/session-wt');
    const sh = (dir: string, ...args: string[]): string =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    sh(repo, 'worktree', 'add', '-q', '-b', branch, session, 'dev');
    if (withCommit) {
      writeFileSync(join(session, 'adopted.txt'), 'adopted\n');
      sh(session, 'add', 'adopted.txt');
      sh(session, 'commit', '-qm', 'adopted work');
    }
    const d = new DatabaseSync(join(s, 'project/.claude/tmb/trajectory.db'));
    try {
      d.prepare(
        "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, repo, effort, worktree_path, worktree_adopted, created_at, updated_at) VALUES (?, 1, ?, 'dev', 'd', 'running', 'plugin', 'high', ?, 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')",
      ).run(id, branch, session);
    } finally {
      d.close();
    }
    const tx = join(s, 'transcripts');
    writeFileSync(join(tx, `${id}.jsonl`), readFileSync(join(tx, '32.jsonl'), 'utf8').replaceAll('task_id=32', `task_id=${id}`));
    return session;
  };

  it('auto-completes an adopted task at its recorded worktree head and names that worktree on the run row (GH 2240)', async () => {
    const session = adoptTask(44, 'feat/adopted', true);
    const head = execFileSync('git', ['-C', session, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const w = new DatabaseSync(join(s, 'project/.claude/tmb/trajectory.db'));
    try {
      w.prepare(
        "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (44, ?, 'gate', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z', 0, 600, 0)",
      ).run(head);
    } finally {
      w.close();
    }
    assert.deepEqual(await sweAtomicClose(stop('44'), { ...env }), ALLOWED);
    const d = db();
    try {
      assert.deepEqual({ ...d.prepare('SELECT status, commit_sha FROM tasks WHERE id = 44').get() }, { status: 'completed', commit_sha: head });
      assert.deepEqual({ ...d.prepare("SELECT root_dir FROM agent_runs WHERE spawn_id = 'agent-44'").get() }, { root_dir: session });
      assert.equal((d.prepare("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'swe_atomic_close_auto_completed'").get() as { n: number }).n, 1);
    } finally {
      d.close();
    }
  });

  it('names the recorded worktree when an adopted task stopped without commits (GH 2240)', async () => {
    const session = adoptTask(45, 'feat/adopted-empty', false);
    const r = await sweAtomicClose(stop('45'), { ...env });
    assert.ok(r.stdout.includes(`stopped without committing in worktree at ${session}.`), r.stdout);
  });

  it('warns bro when a running task stopped without commits', async () => {
    const r = await sweAtomicClose(stop('32'), { ...env });
    assert.match(r.stdout, /"hookEventName":"SubagentStop".*stopped without committing in worktree/);
  });

  it('names a hook block after the run', async () => {
    const r = await sweAtomicClose(stop('37'), { ...env });
    assert.match(r.stdout, /ended on a hook block with no completion report \(\\"PreToolUse:Bash hook error: BLOCKED: policy second line\\"\)/);
  });

  it('meters a code-reviewer stop at reviewer_effort and leaves the task alone', async () => {
    assert.deepEqual(await sweAtomicClose(stop('43', 'code-reviewer'), { ...env }), ALLOWED);
    const d = db();
    try {
      const run = d.prepare("SELECT effort, tokens_in, usage_source, completed_at IS NOT NULL AS closed FROM agent_runs WHERE spawn_id = 'agent-43'").get();
      assert.deepEqual({ ...run }, { effort: 'low', tokens_in: 110, usage_source: 'subagent_stop', closed: 1 });
      assert.deepEqual({ ...d.prepare('SELECT status FROM tasks WHERE id = 43').get() }, { status: 'completed' });
    } finally {
      d.close();
    }
  });

  const withMessage = (payload: string, chars: number): string =>
    JSON.stringify({ ...JSON.parse(payload), last_assistant_message: `status=completed task=1 sha=-\n${'x'.repeat(chars - 30)}` });
  const oversizeRows = (): Array<Record<string, unknown>> => {
    const d = db();
    try {
      return d
        .prepare("SELECT issue_id, content_json FROM audit WHERE event_type = 'subagent_return_oversize' ORDER BY id")
        .all()
        .map((r) => ({ issue_id: r.issue_id, ...JSON.parse(String(r.content_json)) }));
    } finally {
      d.close();
    }
  };

  const taskIssue = (id: number): number => {
    const d = db();
    try {
      return (d.prepare('SELECT issue_id FROM tasks WHERE id = ?').get(id) as { issue_id: number }).issue_id;
    } finally {
      d.close();
    }
  };

  it('GH 1959: a 601-char swe final message writes one subagent_return_oversize row and keeps the gate output', async () => {
    const message = withMessage(stop('30'), 601);
    assert.equal([...(JSON.parse(message) as { last_assistant_message: string }).last_assistant_message].length, 601);
    assert.deepEqual(await sweAtomicClose(message, { ...env }), ALLOWED);
    assert.deepEqual(oversizeRows(), [{ issue_id: taskIssue(30), task_id: 30, agent_type: 'swe', chars: 601 }]);
    const d = db();
    try {
      assert.deepEqual({ ...d.prepare('SELECT status FROM tasks WHERE id = 30').get() }, { status: 'completed' });
    } finally {
      d.close();
    }
  });

  it('GH 1959: the oversize flag leaves the no-commit warning byte-identical', async () => {
    const plain = await sweAtomicClose(stop('32'), { ...env });
    const long = await sweAtomicClose(withMessage(stop('32'), 601), { ...env });
    assert.deepEqual(long, plain);
    assert.equal(oversizeRows().length, 1);
  });

  it('GH 1959: a code-reviewer or unbound swe over budget is flagged, the unbound one with a null task_id', async () => {
    assert.deepEqual(await sweAtomicClose(withMessage(stop('43', 'code-reviewer'), 900), { ...env }), ALLOWED);
    assert.deepEqual(await sweAtomicClose(withMessage(stop('unbound'), 601), { ...env }), ALLOWED);
    assert.deepEqual(oversizeRows(), [
      { issue_id: taskIssue(43), task_id: 43, agent_type: 'code-reviewer', chars: 900 },
      { issue_id: -1, task_id: null, agent_type: 'swe', chars: 601 },
    ]);
  });

  it('GH 1959: a 600-char message, a missing message or another agent type writes no oversize row', async () => {
    assert.deepEqual(await sweAtomicClose(withMessage(stop('30'), 600), { ...env }), ALLOWED);
    assert.equal((await sweAtomicClose(stop('32'), { ...env })).code, 0);
    assert.deepEqual(await sweAtomicClose(withMessage(stop('32', 'consultant'), 5000), { ...env }), ALLOWED);
    assert.deepEqual(oversizeRows(), []);
  });

  it('records an unbound swe spawn as agent_runs_capture_skipped and ignores any other subagent', async () => {
    assert.deepEqual(await sweAtomicClose(stop('unbound'), { ...env }), ALLOWED);
    assert.deepEqual(await sweAtomicClose(stop('30', 'consultant'), { ...env }), ALLOWED);
    const d = db();
    try {
      assert.deepEqual({ ...d.prepare("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'agent_runs_capture_skipped'").get() }, { n: 1 });
      assert.deepEqual({ ...d.prepare('SELECT status FROM tasks WHERE id = 30').get() }, { status: 'running' });
    } finally {
      d.close();
    }
  });
});
