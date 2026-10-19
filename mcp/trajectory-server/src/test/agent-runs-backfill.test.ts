import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import {
  agentRunsBackfillTools,
  defaultTranscriptsDir,
  spawnStats,
  taskIdFromTranscript,
} from '../tools/agent-runs-backfill.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SESSION = 'sess-0001';
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const OPUS = 'claude-opus-5-5';

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function assistant(id: string, ts: string, usage: number[], content: unknown[], extra: Record<string, unknown> = {}): unknown {
  const [input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens] = usage;
  return {
    type: 'assistant',
    timestamp: ts,
    ...extra,
    message: {
      id,
      model: OPUS,
      role: 'assistant',
      content,
      usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens },
    },
  };
}

function seedIssue(db: TrajectoryDB): number {
  db.run(`INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('backfill', 'open', ?, ?)`, [at(-7200), at(-7200)]);
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
}

function seedTask(db: TrajectoryDB, issueId: number, branch: string, repo: string | null): number {
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, description, status, repo, created_at, updated_at)
     VALUES (?, ?, 'd', 'closed', ?, ?, ?)`,
    [issueId, branch, repo, at(-7200), at(-7200)],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
}

interface Fixture {
  db: TrajectoryDB;
  dir: string;
  t1: number;
  t2: number;
  t3: number;
  sweOpenRow: number;
  measuredSweRow: number;
  broNullRow: number;
  broMeasuredRow: number;
}

function buildFixture(root: string): Fixture {
  const db = tempDB();
  db.run(`INSERT INTO repos (name, path) VALUES ('app', '/work/app')`);
  const issue = seedIssue(db);
  const t1 = seedTask(db, issue, 'feat/string-prompt', 'app');
  const t2 = seedTask(db, issue, 'feat/block-prompt', 'app');
  const t3 = seedTask(db, issue, 'feat/measured', 'app');

  // T1: the swe row task_brief opened inside the spawn, never measured.
  db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, ?, 'swe', ?)`, [t1, issue, at(11.5)]);
  const sweOpenRow = db.get<{ id: number }>('SELECT MAX(id) AS id FROM agent_runs')!.id;
  // T3: already measured by SubagentStop under the spawn's agent id.
  db.run(
    `INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens,
                             started_at, completed_at, spawn_id, usage_source)
     VALUES (?, ?, 'swe', 7, 7, 7, 7, ?, ?, 'ddd', 'subagent_stop')`,
    [t3, issue, at(30), at(40)],
  );
  const measuredSweRow = db.get<{ id: number }>('SELECT MAX(id) AS id FROM agent_runs')!.id;
  // Legacy per-task bro rows: T1's never measured, T2's measured earlier in the session. Backfill leaves both alone.
  db.run(
    `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, usage_source)
     VALUES (?, ?, 'bro', ?, ?, 'unmeasured')`,
    [t1, issue, at(0), at(60)],
  );
  const broNullRow = db.get<{ id: number }>('SELECT MAX(id) AS id FROM agent_runs')!.id;
  db.run(
    `INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens,
                             started_at, completed_at, session_id, usage_source)
     VALUES (?, ?, 'bro', 500, 0, 0, 0, ?, ?, ?, 'transcript')`,
    [t2, issue, at(-3600), at(-1800), SESSION],
  );
  const broMeasuredRow = db.get<{ id: number }>('SELECT MAX(id) AS id FROM agent_runs')!.id;

  const dir = join(root, 'projects', 'slug');
  const sub = join(dir, SESSION, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    jsonl([
      { type: 'summary', summary: 'no timestamp' },
      { type: 'user', timestamp: at(0), message: { role: 'user', content: '@bro do things' } },
      assistant('m1', at(10), [10, 20, 100, 5], [{ type: 'text', text: 'spawning' }]),
      assistant('m1', at(10.2), [10, 20, 100, 5], [
        { type: 'tool_use', id: 'toolu_b', name: 'Agent', input: { subagent_type: 'tmb:pr-reviewer', prompt: 'x' } },
      ]),
      {
        type: 'user',
        timestamp: at(26),
        toolUseResult: { agentId: 'bbb' },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'done' }] },
      },
      assistant('side', at(27), [9999, 9999, 9999, 9999], [], { isSidechain: true }),
      assistant('m2', at(28), [1, 2, 3, 4], [{ type: 'text', text: 'ok' }]),
    ]),
  );
  writeFileSync(
    join(sub, 'agent-aaa.jsonl'),
    jsonl([
      { type: 'user', isSidechain: true, timestamp: at(11), message: { role: 'user', content: `Execute task_id=${t1} now` } },
      assistant('a1', at(12), [100, 50, 1000, 200], [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], { isSidechain: true }),
      assistant('a1', at(12.5), [100, 50, 1000, 200], [{ type: 'text', text: 'x' }], { isSidechain: true }),
      {
        type: 'assistant',
        isSidechain: true,
        timestamp: at(15),
        message: { id: 'a2', model: 'claude-haiku', content: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } },
      },
    ]),
  );
  writeFileSync(join(sub, 'agent-aaa.meta.json'), JSON.stringify({ agentType: 'tmb:swe' }));
  writeFileSync(
    join(sub, 'agent-bbb.jsonl'),
    jsonl([
      { type: 'user', isSidechain: true, timestamp: at(21), message: { role: 'user', content: [{ type: 'text', text: `Review\ntask_id=${t2} please` }] } },
      assistant('b1', at(25), [3, 4, 5, 6], [], { isSidechain: true }),
    ]),
  );
  writeFileSync(
    join(sub, 'agent-ccc.jsonl'),
    jsonl([
      { type: 'user', isSidechain: true, timestamp: at(40), message: { role: 'user', content: 'no task here' } },
      assistant('c1', at(41), [1, 1, 1, 1], [], { isSidechain: true }),
    ]),
  );
  writeFileSync(join(sub, 'agent-ccc.meta.json'), JSON.stringify({ agentType: 'tmb:swe' }));
  writeFileSync(
    join(sub, 'agent-ddd.jsonl'),
    jsonl([
      { type: 'user', isSidechain: true, timestamp: at(30), message: { role: 'user', content: `task_id=${t3}` } },
      assistant('d1', at(39), [50, 50, 50, 50], [], { isSidechain: true }),
    ]),
  );
  writeFileSync(join(sub, 'agent-ddd.meta.json'), JSON.stringify({ agentType: 'swe' }));
  return { db, dir, t1, t2, t3, sweOpenRow, measuredSweRow, broNullRow, broMeasuredRow };
}

