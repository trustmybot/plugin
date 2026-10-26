/**
 * The swe-stop-cause recorder (GH 1905) on a temp trajectory DB and fixture
 * transcripts: a checkpoint written in the run records budget, a trailing
 * PreToolUse deny records hook_block with its text unless the run made a
 * successful completed task_update_status call (GH 1914), and anything else leaves
 * both columns NULL. It always exits 0 with empty stdout.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { STOP_DETAIL_MAX_CHARS, hookBlockDetail, sweStopCause } from '../hooks/swe-stop-cause.js';
import { gateNames } from '../hooks/registry.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const HOOKS_JS = join(SERVER_ROOT, 'dist/hooks.js');
const ISSUE_ID = 9;
const TASK_ID = 3;
const SWE = 'agent-swe-1';
const SINCE = '2026-10-25T10:00:00.000Z';
const ALLOWED = { stdout: '', code: 0 };
const DENY = 'PreToolUse:Bash hook error: BLOCKED: write target "x" cannot be judged';

interface Fixture {
  root: string;
  db: string;
  env: NodeJS.ProcessEnv;
  exec(sql: string, ...params: Array<string | number | null>): void;
  row(): { stop_cause: string | null; stop_detail: string | null };
  transcript(lines: unknown[]): string;
}

let sandbox: string;
let seq = 0;

function fixture(): Fixture {
  seq += 1;
  const root = join(sandbox, `case-${seq}`);
  const db = join(root, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  d.exec(SCHEMA);
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')").run(ISSUE_ID);
  d.prepare(
    "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, 'feat/3-x', 'd', 'running', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')",
  ).run(TASK_ID, ISSUE_ID);
  d.prepare(
    "INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, spawn_id, exit_reason) VALUES (?, ?, 'swe', ?, '2026-10-25T10:30:00.000Z', ?, 'failed')",
  ).run(TASK_ID, ISSUE_ID, SINCE, SWE);
  d.close();
  const exec = (sql: string, ...params: Array<string | number | null>) => {
    const w = new DatabaseSync(db);
    w.prepare(sql).run(...params);
    w.close();
  };
  const row = () => {
    const r = new DatabaseSync(db);
    const out = r
      .prepare("SELECT stop_cause, stop_detail FROM agent_runs WHERE task_id = ? AND spawn_id = ? ORDER BY id DESC LIMIT 1")
      .get(TASK_ID, SWE) as { stop_cause: string | null; stop_detail: string | null };
    r.close();
    return { stop_cause: out.stop_cause, stop_detail: out.stop_detail };
  };
  const transcript = (lines: unknown[]) => {
    const path = join(root, 'agent.jsonl');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return path;
  };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    TRAJECTORY_DB_PATH: db,
    TMB_STOP_TASK_ID: String(TASK_ID),
    TMB_STOP_SPAWN_ID: SWE,
    TMB_STOP_SINCE: SINCE,
  };
  return { root, db, env, exec, row, transcript };
}

const toolUse = (ts: string, id: string, name: string, input: unknown = {}) => ({
  timestamp: ts,
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (ts: string, id: string, content: unknown, isError = false) => ({
  timestamp: ts,
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
});
const text = (ts: string, t: string) => ({
  timestamp: ts,
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: t }] },
});

const payload = (transcriptPath: string) => JSON.stringify({ agent_id: SWE, agent_transcript_path: transcriptPath });

const CHECKPOINT_AT = (at: string) => JSON.stringify({ done: 'd', left: 'l', files: [], at });

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'swe-stop-cause-'));
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('swe-stop-cause (GH 1905)', () => {
  it('is a registered TS gate', () => {
    assert.ok(gateNames().includes('swe-stop-cause'));
  });

  it('records budget when the task checkpoint was written in the run', () => {
    const f = fixture();
    f.exec('UPDATE tasks SET checkpoint = ? WHERE id = ?', CHECKPOINT_AT('2026-10-25T10:20:00.000Z'), TASK_ID);
    const t = f.transcript([toolUse('2026-10-25T10:21:00.000Z', 'toolu_1', 'Bash'), toolResult('2026-10-25T10:21:01.000Z', 'toolu_1', DENY, true)]);
    assert.deepEqual(sweStopCause(payload(t), f.env), ALLOWED);
    assert.deepEqual(f.row(), { stop_cause: 'budget', stop_detail: null });
  });

  it('records hook_block with the deny text for a trailing PreToolUse:Bash deny', () => {
    const f = fixture();
    f.exec('UPDATE tasks SET checkpoint = ? WHERE id = ?', CHECKPOINT_AT('2026-10-25T09:20:00.000Z'), TASK_ID);
    const t = f.transcript([
      toolUse('2026-10-25T10:01:00.000Z', 'toolu_1', 'Read'),
      toolResult('2026-10-25T10:01:01.000Z', 'toolu_1', 'file body'),
      toolUse('2026-10-25T10:02:00.000Z', 'toolu_2', 'Bash'),
      toolResult('2026-10-25T10:02:01.000Z', 'toolu_2', DENY, true),
      text('2026-10-25T10:02:05.000Z', 'Blocked by a hook; stopping.'),
    ]);
    assert.deepEqual(sweStopCause(payload(t), f.env), ALLOWED);
    assert.deepEqual(f.row(), { stop_cause: 'hook_block', stop_detail: DENY });
  });

  it('reads deny text given as text blocks and caps it at 500 characters', () => {
    const long = `${DENY} ${'y'.repeat(STOP_DETAIL_MAX_CHARS)}`;
    const detail = hookBlockDetail(
      [toolUse('2026-10-25T10:02:00.000Z', 'toolu_2', 'Write'), toolResult('2026-10-25T10:02:01.000Z', 'toolu_2', [{ type: 'text', text: long }], true)]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      Date.parse(SINCE),
    );
    assert.equal(detail, long.slice(0, STOP_DETAIL_MAX_CHARS));
  });

  it('leaves both NULL for a clean end', () => {
    const f = fixture();
    f.exec("UPDATE agent_runs SET stop_cause = 'hook_block', stop_detail = 'stale' WHERE spawn_id = ?", SWE);
    const t = f.transcript([
      toolUse('2026-10-25T10:01:00.000Z', 'toolu_1', 'Bash'),
      toolResult('2026-10-25T10:01:01.000Z', 'toolu_1', 'ok'),
      text('2026-10-25T10:02:00.000Z', 'done'),
    ]);
    assert.deepEqual(sweStopCause(payload(t), f.env), ALLOWED);
    assert.deepEqual(f.row(), { stop_cause: null, stop_detail: null });
  });

  it('leaves both NULL for a deny followed by a successful call', () => {
    const f = fixture();
    const t = f.transcript([
      toolUse('2026-10-25T10:01:00.000Z', 'toolu_1', 'Bash'),
      toolResult('2026-10-25T10:01:01.000Z', 'toolu_1', DENY, true),
      toolUse('2026-10-25T10:02:00.000Z', 'toolu_2', 'Edit'),
      toolResult('2026-10-25T10:02:01.000Z', 'toolu_2', 'edited'),
    ]);
    assert.deepEqual(sweStopCause(payload(t), f.env), ALLOWED);
    assert.deepEqual(f.row(), { stop_cause: null, stop_detail: null });
  });

  it('leaves both NULL when the only deny is a task_update_status error', () => {
    const f = fixture();
    const t = f.transcript([
      toolUse('2026-10-25T10:01:00.000Z', 'toolu_1', 'Bash'),
      toolResult('2026-10-25T10:01:01.000Z', 'toolu_1', 'ok'),
      toolUse('2026-10-25T10:02:00.000Z', 'toolu_2', 'mcp__plugin_tmb_trajectory-server__task_update_status'),
      toolResult('2026-10-25T10:02:01.000Z', 'toolu_2', 'PreToolUse:mcp__plugin_tmb_trajectory-server__task_update_status hook error: BLOCKED: x', true),
    ]);
    assert.deepEqual(sweStopCause(payload(t), f.env), ALLOWED);
    assert.deepEqual(f.row(), { stop_cause: null, stop_detail: null });
  });

  it('ignores a deny from before the run window', () => {
    const f = fixture();
    const t = f.transcript([toolUse('2026-10-25T09:59:00.000Z', 'toolu_1', 'Bash'), toolResult('2026-10-25T09:59:01.000Z', 'toolu_1', DENY, true)]);
    assert.deepEqual(sweStopCause(payload(t), f.env), ALLOWED);
    assert.deepEqual(f.row(), { stop_cause: null, stop_detail: null });
  });

  describe('a completion report suppresses hook_block (GH 1914)', () => {
    const STATUS_TOOL = 'mcp__plugin_tmb_trajectory-server__task_update_status';
    const since = Date.parse(SINCE);
    const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');
    const deny = [toolUse('2026-10-25T10:05:00.000Z', 'toolu_d', 'Bash'), toolResult('2026-10-25T10:05:01.000Z', 'toolu_d', DENY, true)];
    const report = (ts: string, name: string, status: string, isError: boolean) => [
      toolUse(ts, 'toolu_r', name, { agent: 'swe', task_id: '3', status }),
      toolResult(ts.replace(/\.000Z$/, '.500Z'), 'toolu_r', isError ? 'Error: gate refused the close' : '{"ok":true}', isError),
    ];

    it('deny and no report: hook_block', () => {
      assert.equal(hookBlockDetail(jsonl(deny), since), DENY);
    });

    it('deny and a successful completed report: null', () => {
      assert.equal(hookBlockDetail(jsonl([...report('2026-10-25T10:01:00.000Z', STATUS_TOOL, 'completed', false), ...deny]), since), null);
      assert.equal(hookBlockDetail(jsonl([...deny, ...report('2026-10-25T10:06:00.000Z', 'task_update_status', 'completed', false)]), since), null);
    });

    it('deny and an errored completed report: hook_block', () => {
      assert.equal(hookBlockDetail(jsonl([...report('2026-10-25T10:01:00.000Z', STATUS_TOOL, 'completed', true), ...deny]), since), DENY);
    });

    it('deny and a failed report: hook_block', () => {
      assert.equal(hookBlockDetail(jsonl([...deny, ...report('2026-10-25T10:06:00.000Z', STATUS_TOOL, 'failed', false)]), since), DENY);
    });

    it('a completed report before TMB_STOP_SINCE does not count', () => {
      assert.equal(hookBlockDetail(jsonl([...report('2026-10-25T09:50:00.000Z', STATUS_TOOL, 'completed', false), ...deny]), since), DENY);
    });

    it('records NULL on the row when the run reported completion', () => {
      const f = fixture();
      f.exec("UPDATE agent_runs SET stop_cause = 'hook_block', stop_detail = 'stale' WHERE spawn_id = ?", SWE);
      const t = f.transcript([...deny, ...report('2026-10-25T10:06:00.000Z', STATUS_TOOL, 'completed', false)]);
      assert.deepEqual(sweStopCause(payload(t), f.env), ALLOWED);
      assert.deepEqual(f.row(), { stop_cause: null, stop_detail: null });
    });
  });

  it('exits 0 with empty stdout and writes nothing on a missing transcript or DB', () => {
    const f = fixture();
    f.exec("UPDATE agent_runs SET stop_cause = 'budget' WHERE spawn_id = ?", SWE);
    assert.deepEqual(sweStopCause(payload(join(f.root, 'missing.jsonl')), f.env), ALLOWED);
    assert.deepEqual(f.row(), { stop_cause: null, stop_detail: null });
    assert.deepEqual(sweStopCause(payload(''), { ...f.env, TRAJECTORY_DB_PATH: join(f.root, 'no.db') }), ALLOWED);
    assert.deepEqual(sweStopCause('not json', { ...f.env, TMB_STOP_SINCE: undefined }), ALLOWED);

    for (const env of [{ ...f.env, TRAJECTORY_DB_PATH: join(f.root, 'no.db') }, f.env]) {
      const r = spawnSync(process.execPath, [HOOKS_JS, 'swe-stop-cause'], {
        input: payload(join(f.root, 'missing.jsonl')),
        env,
        encoding: 'utf8',
      });
      assert.deepEqual([r.status, r.stdout], [0, '']);
    }
  });
});
