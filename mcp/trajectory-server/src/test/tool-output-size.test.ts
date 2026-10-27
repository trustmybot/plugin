/**
 * The tool-output-size recorder (GH 1957) on a temp trajectory DB and fixture
 * transcripts: exact per-tool calls, result_chars and est_tokens for string
 * and block-array results (image blocks count 0, an orphan result counts as
 * `unknown`, entries before TMB_STOP_SINCE are left out), an idempotent
 * re-fire, the swe / code-reviewer / bro run selection, and no write on a
 * missing or malformed transcript or a missing run row. It always exits 0 with
 * empty stdout.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { toolOutputSize, toolOutputSizes, UNKNOWN_TOOL } from '../hooks/tool-output-size.js';
import { gateNames } from '../hooks/registry.js';
import { broTurnUsage } from '../hooks/bro-turn-usage.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const HOOKS_JS = join(SERVER_ROOT, 'dist/hooks.js');
const ISSUE_ID = 9;
const TASK_ID = 3;
const SWE = 'agent-swe-1';
const REVIEWER = 'agent-cr-1';
const SESSION = 'sess-bro-1';
const SINCE = '2026-10-26T10:00:00.000Z';
const ALLOWED = { stdout: '', code: 0 };

interface OutputRow {
  tool_name: string;
  calls: number;
  result_chars: number;
  est_tokens: number;
}

interface Fixture {
  root: string;
  db: string;
  runs: { swe: number; reviewer: number; bro: number };
  rows(runId: number): OutputRow[];
  transcript(lines: unknown[], name?: string): string;
  sweEnv: NodeJS.ProcessEnv;
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
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', '2026-10-26T09:00:00.000Z', '2026-10-26T09:00:00.000Z')").run(ISSUE_ID);
  d.prepare(
    "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, 'feat/3-x', 'd', 'running', '2026-10-26T09:00:00.000Z', '2026-10-26T09:00:00.000Z')",
  ).run(TASK_ID, ISSUE_ID);
  const insert = d.prepare(
    'INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id, session_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const runs = {
    swe: Number(insert.run(TASK_ID, ISSUE_ID, 'swe', SINCE, SWE, null).lastInsertRowid),
    reviewer: Number(insert.run(TASK_ID, ISSUE_ID, 'code-reviewer', SINCE, REVIEWER, null).lastInsertRowid),
    bro: Number(insert.run(null, null, 'bro', '2026-10-26T08:00:00.000Z', null, SESSION).lastInsertRowid),
  };
  d.close();
  const rows = (runId: number) => {
    const r = new DatabaseSync(db);
    const out = r
      .prepare('SELECT tool_name, calls, result_chars, est_tokens FROM agent_run_tool_output WHERE run_id = ? ORDER BY tool_name')
      .all(runId) as unknown as OutputRow[];
    r.close();
    return out.map((o) => ({ ...o }));
  };
  const transcript = (lines: unknown[], name = 'agent.jsonl') => {
    const path = join(root, name);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return path;
  };
  const sweEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    TRAJECTORY_DB_PATH: db,
    TMB_STOP_AGENT_TYPE: 'swe',
    TMB_STOP_TASK_ID: String(TASK_ID),
    TMB_STOP_SPAWN_ID: SWE,
    TMB_STOP_SINCE: SINCE,
  };
  return { root, db, runs, rows, transcript, sweEnv };
}

const toolUse = (ts: string, id: string, name: string) => ({
  timestamp: ts,
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
});
const toolResult = (ts: string, id: string, content: unknown) => ({
  timestamp: ts,
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});

const agentPayload = (path: string, agent = SWE) => JSON.stringify({ agent_id: agent, agent_transcript_path: path });

// Read: 'x'.repeat(10) string + 7 chars of text blocks beside an image → 2 calls, 17 chars, 5 tokens.
// Bash: 'ok' → 1 call, 2 chars, 1 token. unknown: orphan of 5 chars → 1 call, 5 chars, 2 tokens.
// The pre-SINCE Bash result (100 chars) is left out; Grep's use is before SINCE, its result after.
const FIXTURE_LINES = [
  toolUse('2026-10-26T09:59:00.000Z', 'toolu_0', 'Bash'),
  toolResult('2026-10-26T09:59:01.000Z', 'toolu_0', 'y'.repeat(100)),
  toolUse('2026-10-26T09:59:30.000Z', 'toolu_g', 'Grep'),
  toolResult('2026-10-26T10:00:00.000Z', 'toolu_g', 'abc'),
  toolUse('2026-10-26T10:01:00.000Z', 'toolu_1', 'Read'),
  toolResult('2026-10-26T10:01:01.000Z', 'toolu_1', 'x'.repeat(10)),
  toolUse('2026-10-26T10:02:00.000Z', 'toolu_2', 'Read'),
  toolResult('2026-10-26T10:02:01.000Z', 'toolu_2', [
    { type: 'text', text: 'abcd' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5000) } },
    { type: 'text', text: 'efg' },
  ]),
  toolUse('2026-10-26T10:03:00.000Z', 'toolu_3', 'Bash'),
  toolResult('2026-10-26T10:03:01.000Z', 'toolu_3', 'ok'),
  toolResult('2026-10-26T10:04:01.000Z', 'toolu_missing', 'hello'),
  { timestamp: '2026-10-26T10:05:00.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
];

const EXPECTED: OutputRow[] = [
  { tool_name: 'Bash', calls: 1, result_chars: 2, est_tokens: 1 },
  { tool_name: 'Grep', calls: 1, result_chars: 3, est_tokens: 1 },
  { tool_name: 'Read', calls: 2, result_chars: 17, est_tokens: 5 },
  { tool_name: UNKNOWN_TOOL, calls: 1, result_chars: 5, est_tokens: 2 },
];

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tool-output-size-'));
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('tool-output-size (GH 1957)', () => {
  it('is a registered TS gate', () => {
    assert.ok(gateNames().includes('tool-output-size'));
  });

  it('parses exact per-tool totals: string and text-block results, images 0, orphans unknown, pre-since left out', () => {
    const text = FIXTURE_LINES.map((l) => JSON.stringify(l)).join('\n');
    assert.deepEqual(toolOutputSizes(text, Date.parse(SINCE)), EXPECTED);
    assert.deepEqual(
      toolOutputSizes(text, null)?.find((r) => r.tool_name === 'Bash'),
      { tool_name: 'Bash', calls: 2, result_chars: 102, est_tokens: 26 },
    );
  });

  it('writes the swe run rows, and a second fire leaves identical rows', () => {
    const f = fixture();
    const t = f.transcript(FIXTURE_LINES);
    assert.deepEqual(toolOutputSize(agentPayload(t), f.sweEnv), ALLOWED);
    const first = f.rows(f.runs.swe);
    assert.ok(first.length > 0);
    assert.deepEqual(first, [...EXPECTED].sort((a, b) => (a.tool_name < b.tool_name ? -1 : 1)));
    assert.deepEqual(toolOutputSize(agentPayload(t), f.sweEnv), ALLOWED);
    assert.deepEqual(f.rows(f.runs.swe), first);
    assert.deepEqual(f.rows(f.runs.reviewer), []);
    assert.deepEqual(f.rows(f.runs.bro), []);
  });

  it('a re-fire over a shorter window replaces the rows rather than adding to them', () => {
    const f = fixture();
    const t = f.transcript(FIXTURE_LINES);
    toolOutputSize(agentPayload(t), { ...f.sweEnv, TMB_STOP_SINCE: undefined });
    toolOutputSize(agentPayload(t), f.sweEnv);
    assert.deepEqual(f.rows(f.runs.swe).find((r) => r.tool_name === 'Bash'), EXPECTED[0]);
  });

  it('writes a code-reviewer run by its spawn_id', () => {
    const f = fixture();
    const t = f.transcript(FIXTURE_LINES);
    const env = { ...f.sweEnv, TMB_STOP_AGENT_TYPE: 'code-reviewer', TMB_STOP_SPAWN_ID: REVIEWER, TMB_STOP_SINCE: undefined };
    assert.deepEqual(toolOutputSize(agentPayload(t, REVIEWER), env), ALLOWED);
    assert.equal(f.rows(f.runs.reviewer).length, 4);
    assert.deepEqual(f.rows(f.runs.swe), []);
  });

  it('writes the bro session row from transcript_path over the whole session', () => {
    const f = fixture();
    const t = f.transcript(FIXTURE_LINES, 'session.jsonl');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: join(f.root, 'home'),
      TRAJECTORY_DB_PATH: f.db,
      TMB_STOP_AGENT_TYPE: 'bro',
      TMB_STOP_SESSION_ID: SESSION,
      TMB_STOP_SINCE: SINCE,
    };
    assert.deepEqual(toolOutputSize(JSON.stringify({ session_id: SESSION, transcript_path: t }), env), ALLOWED);
    assert.deepEqual(f.rows(f.runs.bro).find((r) => r.tool_name === 'Bash'), { tool_name: 'Bash', calls: 2, result_chars: 102, est_tokens: 26 });
    assert.deepEqual(f.rows(f.runs.swe), []);
  });

  it('the TypeScript bro-turn-usage gate records the session row after its write', () => {
    const f = fixture();
    const usage = {
      timestamp: '2026-10-26T10:06:00.000Z',
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: 'hi' }],
      },
    };
    const t = f.transcript([...FIXTURE_LINES, usage], 'session.jsonl');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(f.root, 'home'), TRAJECTORY_DB_PATH: f.db };
    const payload = JSON.stringify({ session_id: SESSION, transcript_path: t });
    assert.deepEqual(broTurnUsage(payload, env), ALLOWED);
    const rows = f.rows(f.runs.bro);
    assert.ok(rows.length > 0);
    assert.deepEqual(rows.find((r) => r.tool_name === 'Bash'), { tool_name: 'Bash', calls: 2, result_chars: 102, est_tokens: 26 });
    assert.deepEqual(broTurnUsage(payload, env), ALLOWED);
    assert.deepEqual(f.rows(f.runs.bro), rows);
    assert.deepEqual(f.rows(f.runs.swe), []);
  });

  it('writes nothing and exits 0 with empty stdout on a missing or malformed transcript or a missing run row', () => {
    const f = fixture();
    const t = f.transcript(FIXTURE_LINES);
    toolOutputSize(agentPayload(t), f.sweEnv);
    const seeded = f.rows(f.runs.swe);
    const malformed = join(f.root, 'malformed.jsonl');
    writeFileSync(malformed, 'not json\n{"truncated":\n');
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      [agentPayload(join(f.root, 'missing.jsonl')), f.sweEnv],
      [agentPayload(malformed), f.sweEnv],
      [agentPayload(''), f.sweEnv],
      ['not json', f.sweEnv],
      [agentPayload(t), { ...f.sweEnv, TMB_STOP_SPAWN_ID: 'agent-nobody' }],
      [agentPayload(t), { ...f.sweEnv, TMB_STOP_TASK_ID: '999' }],
      [agentPayload(t), { ...f.sweEnv, TMB_STOP_AGENT_TYPE: 'consultant' }],
      [agentPayload(t), { ...f.sweEnv, TMB_STOP_SINCE: 'yesterday' }],
      [agentPayload(t), { ...f.sweEnv, TRAJECTORY_DB_PATH: join(f.root, 'no.db') }],
    ];
    for (const [payload, env] of cases) {
      assert.deepEqual(toolOutputSize(payload, env), ALLOWED);
      const r = spawnSync(process.execPath, [HOOKS_JS, 'tool-output-size'], { input: payload, env, encoding: 'utf8' });
      assert.deepEqual([r.status, r.stdout], [0, '']);
    }
    assert.deepEqual(f.rows(f.runs.swe), seeded);
  });

  it('meters a 1,000-call transcript in under 50 ms per call through node dist/hooks.js', () => {
    const f = fixture();
    const calls = 1000;
    const lines: unknown[] = [];
    for (let i = 0; i < calls; i++) {
      lines.push(toolUse('2026-10-26T10:10:00.000Z', `toolu_${i}`, i % 3 === 0 ? 'Read' : 'Bash'));
      lines.push(toolResult('2026-10-26T10:10:01.000Z', `toolu_${i}`, 'r'.repeat(400)));
    }
    const t = f.transcript(lines);
    const start = performance.now();
    const r = spawnSync(process.execPath, [HOOKS_JS, 'tool-output-size'], { input: agentPayload(t), env: f.sweEnv, encoding: 'utf8' });
    const perCallMs = (performance.now() - start) / calls;
    assert.deepEqual([r.status, r.stdout], [0, '']);
    assert.deepEqual(
      f.rows(f.runs.swe).map((o) => [o.tool_name, o.calls]),
      [['Bash', 666], ['Read', 334]],
    );
    assert.ok(perCallMs < 50, `recorder overhead ${perCallMs.toFixed(3)} ms per call`);
  });
});
