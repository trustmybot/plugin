/**
 * close-forge-merged (GH 3275): a task whose PR merged on the forge, outside
 * any Bash call of the session, closes at the next session start or prompt,
 * through the merge record close-issue-on-merge writes. A fake gh on PATH
 * answers `gh pr list` and logs each call.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { closeForgeMerged, mergedPrs } from '../hooks/close-forge-merged.js';
import { runWithDeadline } from '../hooks/lib/deadline.js';
import { findGate, gateNames } from '../hooks/registry.js';
import { ALLOW } from '../hooks/gate.js';

const TASK_AT = '2026-10-25T09:00:00.000Z';
const AFTER_TASK = '2026-10-26T09:00:00Z';
const BEFORE_TASK = '2026-10-24T09:00:00Z';
const SCHEMA = readFileSync(join(import.meta.dirname, '../../src/schema.sql'), 'utf8');

const PAYLOAD = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' });

function prList(prs: readonly { head: string; mergedAt: string | null; body?: string }[]): string {
  return JSON.stringify(
    prs.map((p, i) => ({ headRefName: p.head, number: 40 + i, mergedAt: p.mergedAt, body: p.body ?? '', closingIssuesReferences: [] })),
  );
}

describe('close-forge-merged', () => {
  let root: string;
  let db: string;
  let repo: string;
  let bin: string;
  let ghLog: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'close-forge-merged-'));
    db = join(root, 'trajectory.db');
    repo = join(root, 'repo');
    bin = join(root, 'bin');
    ghLog = join(root, 'gh.log');
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const sql = (statement: string, ...params: (string | number | null)[]): void => {
    const d = new DatabaseSync(db);
    try {
      d.prepare(statement).run(...params);
    } finally {
      d.close();
    }
  };

  const rows = <T>(statement: string, ...params: (string | number)[]): T[] => {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
      return d.prepare(statement).all(...params) as T[];
    } finally {
      d.close();
    }
  };

  const taskStatus = (id: number): string => rows<{ status: string }>('SELECT status FROM tasks WHERE id = ?', id)[0].status;
  const auditRows = (): { event_type: string; from_node: string; content_json: string }[] =>
    rows('SELECT event_type, from_node, content_json FROM audit ORDER BY id');
  const bypassRows = (): string[] =>
    rows<{ content_json: string }>("SELECT content_json FROM audit WHERE event_type = 'review_gate_bypassed' ORDER BY id").map((r) => r.content_json);

  const addTask = (id: number, branch: string, status = 'running', createdAt = TASK_AT, issue = 9): void =>
    sql(
      "INSERT INTO tasks (id, issue_id, branch_id, description, status, commit_sha, created_at, updated_at) VALUES (?, ?, ?, 'd', ?, 'abc1234', ?, ?)",
      id,
      issue,
      branch,
      status,
      createdAt,
      createdAt,
    );

  /** bro verifies the commit, then code-reviewer passes it. */
  const addPass = (task: number): void => {
    sql(
      "INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (9, 'bro', 'bro_verification_pass', 'ok', ?, '2026-10-25T10:00:00.000Z')",
      JSON.stringify({ task_id: task, commit_sha: 'abc1234' }),
    );
    sql(
      "INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, 1, 'code-reviewer', 'pass', 1, '2026-10-25T11:00:00.000Z')",
      task,
    );
  };

  /** A fake gh that logs its argv, then runs <body>. */
  const fakeGh = (body: string): void => writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${ghLog}'\n${body}\n`, { mode: 0o755 });
  const answer = (stdout: string): void => {
    writeFileSync(join(root, 'answer.json'), stdout);
    fakeGh(`cat '${join(root, 'answer.json')}'`);
  };

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: join(root, 'home'),
    TRAJECTORY_DB_PATH: db,
    TMB_DISABLE_REMOTE_SYNC: '1',
    ...extra,
  });

  beforeEach(() => {
    for (const side of ['', '-wal', '-shm', '-journal']) rmSync(`${db}${side}`, { force: true });
    rmSync(ghLog, { force: true });
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('repo', repo);
    d.prepare("INSERT INTO issues (id, objective, status, repo, created_at, updated_at) VALUES (9, 'o', 'open', 'repo', ?, ?)").run(TASK_AT, TASK_AT);
    d.close();
  });

  it('is a registered gate', () => {
    assert.equal(findGate('close-forge-merged'), closeForgeMerged);
    assert.ok(gateNames().includes('close-forge-merged'));
  });

  it('SC1: closes a task whose PR merged after it was created, with one bypass row and nothing on stdout', async () => {
    addTask(1, 'feat/x');
    answer(prList([{ head: 'feat/x', mergedAt: AFTER_TASK }]));
    assert.deepEqual(await closeForgeMerged(PAYLOAD, env()), ALLOW);
    assert.equal(taskStatus(1), 'closed');
    assert.deepEqual(bypassRows(), ['{"task_id":1,"commit_sha":"abc1234","closed_by":"close-forge-merged"}']);
    const fromNodes = rows<{ from_node: string }>("SELECT from_node FROM audit WHERE event_type = 'review_gate_bypassed'").map((r) => r.from_node);
    assert.deepEqual(fromNodes, ['hook:close-issue-on-merge']);
    assert.match(readFileSync(ghLog, 'utf8'), /^pr list --state merged --json headRefName,number,mergedAt,body,closingIssuesReferences --limit 100$/m);

    // A second run finds no live branch: no gh, no second row.
    rmSync(ghLog, { force: true });
    await closeForgeMerged(PAYLOAD, env());
    assert.equal(bypassRows().length, 1);
    assert.ok(!existsSync(ghLog));
  });

  it('SC1: closes a task with a passing review and writes no bypass row', async () => {
    addTask(1, 'feat/x', 'submitted');
    addPass(1);
    answer(prList([{ head: 'feat/x', mergedAt: AFTER_TASK }]));
    await closeForgeMerged(PAYLOAD, env());
    assert.equal(taskStatus(1), 'closed');
    assert.deepEqual(bypassRows(), []);
  });

  it('closes the issue the merged PR names and leaves other branches live', async () => {
    addTask(1, 'feat/x');
    addTask(2, 'feat/y');
    answer(prList([{ head: 'feat/x', mergedAt: AFTER_TASK, body: 'Closes #9' }]));
    await closeForgeMerged(PAYLOAD, env());
    assert.equal(taskStatus(1), 'closed');
    assert.equal(taskStatus(2), 'running');
    // Task 2 is live off the merged branch, so the issue close is deferred.
    assert.equal(rows<{ status: string }>('SELECT status FROM issues WHERE id = 9')[0].status, 'open');
    assert.ok(auditRows().some((r) => r.event_type === 'issue_auto_close_deferred'));

    answer(prList([{ head: 'feat/y', mergedAt: AFTER_TASK, body: 'Closes #9' }]));
    await closeForgeMerged(PAYLOAD, env());
    assert.equal(taskStatus(2), 'closed');
    assert.equal(rows<{ status: string }>('SELECT status FROM issues WHERE id = 9')[0].status, 'closed');
  });

  it('SC2: an open PR or a PR merged before the task leaves the task and the audit untouched', async () => {
    addTask(1, 'feat/x');
    for (const prs of [
      prList([]),
      prList([{ head: 'feat/x', mergedAt: null }]),
      prList([{ head: 'feat/x', mergedAt: BEFORE_TASK }]),
      prList([{ head: 'feat/x', mergedAt: TASK_AT }]),
      prList([{ head: 'feat/other', mergedAt: AFTER_TASK }]),
    ]) {
      answer(prs);
      assert.deepEqual(await closeForgeMerged(PAYLOAD, env()), ALLOW);
      assert.equal(taskStatus(1), 'running', prs);
      assert.deepEqual(auditRows(), [], prs);
    }
  });

  it('SC2: a branch reused after its PR merged keeps its tasks while the newest one postdates the merge', async () => {
    sql("INSERT INTO issues (id, objective, status, repo, created_at, updated_at) VALUES (8, 'o', 'open', 'repo', ?, ?)", TASK_AT, TASK_AT);
    addTask(1, 'feat/x', 'running', '2026-10-20T09:00:00.000Z', 8);
    addTask(2, 'feat/x');
    answer(prList([{ head: 'feat/x', mergedAt: '2026-10-22T09:00:00Z' }]));
    await closeForgeMerged(PAYLOAD, env());
    assert.equal(taskStatus(1), 'running');
    assert.equal(taskStatus(2), 'running');
    assert.deepEqual(auditRows(), []);
  });

  it('SC3: gh failing, printing bad JSON or missing allows and writes nothing; a later working gh closes the task', async () => {
    addTask(1, 'feat/x');
    for (const body of ['exit 1', "printf 'not json'", `printf '{"headRefName":"feat/x"}'`, `cat '${join(root, 'answer.json')}'; exit 2`]) {
      writeFileSync(join(root, 'answer.json'), prList([{ head: 'feat/x', mergedAt: AFTER_TASK }]));
      fakeGh(body);
      assert.deepEqual(await closeForgeMerged(PAYLOAD, env()), ALLOW, body);
      assert.equal(taskStatus(1), 'running', body);
      assert.deepEqual(auditRows(), [], body);
    }
    rmSync(join(bin, 'gh'));
    assert.deepEqual(await closeForgeMerged(PAYLOAD, env({ PATH: bin })), ALLOW);
    assert.equal(taskStatus(1), 'running');

    answer(prList([{ head: 'feat/x', mergedAt: AFTER_TASK }]));
    await closeForgeMerged(PAYLOAD, env());
    assert.equal(taskStatus(1), 'closed');
    assert.equal(bypassRows().length, 1);
  });

  it('SC3: a hanging gh is cut at the deadline, allows and writes nothing', async () => {
    addTask(1, 'feat/x');
    fakeGh('exec sleep 30');
    const { value, expired } = await runWithDeadline(performance.now() + 500, () => closeForgeMerged(PAYLOAD, env()));
    assert.deepEqual(value, ALLOW);
    assert.ok(expired, 'the deadline cut gh off');
    assert.equal(taskStatus(1), 'running');
    assert.deepEqual(auditRows(), []);
  });

  it('SC4: with no live branch it spawns no gh', async () => {
    answer(prList([{ head: 'feat/x', mergedAt: AFTER_TASK }]));
    await closeForgeMerged(PAYLOAD, env());
    addTask(1, 'feat/x', 'closed');
    addTask(2, '', 'running');
    await closeForgeMerged(PAYLOAD, env());
    assert.ok(!existsSync(ghLog));
  });

  it('runs no gh and writes nothing on its bypass', async () => {
    addTask(1, 'feat/x');
    answer(prList([{ head: 'feat/x', mergedAt: AFTER_TASK }]));
    await closeForgeMerged(PAYLOAD, env({ TMB_DISABLE_CLOSE_FORGE_MERGED: '1' }));
    assert.equal(taskStatus(1), 'running');
    assert.ok(!existsSync(ghLog));
  });

  it('runs gh in the task repo\'s registered directory', async () => {
    addTask(1, 'feat/x');
    fakeGh(`pwd >> '${ghLog}'; printf '[]'`);
    await closeForgeMerged(PAYLOAD, env());
    const lines = readFileSync(ghLog, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /\/repo$/);
  });
});

describe('mergedPrs', () => {
  it('keeps merged PRs with a head, oldest merge first', () => {
    const prs = mergedPrs(
      JSON.stringify([
        { headRefName: 'b', mergedAt: '2026-10-26T00:00:00Z' },
        { headRefName: 'a', mergedAt: '2026-10-25T00:00:00Z' },
        { headRefName: '', mergedAt: '2026-10-25T00:00:00Z' },
        { headRefName: 'c', mergedAt: null },
        { headRefName: 'd', mergedAt: 'not a date' },
        null,
        7,
      ]),
    );
    assert.deepEqual(
      prs?.map((p) => p.head),
      ['a', 'b'],
    );
    assert.equal(prs?.[0].mergedMs, Date.parse('2026-10-25T00:00:00Z'));
    assert.deepEqual(JSON.parse(prs?.[0].json ?? ''), { headRefName: 'a', mergedAt: '2026-10-25T00:00:00Z' });
  });

  it('is null on anything but a JSON array', () => {
    for (const out of ['', 'not json', '{}', '"x"', 'null']) assert.equal(mergedPrs(out), null, out);
  });
});
