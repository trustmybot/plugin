/**
 * Lane issue membership (GH 3020): the v72 -> v73 migration that backfills
 * lanes and lane_issues, the lane-membership PostToolUse gate that records the
 * issues a session's lane owns, and the compaction restore in session-handoff
 * that lists every open issue of the lane.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TrajectoryDB } from '../db.js';
import { laneMembership } from '../hooks/lane-membership.js';
import { sessionHandoff, withHandoff } from '../hooks/session-handoff.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(SERVER_ROOT, '../..');
const HOOKS_BUNDLE = join(SERVER_ROOT, 'dist/hooks.js');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const SESSION = 'sess-lane-owner';
const OTHER_SESSION = 'sess-lane-other';
const ROW_TIME = '2026-11-16T10:00:00.000Z';
const CONTEXT = 'persona context';
const HOOK_CONTEXT_CAP = 10_000;
const LANE_ISSUE_LIMIT = 30;

interface LaneIssueRow {
  session_id: string;
  issue_id: number;
}

let sandbox: string;
let seq = 0;

function caseDir(): string {
  seq += 1;
  const dir = join(sandbox, `case-${seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withDb<T>(db: string, fn: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(db);
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

/** A DB from schema.sql holding the given open and closed issues. */
function freshDb(open: readonly number[], closed: readonly number[] = []): { db: string; env: NodeJS.ProcessEnv } {
  const db = join(caseDir(), 'trajectory.db');
  withDb(db, (d) => {
    d.exec(SCHEMA);
    const insert = d.prepare('INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const id of open) insert.run(id, `open issue ${id}`, 'open', ROW_TIME, ROW_TIME);
    for (const id of closed) insert.run(id, `closed issue ${id}`, 'closed', ROW_TIME, ROW_TIME);
  });
  return { db, env: { PATH: process.env.PATH, HOME: join(sandbox, 'home'), TRAJECTORY_DB_PATH: db } };
}

function laneRows(db: string): LaneIssueRow[] {
  return withDb(
    db,
    (d) =>
      d
        .prepare('SELECT l.session_id, li.issue_id FROM lane_issues li JOIN lanes l ON l.id = li.lane_id ORDER BY l.session_id, li.issue_id')
        .all()
        .map((r) => ({ ...(r as unknown as LaneIssueRow) })),
  );
}

function count(db: string, table: string): number {
  return withDb(db, (d) => (d.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function task(db: string, id: number, issue: number, status: string): void {
  withDb(db, (d) => {
    d.prepare('INSERT INTO tasks (id, issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, issue, `feat/${id}-x`, `task ${id}`, 'd', status, ROW_TIME, ROW_TIME);
  });
}

const toolName = (name: string): string => `mcp__plugin_tmb_trajectory-server__${name}`;
const textResult = (body: unknown): object => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });

function postToolUse(name: string, toolInput: object, toolResponse: unknown, extra: object = {}): string {
  return JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SESSION, cwd: '/work/project', tool_name: toolName(name), tool_input: toolInput, tool_response: toolResponse, ...extra });
}

function gate(payload: string, env: NodeJS.ProcessEnv): { stdout: string; code: number } {
  const r = laneMembership(payload, env);
  return { stdout: r.stdout ?? '', code: r.code ?? 0 };
}

function bundle(args: string[], input: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOKS_BUNDLE, ...args], { env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout }));
    child.stdin.end(input);
  });
}

/** A compacted bro session whose handoff the next compact SessionStart consumes. */
function compacted(db: string, env: NodeJS.ProcessEnv, session = SESSION): void {
  withDb(db, (d) => {
    d.prepare("INSERT INTO agent_runs (agent_type, session_id, started_at, completed_at) VALUES ('bro', ?, ?, ?)").run(session, ROW_TIME, ROW_TIME);
  });
  sessionHandoff(JSON.stringify({ hook_event_name: 'PreCompact', session_id: session, cwd: '/work/project', transcript_path: '/nonexistent', trigger: 'auto', custom_instructions: '' }), env);
}

function restore(env: NodeJS.ProcessEnv, context = CONTEXT, session = SESSION): string {
  return withHandoff(context, JSON.stringify({ hook_event_name: 'SessionStart', session_id: session, cwd: '/work/project', source: 'compact' }), env);
}

