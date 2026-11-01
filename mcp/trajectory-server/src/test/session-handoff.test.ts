/**
 * The session-handoff gate (GH 2193) on a temp trajectory DB: each Stop boundary
 * gate, the once-only notice, consumption by session-start-persona and the
 * issue activation-routine reports afterwards.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { activationRoutine } from '../hooks/activation-routine.js';
import { sessionHandoff, withHandoff } from '../hooks/session-handoff.js';
import { sessionStartPersona } from '../hooks/session-start-persona.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(SERVER_ROOT, '../..');
const HOOKS_BUNDLE = join(SERVER_ROOT, 'dist/hooks.js');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const SESSION = 'sess-source';
const NEW_SESSION = 'sess-new-one';
const CWD = '/work/project';
const ROW_TIME = '2026-10-26T10:00:00.000Z';
const CONTEXT = 'persona context';

interface HandoffRow {
  session_id: string;
  cwd: string;
  issue_id: number | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  consumed_at: string | null;
  consumed_by_session: string | null;
}

let sandbox: string;
let seq = 0;

function freshDb(): { db: string; env: NodeJS.ProcessEnv } {
  seq += 1;
  const db = join(sandbox, `case-${seq}/.claude/tmb/trajectory.db`);
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  d.exec(SCHEMA);
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'ship the handoff', 'open', ?, ?)").run(ROW_TIME, ROW_TIME);
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'newest open issue', 'open', ?, ?)").run(ROW_TIME, ROW_TIME);
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (5, 'finished work', 'closed', ?, ?)").run(ROW_TIME, ROW_TIME);
  d.close();
  return { db, env: { PATH: process.env.PATH, HOME: join(sandbox, 'home'), TRAJECTORY_DB_PATH: db } };
}

function withDb<T>(db: string, fn: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(db);
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

function broRow(db: string, toolUses = 151, session = SESSION): void {
  withDb(db, (d) => {
    d.prepare("INSERT INTO agent_runs (agent_type, session_id, tool_uses, cache_read_tokens, started_at, completed_at) VALUES ('bro', ?, ?, 0, ?, ?)").run(session, toolUses, ROW_TIME, ROW_TIME);
  });
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function run(db: string, opts: { session?: string; issue?: number | null; startedAt?: string; completedAt?: string | null } = {}): void {
  withDb(db, (d) => {
    d.prepare("INSERT INTO agent_runs (agent_type, session_id, issue_id, started_at, completed_at) VALUES ('swe', ?, ?, ?, ?)").run(
      opts.session ?? SESSION,
      opts.issue ?? null,
      opts.startedAt ?? hoursAgo(1),
      opts.completedAt ?? null,
    );
  });
}

function task(db: string, id: number, issue: number, status: string, title: string): void {
  withDb(db, (d) => {
    d.prepare('INSERT INTO tasks (id, issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, issue, `feat/${id}-x`, title, 'd', status, ROW_TIME, ROW_TIME);
  });
}

function rows(db: string): HandoffRow[] {
  return withDb(db, (d) => d.prepare('SELECT * FROM session_handoffs').all() as unknown as HandoffRow[]);
}

function setRow(db: string, sql: string, ...args: string[]): void {
  withDb(db, (d) => {
    d.prepare(sql).run(...args);
  });
}

function stopPayload(extra: object = {}): string {
  return JSON.stringify({ hook_event_name: 'Stop', session_id: SESSION, cwd: CWD, last_assistant_message: 'the last note', ...extra });
}

function stop(env: NodeJS.ProcessEnv, extra: object = {}): { stdout: string; code: number } {
  const r = sessionHandoff(stopPayload(extra), env);
  return { stdout: r.stdout ?? '', code: r.code ?? 0 };
}

function startPayload(extra: object = {}): string {
  return JSON.stringify({ hook_event_name: 'SessionStart', session_id: NEW_SESSION, cwd: CWD, source: 'startup', ...extra });
}

function handedOver(db: string, env: NodeJS.ProcessEnv): void {
  broRow(db);
  stop(env);
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tmb-session-handoff-'));
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

describe('session-handoff Stop gates', () => {
  it('under the limits: no row', () => {
    const { db, env } = freshDb();
    broRow(db, 150);
    assert.equal(stop(env).stdout, '');
    assert.deepEqual(rows(db), []);
  });

  it('past the context-per-call limit alone: a row', () => {
    const { db, env } = freshDb();
    withDb(db, (d) => {
      d.prepare("INSERT INTO agent_runs (agent_type, session_id, tool_uses, cache_read_tokens) VALUES ('bro', ?, 10, 700000)").run(SESSION);
    });
    stop(env);
    assert.equal(rows(db).length, 1);
  });

  it('past the limits with a recent open run in this session: no row', () => {
    const { db, env } = freshDb();
    broRow(db);
    run(db, { startedAt: hoursAgo(11) });
    assert.equal(stop(env).stdout, '');
    assert.deepEqual(rows(db), []);
  });

  it('past the limits with only an open run older than 12h: a row', () => {
    const { db, env } = freshDb();
    broRow(db);
    run(db, { startedAt: hoursAgo(13) });
    stop(env);
    assert.equal(rows(db).length, 1);
  });

  it('an open run only in another session does not block: a row', () => {
    const { db, env } = freshDb();
    broRow(db);
    run(db, { session: 'sess-other' });
    stop(env);
    assert.equal(rows(db).length, 1);
  });

  it('a stale running task of any session does not block: global task status is never read', () => {
    const { db, env } = freshDb();
    broRow(db);
    task(db, 130, 7, 'running', 'stale');
    stop(env);
    assert.equal(rows(db).length, 1);
  });

  for (const [what, extra] of [
    ['non-empty background_tasks', { background_tasks: [{ id: 'b1' }] }],
    ['non-empty session_crons', { session_crons: [{ id: 'c1' }] }],
    ['stop_hook_active', { stop_hook_active: true }],
    ['a session id that is not an id', { session_id: "bad'id" }],
  ] as const) {
    it(`${what}: no row`, () => {
      const { db, env } = freshDb();
      broRow(db);
      assert.equal(stop(env, extra).stdout, '');
      assert.deepEqual(rows(db), []);
    });
  }

  it('empty background_tasks and session_crons are not work', () => {
    const { db, env } = freshDb();
    broRow(db);
    stop(env, { background_tasks: [], session_crons: [] });
    assert.equal(rows(db).length, 1);
  });

  it('a row reads the bro row of this session only', () => {
    const { db, env } = freshDb();
    broRow(db, 151, 'sess-other');
    stop(env);
    assert.deepEqual(rows(db), []);
  });
});

describe('session-handoff Stop write', () => {
  it('the first boundary Stop writes every column and one systemMessage naming the issue', () => {
    const { db, env } = freshDb();
    broRow(db);
    run(db, { issue: 5, completedAt: ROW_TIME });
    run(db, { issue: 7, completedAt: ROW_TIME });
    run(db, { issue: null, completedAt: ROW_TIME });
    const r = stop(env);
    assert.equal(r.code, 0);
    const output = JSON.parse(r.stdout) as Record<string, string>;
    assert.deepEqual(Object.keys(output), ['systemMessage']);
    assert.match(output.systemMessage, /new session/);
    assert.match(output.systemMessage, /#7: ship the handoff/);
    const [row] = rows(db);
    assert.equal(row.session_id, SESSION);
    assert.equal(row.cwd, CWD);
    assert.equal(row.issue_id, 7);
    assert.equal(row.summary, 'the last note');
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(row.consumed_at, null);
    assert.equal(row.consumed_by_session, null);
  });

  it('with no non-bro run the row has no issue and the notice says so', () => {
    const { db, env } = freshDb();
    broRow(db);
    const output = JSON.parse(stop(env).stdout) as { systemMessage: string };
    assert.match(output.systemMessage, /No issue was recorded/);
    assert.equal(rows(db)[0].issue_id, null);
  });

  it('truncates the summary to 2000 chars and stores NULL when the message is absent', () => {
    const { db, env } = freshDb();
    broRow(db);
    stop(env, { last_assistant_message: `it's; a "note"\n${'x'.repeat(3000)}` });
    const { summary } = rows(db)[0];
    assert.equal(summary?.length, 2000);
    assert.ok(summary?.startsWith(`it's; a "note"\n`));
    stop(env, { last_assistant_message: undefined });
    assert.equal(rows(db)[0].summary, null);
  });

  it('a second Stop outputs nothing and refreshes summary and updated_at', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    setRow(db, 'UPDATE session_handoffs SET updated_at = ?, created_at = ?', ROW_TIME, ROW_TIME);
    const r = stop(env, { last_assistant_message: 'a later note' });
    assert.equal(r.stdout, '');
    const [row] = rows(db);
    assert.equal(row.summary, 'a later note');
    assert.equal(row.created_at, ROW_TIME);
    assert.notEqual(row.updated_at, ROW_TIME);
  });

  it('a Stop after consumption changes nothing and outputs nothing', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    withHandoff(CONTEXT, startPayload(), env);
    const before = rows(db)[0];
    assert.equal(stop(env, { last_assistant_message: 'after the handoff' }).stdout, '');
    assert.deepEqual(rows(db)[0], before);
  });

  it('with the hook bypass: no row and no output', () => {
    const { db, env } = freshDb();
    broRow(db);
    assert.deepEqual(stop({ ...env, TMB_DISABLE_SESSION_HANDOFF_HOOK: '1' }), { stdout: '', code: 0 });
    assert.deepEqual(rows(db), []);
  });

  it('a missing table exits 0 with no output', () => {
    const { db, env } = freshDb();
    broRow(db);
    withDb(db, (d) => d.exec('DROP TABLE session_handoffs'));
    assert.deepEqual(stop(env), { stdout: '', code: 0 });
  });

  it('an unreadable DB and an unparseable payload exit 0 with no output', () => {
    const { db, env } = freshDb();
    writeFileSync(db, 'not a database');
    assert.deepEqual(stop(env), { stdout: '', code: 0 });
    const bad = sessionHandoff('{not json', env);
    assert.equal(bad.stdout ?? '', '');
    assert.equal(bad.code ?? 0, 0);
  });

  it('through the router: Stop handoff prints only the systemMessage', async () => {
    const { db, env } = freshDb();
    broRow(db);
    const out = await bundle(['Stop', 'handoff'], stopPayload(), env);
    assert.equal(out.code, 0);
    assert.deepEqual(Object.keys(JSON.parse(out.stdout) as object), ['systemMessage']);
    assert.equal(rows(db).length, 1);
  });
});

describe('hooks.json registration', () => {
  it('has the handoff Stop entry without async and leaves the async entry alone', () => {
    const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')) as {
      hooks: { Stop: { hooks: { command: string; timeout: number; async?: boolean }[] }[] };
    };
    const entries = hooks.hooks.Stop.flatMap((g) => g.hooks);
    const handoff = entries.filter((h) => h.command.endsWith('dist/hooks.js" Stop handoff'));
    const usage = entries.filter((h) => h.command.endsWith('dist/hooks.js" Stop'));
    assert.equal(handoff.length, 1);
    assert.equal('async' in handoff[0], false);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].async, true);
    assert.equal(usage[0].timeout, 9);
  });
});

describe('session-handoff consumption', () => {
  for (const source of ['startup', 'clear']) {
    it(`source ${source} consumes: both consumed columns set`, () => {
      const { db, env } = freshDb();
      handedOver(db, env);
      const out = withHandoff(CONTEXT, startPayload({ source }), env);
      assert.notEqual(out, CONTEXT);
      const [row] = rows(db);
      assert.match(row.consumed_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(row.consumed_by_session, NEW_SESSION);
    });
  }

  for (const source of ['resume', 'compact', 'fork', undefined]) {
    it(`source ${source} does not consume`, () => {
      const { db, env } = freshDb();
      handedOver(db, env);
      assert.equal(withHandoff(CONTEXT, startPayload({ source }), env), CONTEXT);
      assert.equal(rows(db)[0].consumed_at, null);
    });
  }

  it('a different cwd does not consume', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    assert.equal(withHandoff(CONTEXT, startPayload({ cwd: '/work/other' }), env), CONTEXT);
    assert.equal(rows(db)[0].consumed_at, null);
  });

  it('the same session does not consume its own row', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    assert.equal(withHandoff(CONTEXT, startPayload({ session_id: SESSION }), env), CONTEXT);
    assert.equal(rows(db)[0].consumed_at, null);
  });

  it('an expired row does not consume, one just inside 24h does', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    setRow(db, 'UPDATE session_handoffs SET updated_at = ?', hoursAgo(25));
    assert.equal(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
    setRow(db, 'UPDATE session_handoffs SET updated_at = ?', hoursAgo(23));
    assert.notEqual(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
  });

  it('a source session with a blocking open run does not consume; a dead open run does not block', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    run(db);
    assert.equal(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
    assert.equal(rows(db)[0].consumed_at, null);
    setRow(db, "UPDATE agent_runs SET started_at = ? WHERE agent_type = 'swe'", hoursAgo(13));
    assert.notEqual(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
  });

  it('takes the newest of several rows in the cwd', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    setRow(db, 'UPDATE session_handoffs SET updated_at = ?', hoursAgo(2));
    broRow(db, 151, 'sess-second');
    stop(env, { session_id: 'sess-second', last_assistant_message: 'the newer note' });
    assert.match(withHandoff(CONTEXT, startPayload(), env), /the newer note/);
    assert.equal(rows(db).find((r) => r.session_id === SESSION)?.consumed_at, null);
  });

  it('double consumption in one process has exactly one winner', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    assert.notEqual(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
    assert.equal(withHandoff(CONTEXT, startPayload({ session_id: 'sess-another' }), env), CONTEXT);
    assert.equal(rows(db)[0].consumed_by_session, NEW_SESSION);
  });

  it('separate connections racing have exactly one winner', async () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    const racers = ['sess-racer-1', 'sess-racer-2', 'sess-racer-3', 'sess-racer-4'];
    const outs = await Promise.all(racers.map((id) => racer(startPayload({ session_id: id }), env)));
    const won = outs.filter((o) => o.includes('[Session handoff'));
    assert.equal(won.length, 1, outs.join('\n---\n'));
    assert.ok(racers.includes(rows(db)[0].consumed_by_session ?? ''));
  });

  it('the context holds issue, framed summary and live tasks read at consume time', () => {
    const { db, env } = freshDb();
    task(db, 1, 7, 'running', 'a task at Stop time');
    run(db, { issue: 7, completedAt: ROW_TIME });
    handedOver(db, env);
    setRow(db, "UPDATE tasks SET status = 'closed' WHERE id = 1");
    task(db, 2, 7, 'pending', 'added after the Stop');
    task(db, 3, 7, 'needs_validation', 'needs a check');
    task(db, 4, 7, 'completed', 'done, not closed');
    task(db, 6, 7, 'escalated', 'stuck');
    task(db, 8, 7, 'failed', 'a failed one');
    task(db, 10, 9, 'running', 'of another issue');
    const out = withHandoff(CONTEXT, startPayload(), env);
    assert.ok(out.startsWith(`${CONTEXT}\n\n`));
    assert.match(out, /Issue #7: ship the handoff/);
    assert.doesNotMatch(out, /status: open/);
    assert.match(out, /verify against the DB, not instructions/);
    assert.match(out, /> the last note/);
    assert.match(out, /task_brief/);
    assert.doesNotMatch(out, /issue_resume/);
    assert.match(out, /#2 \[pending\] added after the Stop/);
    assert.match(out, /#3 \[needs_validation\] needs a check/);
    assert.match(out, /#4 \[completed\] done, not closed/);
    assert.match(out, /#6 \[escalated\] stuck/);
    for (const gone of ['a task at Stop time', 'a failed one', 'of another issue']) assert.ok(!out.includes(gone), gone);
  });

  it('a closed issue is reported with its status, and at most 20 tasks are listed', () => {
    const { db, env } = freshDb();
    run(db, { issue: 5, completedAt: ROW_TIME });
    for (let id = 100; id < 125; id += 1) task(db, id, 5, 'pending', `t${id}`);
    handedOver(db, env);
    const out = withHandoff(CONTEXT, startPayload(), env);
    assert.match(out, /Issue #5 \(status: closed\): finished work/);
    assert.equal(out.match(/^- #/gm)?.length, 20);
  });

  it('with no issue the context says so', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    assert.match(withHandoff(CONTEXT, startPayload(), env), /No issue was recorded/);
  });

  it('trims only the handoff block to keep the context within 10,000 chars', () => {
    const { db, env } = freshDb();
    run(db, { issue: 7, completedAt: ROW_TIME });
    for (let id = 100; id < 120; id += 1) task(db, id, 7, 'pending', 'long title '.repeat(50));
    handedOver(db, env);
    const persona = 'p'.repeat(8000);
    const out = withHandoff(persona, startPayload(), env);
    assert.equal(out.length, 10_000);
    assert.ok(out.startsWith(`${persona}\n\n[Session handoff`));
  });

  it('with no room for a block the persona stays and the row is not consumed', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    const persona = 'p'.repeat(9950);
    assert.equal(withHandoff(persona, startPayload(), env), persona);
    assert.equal(rows(db)[0].consumed_at, null);
  });

  it('a failure or the bypass leaves the persona unchanged', () => {
    const { db, env } = freshDb();
    handedOver(db, env);
    assert.equal(withHandoff(CONTEXT, startPayload(), { ...env, TMB_DISABLE_SESSION_HANDOFF_HOOK: '1' }), CONTEXT);
    assert.equal(rows(db)[0].consumed_at, null);
    assert.equal(withHandoff(CONTEXT, '{not json', env), CONTEXT);
    withDb(db, (d) => d.exec('DROP TABLE session_handoffs'));
    assert.equal(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
  });

  it('sessionStartPersona carries the handoff in its additionalContext', () => {
    const { db, env } = freshDb();
    run(db, { issue: 7, completedAt: ROW_TIME });
    handedOver(db, env);
    const project = join(sandbox, 'persona-project');
    mkdirSync(project, { recursive: true });
    const r = sessionStartPersona(startPayload(), { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: project });
    const stdout = r.stdout ?? '';
    const context = stdout.startsWith('{') ? (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : stdout;
    assert.match(context, /You are bro/);
    assert.match(context, /Issue #7: ship the handoff/);
    assert.ok(context.length <= 10_000, `${context.length} chars`);
  });
});

describe('activation-routine pending after a handoff', () => {
  const pendingOf = (env: NodeJS.ProcessEnv, session: string): string => {
    const r = activationRoutine(JSON.stringify({ prompt: 'hey bro', session_id: session }), env);
    const context = (JSON.parse(r.stdout ?? '') as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    const match = /pending=#(\d+): ([^\n]*?)(?: session_id=|$)/m.exec(context);
    assert.ok(match, context);
    assert.match(context, /do NOT also call issue_resume|onboarded=/);
    return `#${match[1]}: ${match[2]}`;
  };

  it('uses the consumed handoff issue while it is open', () => {
    const { db, env } = freshDb();
    run(db, { issue: 7, completedAt: ROW_TIME });
    handedOver(db, env);
    withHandoff(CONTEXT, startPayload(), env);
    assert.equal(pendingOf(env, NEW_SESSION), '#7: ship the handoff');
  });

  it("another session's, and no handoff, report today's newest open issue", () => {
    const { db, env } = freshDb();
    run(db, { issue: 7, completedAt: ROW_TIME });
    handedOver(db, env);
    withHandoff(CONTEXT, startPayload(), env);
    assert.equal(pendingOf(env, 'sess-unrelated'), '#9: newest open issue');
  });

  it("a closed handoff issue reports today's newest open issue", () => {
    const { db, env } = freshDb();
    run(db, { issue: 5, completedAt: ROW_TIME });
    handedOver(db, env);
    withHandoff(CONTEXT, startPayload(), env);
    assert.equal(pendingOf(env, NEW_SESSION), '#9: newest open issue');
  });

  it("a DB with no session_handoffs table reports today's newest open issue", () => {
    const { db, env } = freshDb();
    withDb(db, (d) => d.exec('DROP TABLE session_handoffs'));
    assert.equal(pendingOf(env, NEW_SESSION), '#9: newest open issue');
  });
});

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

/** One consume in its own process, so it holds its own DB connection. */
async function racer(payload: string, env: NodeJS.ProcessEnv): Promise<string> {
  const script = `
    import { withHandoff } from ${JSON.stringify(new URL('../hooks/session-handoff.js', import.meta.url).href)};
    process.stdout.write(withHandoff('ctx', process.argv[1], process.env));
  `;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, payload], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', fail);
    child.on('close', () => done(stdout));
  });
}