async function run(db: TrajectoryDB, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = (await agentRunsBackfillTools(db, ':memory:').handlers['agent_runs_backfill']!(args)) as RawResult;
  const body = JSON.parse(res.content[0]!.text) as Record<string, any>;
  assert.ok(!res.isError, JSON.stringify(body));
  return body;
}

function snapshot(db: TrajectoryDB): string {
  return JSON.stringify([
    db.all('SELECT * FROM agent_runs ORDER BY id'),
    db.get('SELECT COUNT(*) AS n FROM audit'),
  ]);
}

describe('agent_runs_backfill', () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'tmb-backfill-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is bro only', async () => {
    const { db, dir } = buildFixture(mkdtempSync(join(root, 'role-')));
    const h = agentRunsBackfillTools(db, ':memory:').handlers['agent_runs_backfill']!;
    for (const agent of ['swe', 'pr-reviewer', 'architect']) {
      const res = (await h({ agent, transcripts_dir: dir })) as RawResult;
      assert.equal(res.isError, true);
      assert.equal(JSON.parse(res.content[0]!.text).error, 'forbidden');
    }
    db.close();
  });

  it('dry run reports bound/unbound and the would-be writes, and writes nothing', async () => {
    const { db, dir } = buildFixture(mkdtempSync(join(root, 'dry-')));
    const before = snapshot(db);
    const r = await run(db, { agent: 'bro', transcripts_dir: dir });
    assert.equal(r['dry_run'], true);
    assert.equal(r['transcripts_seen'], 4);
    assert.equal(r['bound'], 3);
    assert.equal(r['unbound'].count, 1);
    assert.match(r['unbound'].first[0].path, /agent-ccc\.jsonl$/);
    assert.match(r['unbound'].first[0].reason, /no task_id/);
    assert.equal(r['rows_inserted'], 1);
    assert.equal(r['rows_updated'], 1);
    assert.equal(r['rows_skipped_measured'], 1);
    assert.equal(snapshot(db), before);
    db.close();
  });

  it('real run fills swe/pr-reviewer rows labelled backfill, leaves measured and bro rows, writes one audit row, and is idempotent', async () => {
    const f = buildFixture(mkdtempSync(join(root, 'real-')));
    const { db } = f;
    const untouched = () =>
      JSON.stringify(
        db.all('SELECT * FROM agent_runs WHERE id IN (?, ?, ?) ORDER BY id', [f.measuredSweRow, f.broNullRow, f.broMeasuredRow]),
      );
    const untouchedBefore = untouched();
    const r = await run(db, { agent: 'bro', transcripts_dir: f.dir, dry_run: false });
    assert.equal(r['rows_inserted'], 1);
    assert.equal(r['rows_updated'], 1);
    assert.equal(r['tokens_total_added'], 1354 + 18);

    const swe = db.get<Record<string, unknown>>('SELECT * FROM agent_runs WHERE id = ?', [f.sweOpenRow])!;
    assert.equal(swe['usage_source'], 'backfill');
    assert.deepEqual(
      [swe['tokens_in'], swe['tokens_out'], swe['cache_read_tokens'], swe['cache_creation_tokens'], swe['tool_uses'], swe['duration_ms']],
      [101, 51, 1001, 201, 1, 4000],
    );
    assert.equal(swe['started_at'], at(11.5));
    assert.equal(swe['completed_at'], at(15));
    assert.equal(swe['spawn_id'], join(f.dir, SESSION, 'subagents', 'agent-aaa.jsonl'));
    assert.equal(swe['session_id'], SESSION);
    assert.equal(swe['model'], OPUS);
    assert.equal(swe['host'], 'claude');
    assert.equal(swe['root_dir'], '/work/app/.claude/worktrees/string-prompt');

    const reviewer = db.get<Record<string, unknown>>(`SELECT * FROM agent_runs WHERE task_id = ? AND agent_type = 'pr-reviewer'`, [f.t2])!;
    assert.equal(reviewer['usage_source'], 'backfill');
    assert.equal(reviewer['started_at'], at(21));
    assert.equal(reviewer['completed_at'], at(25));
    assert.equal(reviewer['tokens_in'], 3);

    assert.equal(untouched(), untouchedBefore);
    assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM agent_runs WHERE agent_type = 'bro'`)!.c, 2, 'no bro row inserted');
    const audits = db.all<{ issue_id: number; content_json: string }>(
      `SELECT issue_id, content_json FROM audit WHERE event_type = 'agent_runs_backfilled'`,
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.issue_id, -1);
    assert.equal(JSON.parse(audits[0]!.content_json).rows_inserted, 1);

    const again = await run(db, { agent: 'bro', transcripts_dir: f.dir, dry_run: false });
    assert.equal(again['rows_inserted'], 0);
    assert.equal(again['rows_updated'], 0);
    assert.equal(again['tokens_total_added'], 0);
    db.close();
  });

  it('since skips transcripts whose last message is older', async () => {
    const { db, dir } = buildFixture(mkdtempSync(join(root, 'since-')));
    const r = await run(db, { agent: 'bro', transcripts_dir: dir, since: at(3600) });
    assert.equal(r['transcripts_seen'], 0);
    assert.equal(r['sessions_seen'], 0);
    assert.equal(r['rows_inserted'] + r['rows_updated'], 0);
    db.close();
  });

  it('derives ~/.claude/projects/<slug> from the project path', () => {
    const prev = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = '/cfg';
    try {
      assert.equal(defaultTranscriptsDir('/Users/me/Git/My_App.v2'), '/cfg/projects/-Users-me-Git-My-App-v2');
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = prev;
    }
  });
});

function haveJq(): boolean {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('agent_runs_backfill parity with the hooks', { skip: !haveJq() && 'jq not installed' }, () => {
  let root: string;
  let fixture: Fixture;
  let files: string[];
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'tmb-backfill-parity-'));
    fixture = buildFixture(root);
    const sub = join(fixture.dir, SESSION, 'subagents');
    files = [
      ...['aaa', 'bbb', 'ccc', 'ddd'].map((a) => join(sub, `agent-${a}.jsonl`)),
      join(fixture.dir, `${SESSION}.jsonl`),
    ];
    const extra = join(root, 'edge');
    mkdirSync(extra);
    const edges: Record<string, string> = {
      'nested-block.jsonl': jsonl([{ message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'see my_task_id=0042 x' }] }] } }]),
      'second-line.jsonl': jsonl([{ message: { content: 'none' } }, { message: null }, { message: { content: 'task_id=9 then task_id=10' } }]),
      'bad-line.jsonl': '{"message":{"content":"x"}}\nnot json\n{"message":{"content":"task_id=5"}}\n',
      'empty.jsonl': '',
    };
    for (const [name, body] of Object.entries(edges)) {
      writeFileSync(join(extra, name), body);
      files.push(join(extra, name));
    }
    files.push(join(extra, 'missing.jsonl'));
  });
  after(() => {
    fixture.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('taskIdFromTranscript matches tmb_task_id_from_transcript', () => {
    const lib = join(PLUGIN_ROOT, 'scripts', 'hooks', 'lib', 'query-task.sh');
    for (const f of files) {
      const shell = execFileSync('bash', ['-c', '. "$1"; tmb_task_id_from_transcript "$2"', '_', lib, f]).toString().trim();
      const ts = taskIdFromTranscript(f);
      assert.equal(ts === null ? '' : String(ts), shell === '' ? '' : String(Number(shell)), f);
    }
  });

  it('spawnStats matches the SubagentStop hook tmb_parse_transcript_stats', () => {
    const hook = join(PLUGIN_ROOT, 'scripts', 'hooks', 'swe-atomic-close.sh');
    const script = `eval "$(sed -n '/^tmb_parse_transcript_stats() {/,/^}/p' "$1")"; tmb_parse_transcript_stats "$2"`;
    for (const f of files.slice(0, 4)) {
      const shell = execFileSync('bash', ['-c', script, '_', hook, f]).toString().trim();
      const s = spawnStats(
        readFileSync(f, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      );
      assert.equal([s.ti, s.to, s.tool_uses, s.duration_ms, s.cr, s.cc, s.first_ts ?? '', s.model ?? ''].join('|'), shell, f);
    }
  });
});