function own(db: string, session: string, issues: readonly number[]): void {
  withDb(db, (d) => {
    d.prepare('INSERT INTO lanes (session_id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT (session_id) DO NOTHING').run(session, ROW_TIME, ROW_TIME);
    const insert = d.prepare('INSERT INTO lane_issues (lane_id, issue_id, added_at) SELECT id, ?, ? FROM lanes WHERE session_id = ?');
    for (const issue of issues) insert.run(issue, ROW_TIME, session);
  });
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tmb-lane-membership-'));
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

describe('the v72 -> v73 migration backfills lanes and lane_issues (GH 3020)', () => {
  /** A migrated DB set back to v72: no lane tables, plus the handoff and agent_runs rows given. */
  function v72Db(seed: string): string {
    const db = join(caseDir(), 'trajectory.db');
    new TrajectoryDB(db, undefined, { migrate: true }).close();
    withDb(db, (d) => {
      d.exec(`
        INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES
          (601, 'handoff issue', 'open', '${ROW_TIME}', '${ROW_TIME}'),
          (602, 'run issue', 'open', '${ROW_TIME}', '${ROW_TIME}'),
          (603, 'closed run issue', 'closed', '${ROW_TIME}', '${ROW_TIME}'),
          (604, 'non-bro session issue', 'open', '${ROW_TIME}', '${ROW_TIME}');
        ${seed}
        DROP TABLE lane_issues;
        DROP TABLE lanes;
        UPDATE plugin_meta SET schema_version = 72 WHERE id = 1;
      `);
    });
    return db;
  }

  const SEED = `
    INSERT INTO session_handoffs (session_id, cwd, issue_id, created_at, updated_at) VALUES ('${SESSION}', '/w', 601, '${ROW_TIME}', '${ROW_TIME}');
    INSERT INTO agent_runs (agent_type, session_id, issue_id, started_at) VALUES
      ('bro', '${SESSION}', NULL, '${ROW_TIME}'),
      ('swe', '${SESSION}', 602, '${ROW_TIME}'),
      ('swe', '${SESSION}', 603, '${ROW_TIME}'),
      ('bro', '${OTHER_SESSION}', 602, '${ROW_TIME}'),
      ('swe', 'sess-no-bro-row', 604, '${ROW_TIME}');
  `;

  it('a lane per handoff or bro session, holding its handoff issue and every issue its agent_runs rows name', () => {
    const db = v72Db(SEED);
    const migrated = new TrajectoryDB(db, undefined, { migrate: true });
    assert.equal(migrated.get<{ v: number }>('SELECT schema_version AS v FROM plugin_meta WHERE id = 1')?.v, 77);
    migrated.close();
    assert.ok(count(db, 'lanes') > 0);
    assert.ok(count(db, 'lane_issues') > 0);
    assert.deepEqual(
      withDb(db, (d) => d.prepare('SELECT session_id FROM lanes ORDER BY session_id').all().map((r) => (r as { session_id: string }).session_id)),
      [SESSION, OTHER_SESSION].sort(),
    );
    assert.deepEqual(laneRows(db), [
      { session_id: OTHER_SESSION, issue_id: 602 },
      { session_id: SESSION, issue_id: 601 },
      { session_id: SESSION, issue_id: 602 },
      { session_id: SESSION, issue_id: 603 },
    ]);
  });

  it('a session known only by its handoff gets a lane too, and a rerun of the backfill adds nothing', () => {
    const db = v72Db(`INSERT INTO session_handoffs (session_id, cwd, issue_id, created_at, updated_at) VALUES ('sess-handoff-only', '/w', 601, '${ROW_TIME}', '${ROW_TIME}');`);
    new TrajectoryDB(db, undefined, { migrate: true }).close();
    assert.deepEqual(laneRows(db), [{ session_id: 'sess-handoff-only', issue_id: 601 }]);
    withDb(db, (d) => d.exec('UPDATE plugin_meta SET schema_version = 72 WHERE id = 1'));
    new TrajectoryDB(db, undefined, { migrate: true }).close();
    assert.equal(count(db, 'lanes'), 1);
    assert.deepEqual(laneRows(db), [{ session_id: 'sess-handoff-only', issue_id: 601 }]);
  });

  it('a v72 DB with no sessions lands at v73 with empty lane tables', () => {
    const db = v72Db('');
    new TrajectoryDB(db, undefined, { migrate: true }).close();
    assert.equal(count(db, 'lanes'), 0);
    assert.equal(count(db, 'lane_issues'), 0);
  });
});

describe('the lane-membership PostToolUse gate (GH 3020)', () => {
  const cases: readonly (readonly [string, object, unknown])[] = [
    ['intent_start', { objective: 'o' }, textResult({ issue_id: 602, branch_id: 'fix/x' })],
    ['issue_create', { objective: 'o' }, textResult({ id: 602, objective: 'o' })],
    ['issue_adopt_remote', { issue_id: 602, remote_iid: 3020 }, textResult({ id: 602 })],
    ['task_provision', { issue_id: '602' }, textResult({ task_id: 22 })],
  ];
  for (const [tool, input, response] of cases) {
    it(`a successful ${tool} adds the issue to the session's lane, silently`, () => {
      const { db, env } = freshDb([602]);
      assert.deepEqual(gate(postToolUse(tool, input, response), env), { stdout: '', code: 0 });
      assert.deepEqual(laneRows(db), [{ session_id: SESSION, issue_id: 602 }]);
    });
  }

  it('tool_input.issue_id wins over the response, and a bare content-block array is read', () => {
    const { db, env } = freshDb([602, 603]);
    gate(postToolUse('task_provision', { issue_id: 603 }, textResult({ issue_id: 602 })), env);
    gate(postToolUse('issue_create', { objective: 'o' }, [{ type: 'text', text: JSON.stringify({ id: 602 }) }], { session_id: OTHER_SESSION }), env);
    assert.deepEqual(laneRows(db), [
      { session_id: OTHER_SESSION, issue_id: 602 },
      { session_id: SESSION, issue_id: 603 },
    ]);
  });

  it('a second call on the same issue keeps one row and one lane', () => {
    const { db, env } = freshDb([602]);
    const payload = postToolUse('intent_start', {}, textResult({ issue_id: 602 }));
    gate(payload, env);
    gate(payload, env);
    assert.equal(count(db, 'lanes'), 1);
    assert.deepEqual(laneRows(db), [{ session_id: SESSION, issue_id: 602 }]);
  });

  const silent: readonly (readonly [string, string, NodeJS.ProcessEnv?])[] = [
    ['another tool', postToolUse('issue_get', { issue_id: 602 }, textResult({ id: 602 }))],
    ['an is_error response', postToolUse('task_provision', { issue_id: 602 }, { ...textResult({ error: 'env_gate_failed' }), is_error: true })],
    ['an isError response', postToolUse('issue_create', {}, { ...textResult({ id: 602 }), isError: true })],
    ['a malformed payload', '{not json'],
    ['a non-object payload', '[1,2]'],
    ['a response without JSON', postToolUse('issue_create', {}, { content: [{ type: 'text', text: 'created #602' }] })],
    ['an issue the DB lacks', postToolUse('issue_create', {}, textResult({ id: 999 }))],
    ['a non-integer issue id', postToolUse('task_provision', { issue_id: '602; DROP TABLE lanes' }, textResult({}))],
    ['a malformed session id', postToolUse('intent_start', {}, textResult({ issue_id: 602 }), { session_id: "bad'id" })],
    ['the bypass', postToolUse('intent_start', {}, textResult({ issue_id: 602 })), { TMB_DISABLE_LANE_MEMBERSHIP_HOOK: '1' }],
  ];
  for (const [name, payload, extraEnv] of silent) {
    it(`${name} writes nothing and exits 0 with empty stdout`, () => {
      const { db, env } = freshDb([602]);
      assert.deepEqual(gate(payload, { ...env, ...extraEnv }), { stdout: '', code: 0 });
      assert.equal(count(db, 'lanes'), 0);
      assert.equal(count(db, 'lane_issues'), 0);
    });
  }

  it('through the hooks bundle, a PostToolUse intent_start leaves the lane row', async () => {
    const { db, env } = freshDb([602]);
    const out = await bundle(['PostToolUse'], postToolUse('intent_start', { objective: 'o' }, textResult({ issue_id: 602 })), env);
    assert.equal(out.code, 0);
    assert.deepEqual(laneRows(db), [{ session_id: SESSION, issue_id: 602 }]);
  });

  it('through the hooks bundle, the bypass and an is_error response leave no row', async () => {
    const { db, env } = freshDb([602]);
    const bypassed = await bundle(['PostToolUse'], postToolUse('intent_start', {}, textResult({ issue_id: 602 })), { ...env, TMB_DISABLE_LANE_MEMBERSHIP_HOOK: '1' });
    const failed = await bundle(['PostToolUse'], postToolUse('task_provision', { issue_id: 602 }, { ...textResult({ error: 'x' }), is_error: true }), env);
    assert.equal(bypassed.code, 0);
    assert.equal(failed.code, 0);
    assert.equal(count(db, 'lane_issues'), 0);
  });
});

describe('the compaction restore lists every open issue the lane owns (GH 3020)', () => {
  it('lists each open issue with its live task count, marks a taskless one unstarted and counts closed ones', () => {
    const { db, env } = freshDb([601, 602, 603], [600]);
    task(db, 1, 601, 'running');
    task(db, 2, 601, 'pending');
    task(db, 3, 601, 'closed');
    task(db, 4, 603, 'closed');
    own(db, SESSION, [600, 601, 602, 603]);
    own(db, OTHER_SESSION, [602]);
    compacted(db, env);
    const out = restore(env);
    assert.match(out, /This session's lane owns 3 open and 1 closed issues\. Its open issues:/);
    assert.match(out, /^- #601 open issue 601 \(2 live tasks\)$/m);
    assert.match(out, /^- #602 open issue 602 \(0 live tasks\) unstarted$/m);
    assert.match(out, /^- #603 open issue 603 \(0 live tasks\)$/m);
    assert.doesNotMatch(out, /#600 closed issue/);
  });

  it('lists the lane when the handoff recorded no issue', () => {
    const { db, env } = freshDb([602]);
    own(db, SESSION, [602]);
    compacted(db, env);
    assert.equal(withDb(db, (d) => (d.prepare('SELECT issue_id FROM session_handoffs').get() as { issue_id: number | null }).issue_id), null);
    const out = restore(env);
    assert.match(out, /^- #602 open issue 602 \(0 live tasks\) unstarted$/m);
    assert.match(out, /No issue was recorded for this session\./);
  });

  it(`caps the listing at ${LANE_ISSUE_LIMIT} lines, newest first, then +N more`, () => {
    const ids = Array.from({ length: LANE_ISSUE_LIMIT + 7 }, (_, n) => 700 + n);
    const { db, env } = freshDb(ids);
    own(db, SESSION, ids);
    compacted(db, env);
    const out = restore(env);
    const listed = out.match(/^- #\d+ open issue/gm) ?? [];
    assert.equal(listed.length, LANE_ISSUE_LIMIT);
    assert.match(out, /^- #736 open issue 736/m);
    assert.doesNotMatch(out, /^- #706 /m);
    assert.match(out, /^\+7 more$/m);
  });

  it('keeps the whole context within the hook cap and the lane listing ahead of the decision', () => {
    const ids = Array.from({ length: LANE_ISSUE_LIMIT }, (_, n) => 800 + n);
    const { db, env } = freshDb(ids);
    withDb(db, (d) => d.prepare('UPDATE issues SET objective = ?').run('x'.repeat(2_000)));
    own(db, SESSION, ids);
    compacted(db, env);
    const persona = 'p'.repeat(6_000);
    const out = restore(env, persona);
    assert.ok(out.length <= HOOK_CONTEXT_CAP, String(out.length));
    assert.ok(out.startsWith(persona));
    assert.match(out, /This session's lane owns 30 open and 0 closed issues/);
  });

  it('a lane owning no issue, or another session, adds no lane lines', () => {
    const { db, env } = freshDb([602]);
    own(db, OTHER_SESSION, [602]);
    compacted(db, env);
    assert.doesNotMatch(restore(env), /lane owns/);
  });
});
