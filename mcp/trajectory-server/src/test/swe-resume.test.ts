/**
 * A swe resumed through SendMessage (GH 1742) on a temp project DB:
 * swe-brief-gate.sh records the resume at its task_brief, task_brief's
 * openSweRun opens a row chained to its previous one by resumed_from,
 * swe-atomic-close.sh meters only the transcript entries from that row's
 * started_at on, and task_stats splits the reworks into fresh and resumed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrajectoryDB } from '../db.js';
import { compositeTools } from '../tools/composites.js';
import { statsTools } from '../tools/stats.js';
import { tempDB } from './helpers.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(SERVER_ROOT, '../..');
const BRIEF_GATE = join(PLUGIN_ROOT, 'scripts/hooks/swe-brief-gate.sh');
const ATOMIC_CLOSE = join(PLUGIN_ROOT, 'scripts/hooks/swe-atomic-close.sh');
const ISSUE_ID = 9;
const TASK_ID = 3;
const FRESH_TASK_ID = 4;
const SWE = 'agent-swe-1';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<unknown>;

interface RunRow {
  id: number;
  spawn_id: string | null;
  effort: string | null;
  resumed_from: number | null;
  started_at: string;
  completed_at: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
  tool_uses: number | null;
  duration_ms: number | null;
}

let sandbox: string;
let seq = 0;

interface Project {
  root: string;
  dbPath: string;
  env: NodeJS.ProcessEnv;
}

function project(): Project {
  seq += 1;
  const root = join(sandbox, `case-${seq}`);
  const dbPath = join(root, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new TrajectoryDB(dbPath);
  db.run("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')", [ISSUE_ID]);
  for (const id of [TASK_ID, FRESH_TASK_ID]) {
    db.run(
      "INSERT INTO tasks (id, issue_id, branch_id, description, status, effort, created_at, updated_at) VALUES (?, ?, ?, 'd', 'running', 'high', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')",
      [id, ISSUE_ID, `feat/${id}-x`],
    );
  }
  db.run(
    `INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, completed_at, spawn_id, effort, exit_reason,
                             tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, usage_source)
     VALUES (1, ?, ?, 'swe', '2026-10-25T09:05:00.000Z', '2026-10-25T09:50:00.000Z', ?, 'high', 'completed',
             700, 70, 7000, 0, 7, 2700000, 'subagent_stop')`,
    [TASK_ID, ISSUE_ID, SWE],
  );
  db.close();
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, 'home'), CLAUDE_PROJECT_DIR: root, TRAJECTORY_DB_PATH: dbPath };
  return { root, dbPath, env };
}

function hook(p: Project, script: string, payload: Record<string, unknown>) {
  const r = spawnSync('bash', [script], { cwd: p.root, input: JSON.stringify(payload), env: p.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const briefPayload = (agentId: string, taskId: number) => ({
  hook_event_name: 'PreToolUse',
  agent_type: 'tmb:swe',
  agent_id: agentId,
  tool_name: 'mcp__plugin_tmb_trajectory-server__task_brief',
  tool_input: { agent: 'swe', task_id: taskId },
});

async function taskBrief(p: Project, taskId: number): Promise<void> {
  const db = new TrajectoryDB(p.dbPath);
  try {
    const handler = compositeTools(db, p.dbPath, null).handlers['task_brief'] as Handler;
    const r = (await handler({ agent: 'swe', task_id: taskId })) as RawResult;
    assert.notEqual(r.isError, true, r.content[0].text);
  } finally {
    db.close();
  }
}

function sweRows(p: Project, taskId: number): RunRow[] {
  const db = new TrajectoryDB(p.dbPath);
  try {
    return db.all<RunRow>(
      `SELECT id, spawn_id, effort, resumed_from, started_at, completed_at, tokens_in, tokens_out, cache_read_tokens, tool_uses, duration_ms
         FROM agent_runs WHERE task_id = ? AND agent_type = 'swe' ORDER BY id`,
      [taskId],
    ).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function observations(p: Project): Array<{ agent_id: string; consumed: number }> {
  const db = new TrajectoryDB(p.dbPath);
  try {
    return db.all<{ agent_id: string; consumed: number }>(
      `SELECT json_extract(content_json, '$.agent_id') AS agent_id, json_extract(content_json, '$.consumed') AS consumed
         FROM audit WHERE event_type = 'swe_resume_observed' ORDER BY id`,
    ).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

const shifted = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

describe('swe resumed through SendMessage (GH 1742)', () => {
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-swe-resume-'));
  });
  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('task_brief of a resumed swe opens a row chained to its previous row; a second task_brief opens none', async () => {
    const p = project();
    assert.equal(hook(p, BRIEF_GATE, briefPayload(SWE, TASK_ID)), '');
    assert.deepEqual(observations(p), [{ agent_id: SWE, consumed: 0 }]);
    assert.equal(sweRows(p, TASK_ID)[0].completed_at, '2026-10-25T09:50:00.000Z', 'the previous row stays closed');

    await taskBrief(p, TASK_ID);
    const [previous, resumed] = sweRows(p, TASK_ID);
    assert.equal(resumed.resumed_from, previous.id);
    assert.equal(resumed.spawn_id, SWE);
    assert.equal(resumed.effort, 'high');
    assert.equal(resumed.completed_at, null);
    assert.deepEqual(observations(p), [{ agent_id: SWE, consumed: 1 }]);

    assert.equal(hook(p, BRIEF_GATE, briefPayload(SWE, TASK_ID)), '');
    await taskBrief(p, TASK_ID);
    assert.equal(sweRows(p, TASK_ID).length, 2);
    assert.deepEqual(observations(p), [{ agent_id: SWE, consumed: 1 }]);
  });

  it("a fresh spawn's row has resumed_from NULL and is bound to its agent id", async () => {
    const p = project();
    assert.equal(hook(p, BRIEF_GATE, briefPayload('agent-fresh', FRESH_TASK_ID)), '');
    await taskBrief(p, FRESH_TASK_ID);
    assert.equal(hook(p, BRIEF_GATE, briefPayload('agent-fresh', FRESH_TASK_ID)), '');
    const rows = sweRows(p, FRESH_TASK_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].resumed_from, null);
    assert.equal(rows[0].spawn_id, 'agent-fresh');
    assert.deepEqual(observations(p), []);
  });

  it('an observation older than the TTL or for another task is not consumed', async () => {
    const p = project();
    const db = new TrajectoryDB(p.dbPath);
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (?, 'hook:swe-brief-gate', 'swe_resume_observed', 's', json_object('task_id', ?, 'agent_id', ?, 'observed_at', '2026-01-01T00:00:00.000Z', 'consumed', 0), '2026-01-01T00:00:00.000Z'),
              (?, 'hook:swe-brief-gate', 'swe_resume_observed', 's', json_object('task_id', ?, 'agent_id', ?, 'observed_at', ?, 'consumed', 0), ?)`,
      [ISSUE_ID, TASK_ID, SWE, ISSUE_ID, FRESH_TASK_ID, SWE, new Date().toISOString(), new Date().toISOString()],
    );
    db.close();
    await taskBrief(p, TASK_ID);
    const [, opened] = sweRows(p, TASK_ID);
    assert.equal(opened.resumed_from, null);
    assert.equal(opened.spawn_id, null);
    assert.deepEqual(observations(p).map((o) => o.consumed), [0, 0]);
  });

  it('the resumed run meters only the transcript entries from its started_at on', async () => {
    const p = project();
    hook(p, BRIEF_GATE, briefPayload(SWE, TASK_ID));
    await taskBrief(p, TASK_ID);
    const startedAt = sweRows(p, TASK_ID)[1].started_at;
    const transcript = join(p.root, 'agent-swe-1.jsonl');
    const line = (ms: number, id: string, usage: Record<string, number>, toolUses = 0) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: shifted(startedAt, ms),
        message: { id, model: 'claude-opus-5-5', usage, content: Array.from({ length: toolUses }, () => ({ type: 'tool_use', name: 'Read' })) },
      });
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', timestamp: shifted(startedAt, -3_600_000), message: { role: 'user', content: `task_id=${TASK_ID} You are swe.` } }),
        line(-3_590_000, 'old-1', { input_tokens: 700, output_tokens: 70, cache_read_input_tokens: 7000 }, 7),
        JSON.stringify({ type: 'user', timestamp: shifted(startedAt, -1_000), message: { role: 'user', content: 'fix the FAIL findings' } }),
        line(1_000, 'new-1', { input_tokens: 30, output_tokens: 3, cache_read_input_tokens: 300 }, 2),
        line(5_000, 'new-2', { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 200 }, 1),
      ].join('\n') + '\n',
    );

    hook(p, ATOMIC_CLOSE, {
      hook_event_name: 'SubagentStop',
      agent_type: 'tmb:swe',
      agent_id: SWE,
      session_id: 'sess-1',
      agent_transcript_path: transcript,
    });

    const [previous, resumed] = sweRows(p, TASK_ID);
    assert.deepEqual(
      { tokens_in: resumed.tokens_in, tokens_out: resumed.tokens_out, cache_read_tokens: resumed.cache_read_tokens, tool_uses: resumed.tool_uses, duration_ms: resumed.duration_ms },
      { tokens_in: 50, tokens_out: 5, cache_read_tokens: 500, tool_uses: 3, duration_ms: 4_000 },
    );
    assert.equal(resumed.started_at, startedAt);
    assert.notEqual(resumed.completed_at, null);
    assert.deepEqual(
      { tokens_in: previous.tokens_in, tool_uses: previous.tool_uses, completed_at: previous.completed_at },
      { tokens_in: 700, tool_uses: 7, completed_at: '2026-10-25T09:50:00.000Z' },
    );

    const db = new TrajectoryDB(p.dbPath);
    try {
      const stats = JSON.parse(((await (statsTools(db).handlers['task_stats'] as Handler)({ agent: 'bro', task_id: TASK_ID })) as RawResult).content[0].text);
      assert.deepEqual(stats.reworks, {
        fresh: { count: 0, wall_clock_ms: 0, tool_uses: 0, cache_read_tokens: 0 },
        resumed: { count: 1, wall_clock_ms: 4_000, tool_uses: 3, cache_read_tokens: 500 },
      });
    } finally {
      db.close();
    }
  });

  it('task_stats splits reworks into fresh spawns after the first and resumed runs, skipping swept orphans', async () => {
    const db = tempDB();
    db.run("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')");
    db.run("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (5, 1, 'feat/5-x', 'd', 'running', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')");
    const run = (id: number, spawn: string, duration: number, tools: number, cacheRead: number, resumedFrom: number | null, exit = 'completed') =>
      db.run(
        `INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, completed_at, spawn_id, exit_reason, duration_ms, tool_uses, cache_read_tokens, resumed_from)
         VALUES (?, 5, 1, 'swe', '2026-10-25T10:00:00.000Z', '2026-10-25T10:30:00.000Z', ?, ?, ?, ?, ?, ?)`,
        [id, spawn, exit, duration, tools, cacheRead, resumedFrom],
      );
    run(1, 'agent-a', 1_000, 10, 100, null);
    run(2, 'agent-a', 2_000, 20, 200, 1);
    run(3, 'agent-b', 3_000, 30, 300, null);
    run(4, 'agent-b', 4_000, 40, 400, 3);
    run(5, 'tool_use:x', 0, 0, 0, null, 'swept_orphan');
    run(6, 'agent-c', 5_000, 50, 500, null);
    db.run("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id, duration_ms) VALUES (5, 1, 'code-reviewer', '2026-10-25T10:40:00.000Z', 'agent-r', 9000)");
    const stats = JSON.parse(((await (statsTools(db).handlers['task_stats'] as Handler)({ agent: 'bro', task_id: 5 })) as RawResult).content[0].text);
    assert.equal(stats.swe_spawn_count, 5);
    assert.equal(stats.rework_count, 4);
    assert.deepEqual(stats.reworks, {
      fresh: { count: 2, wall_clock_ms: 8_000, tool_uses: 80, cache_read_tokens: 800 },
      resumed: { count: 2, wall_clock_ms: 6_000, tool_uses: 60, cache_read_tokens: 600 },
    });
    db.close();
  });
});
