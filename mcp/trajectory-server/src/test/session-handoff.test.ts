/**
 * The session-handoff gate (GH 2275) on a temp trajectory DB: the PreCompact
 * gate that records a bro session's row before each compaction, its
 * consumption by the same session's SessionStart with source 'compact' through
 * session-start-persona, and the issue activation-routine reports afterwards.
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
const SESSION = 'sess-compacted';
const OTHER_SESSION = 'sess-other-one';
const CWD = '/work/project';
const ROW_TIME = '2026-10-26T10:00:00.000Z';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTEXT = 'persona context';
const HEADER = '[Compaction restore';

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
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'ship the restore', 'open', ?, ?)").run(ROW_TIME, ROW_TIME);
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

function broRow(db: string, session = SESSION): void {
  withDb(db, (d) => {
    d.prepare("INSERT INTO agent_runs (agent_type, session_id, started_at, completed_at) VALUES ('bro', ?, ?, ?)").run(session, ROW_TIME, ROW_TIME);
  });
}

function run(db: string, opts: { session?: string; issue?: number | null; completedAt?: string | null } = {}): void {
  withDb(db, (d) => {
    d.prepare("INSERT INTO agent_runs (agent_type, session_id, issue_id, started_at, completed_at) VALUES ('swe', ?, ?, ?, ?)").run(
      opts.session ?? SESSION,
      opts.issue ?? null,
      ROW_TIME,
      opts.completedAt === undefined ? ROW_TIME : opts.completedAt,
    );
  });
}

function task(db: string, id: number, issue: number, status: string, title: string): void {
  withDb(db, (d) => {
    d.prepare('INSERT INTO tasks (id, issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, issue, `feat/${id}-x`, title, 'd', status, ROW_TIME, ROW_TIME);
  });
}

function discussion(db: string, issue: number, kind: string, body: string): number {
  return withDb(db, (d) => Number(d.prepare("INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', ?, ?, ?)").run(issue, kind, body, ROW_TIME).lastInsertRowid));
}

function rows(db: string): HandoffRow[] {
  return withDb(db, (d) => d.prepare('SELECT * FROM session_handoffs ORDER BY session_id').all() as unknown as HandoffRow[]);
}

function setRow(db: string, sql: string, ...args: string[]): void {
  withDb(db, (d) => {
    d.prepare(sql).run(...args);
  });
}

function preCompactPayload(extra: object = {}): string {
  return JSON.stringify({ hook_event_name: 'PreCompact', session_id: SESSION, cwd: CWD, transcript_path: '/nonexistent/transcript.jsonl', trigger: 'auto', custom_instructions: '', ...extra });
}

function preCompact(env: NodeJS.ProcessEnv, extra: object = {}): { stdout: string; code: number } {
  const r = sessionHandoff(preCompactPayload(extra), env);
  return { stdout: r.stdout ?? '', code: r.code ?? 0 };
}

function startPayload(extra: object = {}): string {
  return JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION, cwd: CWD, source: 'compact', ...extra });
}

function compacted(db: string, env: NodeJS.ProcessEnv): void {
  broRow(db);
  preCompact(env);
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tmb-session-handoff-'));
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

describe('session-handoff PreCompact gate (GH 2275)', () => {
  it('GH 2275: a PreCompact payload of a bro session writes one row with consumed_at NULL, silently', () => {
    const { db, env } = freshDb();
    broRow(db);
    run(db, { issue: 5 });
    run(db, { issue: 7 });
    run(db, { issue: null });
    assert.deepEqual(preCompact(env), { stdout: '', code: 0 });
    const all = rows(db);
    assert.equal(all.length, 1);
    const [row] = all;
    assert.equal(row.session_id, SESSION);
    assert.equal(row.cwd, CWD);
    assert.equal(row.issue_id, 7);
    assert.equal(row.summary, null);
    assert.match(row.created_at, ISO);
    assert.match(row.updated_at, ISO);
    assert.equal(row.consumed_at, null);
    assert.equal(row.consumed_by_session, null);
  });

  for (const trigger of ['manual', 'auto']) {
    it(`GH 2275: trigger ${trigger} writes the row`, () => {
      const { db, env } = freshDb();
      broRow(db);
      assert.deepEqual(preCompact(env, { trigger }), { stdout: '', code: 0 });
      assert.equal(rows(db).length, 1);
    });
  }

  it('GH 2275: with no non-bro run the row has no issue', () => {
    const { db, env } = freshDb();
    compacted(db, env);
    assert.equal(rows(db)[0].issue_id, null);
  });

  it('GH 2275: an open run in the session does not stop the write', () => {
    const { db, env } = freshDb();
    broRow(db);
    run(db, { issue: 7, completedAt: null });
    preCompact(env);
    assert.equal(rows(db)[0].issue_id, 7);
  });

  it('GH 2275: a session with no bro row of its own writes nothing', () => {
    const { db, env } = freshDb();
    broRow(db, OTHER_SESSION);
    run(db, { issue: 7 });
    assert.deepEqual(preCompact(env), { stdout: '', code: 0 });
    assert.deepEqual(rows(db), []);
  });

  for (const [what, extra] of [
    ['a session id that is not an id', { session_id: "bad'id" }],
    ['no session id', { session_id: undefined }],
    ['no cwd', { cwd: undefined }],
    ['an empty cwd', { cwd: '' }],
    ['a cwd that is not a string', { cwd: 7 }],
  ] as const) {
    it(`GH 2275: ${what}: no row, no output`, () => {
      const { db, env } = freshDb();
      broRow(db);
      assert.deepEqual(preCompact(env, extra), { stdout: '', code: 0 });
      assert.deepEqual(rows(db), []);
    });
  }

  it('GH 2275: a cwd with a quote is stored as given', () => {
    const { db, env } = freshDb();
    broRow(db);
    preCompact(env, { cwd: "/work/it's" });
    assert.equal(rows(db)[0].cwd, "/work/it's");
  });

  it('GH 2275: a second compaction re-arms a consumed row and refreshes it', () => {
    const { db, env } = freshDb();
    compacted(db, env);
    assert.notEqual(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
    setRow(db, 'UPDATE session_handoffs SET updated_at = ?, created_at = ?, summary = ?', ROW_TIME, ROW_TIME, 'stale');
    assert.equal(rows(db)[0].consumed_by_session, SESSION);
    run(db, { issue: 7 });
    assert.deepEqual(preCompact(env, { cwd: '/work/moved' }), { stdout: '', code: 0 });
    const all = rows(db);
    assert.equal(all.length, 1);
    const [row] = all;
    assert.equal(row.consumed_at, null);
    assert.equal(row.consumed_by_session, null);
    assert.equal(row.issue_id, 7);
    assert.equal(row.cwd, '/work/moved');
    assert.equal(row.summary, null);
    assert.equal(row.created_at, ROW_TIME);
    assert.notEqual(row.updated_at, ROW_TIME);
    assert.match(withHandoff(CONTEXT, startPayload(), env), /Issue #7: ship the restore/);
  });

  it('GH 2275: with the hook bypass: no row and no output', () => {
    const { db, env } = freshDb();
    broRow(db);
    assert.deepEqual(preCompact({ ...env, TMB_DISABLE_SESSION_HANDOFF_HOOK: '1' }), { stdout: '', code: 0 });
    assert.deepEqual(rows(db), []);
  });

  it('GH 2275: a missing table, an unreadable DB and an unparseable payload exit 0 with no output', () => {
    const { db, env } = freshDb();
    broRow(db);
    withDb(db, (d) => d.exec('DROP TABLE session_handoffs'));
    assert.deepEqual(preCompact(env), { stdout: '', code: 0 });
    writeFileSync(db, 'not a database');
    assert.deepEqual(preCompact(env), { stdout: '', code: 0 });
    const bad = sessionHandoff('{not json', env);
    assert.equal(bad.stdout ?? '', '');
    assert.equal(bad.code ?? 0, 0);
    assert.deepEqual(preCompact({ PATH: process.env.PATH, HOME: join(sandbox, 'home'), TRAJECTORY_DB_PATH: join(sandbox, 'missing/trajectory.db') }), { stdout: '', code: 0 });
  });

  it('GH 2275: through the router, PreCompact prints nothing, exits 0 and writes the row', async () => {
    const { db, env } = freshDb();
    broRow(db);
    for (const trigger of ['auto', 'manual']) {
      const out = await bundle(['PreCompact'], preCompactPayload({ trigger }), env);
      assert.deepEqual(out, { code: 0, stdout: '' });
    }
    assert.equal(rows(db).length, 1);
    assert.deepEqual(await bundle(['PreCompact'], '{not json', env), { code: 0, stdout: '' });
  });
});

describe('hooks.json registration (GH 2275)', () => {
  it('GH 2275: PreCompact runs the router with matcher "" and no async, and Stop keeps only the async usage entry', () => {
    const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number; async?: boolean }[] }[]>;
    };
    const preCompactEntries = hooks.hooks.PreCompact;
    assert.equal(preCompactEntries.length, 1);
    assert.equal(preCompactEntries[0].matcher, '');
    assert.equal(preCompactEntries[0].hooks.length, 1);
    const [entry] = preCompactEntries[0].hooks;
    assert.ok(entry.command.endsWith('dist/hooks.js" PreCompact'), entry.command);
    assert.equal('async' in entry, false);
    const stop = hooks.hooks.Stop.flatMap((g) => g.hooks);
    assert.equal(stop.filter((h) => / Stop handoff$/.test(h.command)).length, 0);
    const usage = stop.filter((h) => h.command.endsWith('dist/hooks.js" Stop'));
    assert.equal(usage.length, 1);
    assert.equal(usage[0].async, true);
  });
});

describe('session-handoff compaction restore (GH 2275)', () => {
  it('GH 2275: source compact consumes the same session row: both consumed columns set', () => {
    const { db, env } = freshDb();
    compacted(db, env);
    const out = withHandoff(CONTEXT, startPayload(), env);
    assert.ok(out.startsWith(`${CONTEXT}\n\n${HEADER}`), out);
    const [row] = rows(db);
    assert.match(row.consumed_at ?? '', ISO);
    assert.equal(row.consumed_by_session, SESSION);
  });

  for (const source of ['startup', 'clear', 'resume', 'fork', undefined]) {
    it(`GH 2275: source ${source} adds nothing and leaves the row armed`, () => {
      const { db, env } = freshDb();
      compacted(db, env);
      assert.equal(withHandoff(CONTEXT, startPayload({ source }), env), CONTEXT);
      assert.equal(rows(db)[0].consumed_at, null);
    });
  }

  it('GH 2275: a row from another session is never consumed, in the same cwd or not', () => {
    const { db, env } = freshDb();
    compacted(db, env);
    for (const source of ['compact', 'startup', 'clear', 'resume']) {
      assert.equal(withHandoff(CONTEXT, startPayload({ session_id: OTHER_SESSION, source }), env), CONTEXT);
    }
    const [row] = rows(db);
    assert.equal(row.consumed_at, null);
    assert.equal(row.consumed_by_session, null);
  });

  it('GH 2275: a session takes its own row only, beside another armed row', () => {
    const { db, env } = freshDb();
    compacted(db, env);
    broRow(db, OTHER_SESSION);
    run(db, { session: OTHER_SESSION, issue: 9 });
    preCompact(env, { session_id: OTHER_SESSION });
    assert.match(withHandoff(CONTEXT, startPayload({ session_id: OTHER_SESSION }), env), /Issue #9: newest open issue/);
    const [own, other] = rows(db);
    assert.equal(other.session_id, OTHER_SESSION);
    assert.equal(other.consumed_by_session, OTHER_SESSION);
    assert.equal(own.consumed_at, null);
  });

  it('GH 2275: a row is consumed once', () => {
    const { db, env } = freshDb();
    compacted(db, env);
    assert.notEqual(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
    assert.equal(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
  });

  it('GH 2275: separate connections racing have exactly one winner', async () => {
    const { db, env } = freshDb();
    compacted(db, env);
    const outs = await Promise.all([1, 2, 3, 4].map(() => racer(startPayload(), env)));
    const won = outs.filter((o) => o.includes(HEADER));
    assert.equal(won.length, 1, outs.join('\n---\n'));
    assert.equal(rows(db)[0].consumed_by_session, SESSION);
  });

  it('GH 2275: the block holds the issue, its live tasks and its newest decision body, read at consume time', () => {
    const { db, env } = freshDb();
    task(db, 1, 7, 'running', 'a task at compaction time');
    run(db, { issue: 7 });
    discussion(db, 7, 'decision', 'an older decision');
    compacted(db, env);
    setRow(db, "UPDATE tasks SET status = 'closed' WHERE id = 1");
    task(db, 2, 7, 'pending', 'added after the compaction');
    task(db, 3, 7, 'needs_validation', 'needs a check');
    task(db, 4, 7, 'completed', 'done, not closed');
    task(db, 6, 7, 'escalated', 'stuck');
    task(db, 8, 7, 'failed', 'a failed one');
    task(db, 10, 9, 'running', 'of another issue');
    const newest = discussion(db, 7, 'decision', 'the newest decision\nits second line');
    discussion(db, 7, 'note', 'a later note');
    discussion(db, 9, 'decision', 'a decision of another issue');
    const out = withHandoff(CONTEXT, startPayload(), env);
    assert.ok(out.startsWith(`${CONTEXT}\n\n${HEADER}`));
    assert.match(out, /Issue #7: ship the restore/);
    assert.doesNotMatch(out, /status: open/);
    assert.match(out, /task_brief/);
    assert.match(out, /#2 \[pending\] added after the compaction/);
    assert.match(out, /#3 \[needs_validation\] needs a check/);
    assert.match(out, /#4 \[completed\] done, not closed/);
    assert.match(out, /#6 \[escalated\] stuck/);
    assert.ok(out.includes(`newest decision (discussion #${newest})`), out);
    assert.match(out, /^> the newest decision\n> its second line$/m);
    for (const gone of ['a task at compaction time', 'a failed one', 'of another issue', 'an older decision', 'a later note', 'a decision of another issue']) {
      assert.ok(!out.includes(gone), gone);
    }
    assert.doesNotMatch(out, /new session|usage limit/i);
  });

  it('GH 2275: an issue with no decision lists no decision', () => {
    const { db, env } = freshDb();
    run(db, { issue: 7 });
    compacted(db, env);
    const out = withHandoff(CONTEXT, startPayload(), env);
    assert.match(out, /Issue #7/);
    assert.doesNotMatch(out, /decision/);
  });

  it('GH 2275: a closed issue is reported with its status, and at most 20 tasks are listed', () => {
    const { db, env } = freshDb();
    run(db, { issue: 5 });
    for (let id = 100; id < 125; id += 1) task(db, id, 5, 'pending', `t${id}`);
    compacted(db, env);
    const out = withHandoff(CONTEXT, startPayload(), env);
    assert.match(out, /Issue #5 \(status: closed\): finished work/);
    assert.equal(out.match(/^- #/gm)?.length, 20);
  });

  it('GH 2275: with no issue the block says so', () => {
    const { db, env } = freshDb();
    compacted(db, env);
    assert.match(withHandoff(CONTEXT, startPayload(), env), /No issue was recorded/);
  });

  it('GH 2275: a long decision is truncated to keep the context within 10,000 chars', () => {
    const { db, env } = freshDb();
    run(db, { issue: 7 });
    for (let id = 100; id < 110; id += 1) task(db, id, 7, 'pending', `task ${id}`);
    discussion(db, 7, 'decision', 'decided '.repeat(2000));
    compacted(db, env);
    const persona = 'p'.repeat(6000);
    const out = withHandoff(persona, startPayload(), env);
    assert.equal(out.length, 10_000);
    assert.ok(out.startsWith(`${persona}\n\n${HEADER}`));
    assert.match(out, /#109 \[pending\] task 109/);
    assert.match(out, /> decided decided/);
  });

  it('GH 2275: with no room for a block the persona stays and the row is not consumed', () => {
    const { db, env } = freshDb();
    compacted(db, env);
    const persona = 'p'.repeat(9950);
    assert.equal(withHandoff(persona, startPayload(), env), persona);
    assert.equal(rows(db)[0].consumed_at, null);
  });

  it('GH 2275: a failure, an invalid payload or the bypass leaves the persona unchanged', () => {
    const { db, env } = freshDb();
    compacted(db, env);
    assert.equal(withHandoff(CONTEXT, startPayload(), { ...env, TMB_DISABLE_SESSION_HANDOFF_HOOK: '1' }), CONTEXT);
    assert.equal(withHandoff(CONTEXT, startPayload({ cwd: undefined }), env), CONTEXT);
    assert.equal(withHandoff(CONTEXT, startPayload({ session_id: "bad'id" }), env), CONTEXT);
    assert.equal(rows(db)[0].consumed_at, null);
    assert.equal(withHandoff(CONTEXT, '{not json', env), CONTEXT);
    withDb(db, (d) => d.exec('DROP TABLE session_handoffs'));
    assert.equal(withHandoff(CONTEXT, startPayload(), env), CONTEXT);
  });

  it('GH 2275: sessionStartPersona carries the restore in its additionalContext on compact only', () => {
    const { db, env } = freshDb();
    run(db, { issue: 7 });
    compacted(db, env);
    const project = join(sandbox, 'persona-project');
    mkdirSync(project, { recursive: true });
    const personaEnv = { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: project };
    const contextOf = (payload: string): string => {
      const stdout = sessionStartPersona(payload, personaEnv).stdout ?? '';
      return stdout.startsWith('{') ? (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : stdout;
    };
    assert.doesNotMatch(contextOf(startPayload({ source: 'startup' })), /Compaction restore/);
    const context = contextOf(startPayload());
    assert.match(context, /You are bro/);
    assert.match(context, /Issue #7: ship the restore/);
    assert.ok(context.length <= 10_000, `${context.length} chars`);
  });
});

describe('activation-routine pending after a compaction restore (GH 2275)', () => {
  const pendingOf = (env: NodeJS.ProcessEnv, session: string): string => {
    const r = activationRoutine(JSON.stringify({ prompt: 'hey bro', session_id: session }), env);
    const context = (JSON.parse(r.stdout ?? '') as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    const match = /pending=#(\d+): ([^\n]*?)(?: session_id=|$)/m.exec(context);
    assert.ok(match, context);
    assert.match(context, /do NOT also call issue_resume|onboarded=/);
    assert.doesNotMatch(context, /past its limit|new session/);
    return `#${match[1]}: ${match[2]}`;
  };

  it('GH 2275: uses the restored issue while it is open', () => {
    const { db, env } = freshDb();
    run(db, { issue: 7 });
    compacted(db, env);
    withHandoff(CONTEXT, startPayload(), env);
    assert.equal(pendingOf(env, SESSION), '#7: ship the restore');
  });

  it("GH 2275: another session, and no restore, report today's newest open issue", () => {
    const { db, env } = freshDb();
    run(db, { issue: 7 });
    compacted(db, env);
    withHandoff(CONTEXT, startPayload(), env);
    assert.equal(pendingOf(env, OTHER_SESSION), '#9: newest open issue');
  });

  it("GH 2275: a closed restored issue reports today's newest open issue", () => {
    const { db, env } = freshDb();
    run(db, { issue: 5 });
    compacted(db, env);
    withHandoff(CONTEXT, startPayload(), env);
    assert.equal(pendingOf(env, SESSION), '#9: newest open issue');
  });

  it("GH 2275: a DB with no session_handoffs table reports today's newest open issue", () => {
    const { db, env } = freshDb();
    withDb(db, (d) => d.exec('DROP TABLE session_handoffs'));
    assert.equal(pendingOf(env, SESSION), '#9: newest open issue');
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
