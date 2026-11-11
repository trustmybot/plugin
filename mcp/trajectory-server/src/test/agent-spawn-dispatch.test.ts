/**
 * agent-spawn-dispatch end to end (GH 1692): code-reviewer-spawn-prompt-shape
 * names each missing anchor; a clean swe spawn passes the whole chain
 * silently; rework-limit denies a swe spawn after two review FAILs until a
 * task_rework_analysis plus its proven change, or a Human decision (not a bro
 * one), is newer; and a tmb:code-reviewer spawn for a
 * closed, verified task passes every gate (GH 1641). Each case runs
 * `node dist/hooks.js <gate>` in a sandbox with its own HOME. The chain order,
 * the first-deny short-circuit and the context union are in
 * hooks-agent-spawn-dispatch; the single-gate denies through the dispatcher
 * are the agent-spawn-dispatch hook-corpus payloads.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';

const DENY = '"permissionDecision":"deny"';
const GIT_ID = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

const agent = (toolInput: Record<string, unknown>) => JSON.stringify({ tool_name: 'Agent', tool_input: toolInput });

function exec(path: string, sql: string, ...params: string[]): void {
  const db = new DatabaseSync(path);
  try {
    if (params.length === 0) db.exec(sql);
    else db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

describe('agent-spawn-dispatch end to end', () => {
  let sb: Sandbox;

  before(() => {
    sb = makeSandbox('agent-spawn-dispatch');
  });

  after(() => sb.remove());

  function git(dir: string, ...args: string[]): string {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...sb.env, ...GIT_ID } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }

  function repo(dir: string, branch: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'dev');
    writeFileSync(join(dir, 'README.md'), 'init\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-qm', 'init');
    git(dir, 'branch', branch);
  }

  const dispatch = (cwd: string, input: string, db: string) =>
    runGate('agent-spawn-dispatch', { cwd, input, env: { ...sb.env, TRAJECTORY_DB_PATH: db } }).stdout;

  describe('code-reviewer-spawn-prompt-shape names each missing anchor', () => {
    const shape = (prompt: string) => runGate('code-reviewer-spawn-prompt-shape', { cwd: sb.dir, input: agent({ subagent_type: 'code-reviewer', prompt }), env: sb.env }).stdout;

    it('the legacy four anchors miss attempt_n and subagent_session_id', () => {
      const out = shape('task_id=42 commit_sha=abc123 branch_id=fix/foo repo=plugin');
      assert.ok(out.includes(DENY), 'deny decision emitted');
      assert.ok(out.includes('attempt_n'), 'missing attempt_n named');
      assert.ok(out.includes('subagent_session_id'), 'missing subagent_session_id named');
    });

    it('a prompt without repo_path is denied naming repo_path alone', () => {
      const out = shape('task_id=42 commit_sha=abc123 branch_id=fix/foo repo=plugin attempt_n=1 subagent_session_id=sess-xyz');
      assert.ok(out.includes(DENY), 'deny decision emitted');
      assert.ok(out.includes('anchors: repo_path.'), 'missing repo_path named alone');
    });

    it('a prompt with repo_path but no repo= is denied naming repo alone', () => {
      const out = shape('task_id=42 commit_sha=abc123 branch_id=fix/foo repo_path=/work/plugin attempt_n=1 subagent_session_id=sess-xyz');
      assert.ok(out.includes(DENY), 'deny decision emitted');
      assert.ok(out.includes('anchors: repo.'), 'missing repo named alone');
    });
  });

  describe('a clean swe spawn, then the rework limit', () => {
    let work: string;
    let db: string;
    let effort = 'medium';
    const spawn = () => dispatch(work, agent({ subagent_type: 'swe', effort, prompt: 'task_id=1 worktree=/some/path You are SWE.' }), db);

    before(() => {
      work = join(sb.dir, 'clean');
      repo(work, 'fix/1-foo');
      git(work, 'worktree', 'add', '-q', join(work, '.claude/worktrees/1-foo'), 'fix/1-foo');
      db = join(work, 'trajectory.db');
      exec(
        db,
        `CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL, status TEXT NOT NULL,
           spec_body TEXT NOT NULL DEFAULT '', repo TEXT, parent_branch_id TEXT, files TEXT, effort TEXT NOT NULL DEFAULT 'medium');
         CREATE TABLE issues (id INTEGER PRIMARY KEY, objective TEXT NOT NULL DEFAULT 'test', description TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL DEFAULT 'open', labels TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
         CREATE TABLE repos (name TEXT, path TEXT);
         CREATE TABLE validation_attempts (id INTEGER PRIMARY KEY, task_id INTEGER, verdict TEXT, created_at TEXT);
         CREATE TABLE discussions (id INTEGER PRIMARY KEY, issue_id INTEGER, task_id INTEGER, author TEXT, kind TEXT, created_at TEXT);
         CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_type TEXT, exit_reason TEXT, stop_cause TEXT, started_at TEXT);
         CREATE TABLE audit (id INTEGER PRIMARY KEY, issue_id INTEGER, event_type TEXT, content_json TEXT, created_at TEXT);
         INSERT INTO issues (id) VALUES (1);
         INSERT INTO tasks (id, issue_id, branch_id, status, spec_body) VALUES (1, 1, 'fix/1-foo', 'pending', '## spec body');`,
      );
      exec(db, "INSERT INTO repos (name, path) VALUES ('fixture', ?)", work);
    });

    it('a swe spawn with a valid task_id and an existing branch passes silently', () => {
      assert.equal(spawn(), '', 'silent pass: no deny, no context');
    });

    it('after two review FAILs the spawn is denied until an analysis plus its proven change; no Human row lifts it', () => {
      exec(db, "INSERT INTO validation_attempts (task_id, verdict, created_at) VALUES (1, 'fail', '2026-10-25T10:01:00.000Z'), (1, 'fail', '2026-10-25T10:02:00.000Z');");
      exec(db, "UPDATE tasks SET effort = 'high' WHERE id = 1;");
      effort = 'high';
      let out = spawn();
      assert.ok(out.includes(DENY), 'deny decision emitted');
      assert.ok(out.includes('task FAILs: 2 review FAILs on the task since its last passing review'),'rework-limit names the task-FAILs limit');
      assert.ok(out.includes('task_rework_analysis'), 'rework-limit names the analysis step');
      assert.ok(!/[Ww]aive|Human/.test(out), 'the rework limit asks nothing of the Human');
      exec(db, "INSERT INTO discussions (issue_id, task_id, author, kind, created_at) VALUES (1, 1, 'bro', 'decision', '2026-10-25T11:00:00.000Z');");
      out = spawn();
      assert.ok(out.includes(DENY), 'a newer bro decision keeps the spawn denied');
      exec(
        db,
        `INSERT INTO audit (issue_id, event_type, content_json, created_at) VALUES
           (1, 'task_rework_analysis', '{"task_id":1,"root_cause":"spec_unclear","change":"spec_update"}', '2026-10-25T11:10:00.000Z');`,
      );
      out = spawn();
      assert.ok(out.includes(DENY), 'an analysis with no proven change keeps the spawn denied');
      exec(db, `INSERT INTO audit (issue_id, event_type, content_json, created_at) VALUES (1, 'task_spec_amended', '{"task_id":1}', '2026-10-25T11:20:00.000Z');`);
      out = spawn();
      assert.ok(!out.includes(DENY), 'an analysis plus a newer task_spec_amended lets the spawn through');
      exec(db, "INSERT INTO validation_attempts (task_id, verdict, created_at) VALUES (1, 'fail', '2026-10-25T11:30:00.000Z');");
      out = spawn();
      assert.ok(out.includes(DENY), 'a third FAIL needs a fresh analysis');
      exec(db, "INSERT INTO discussions (issue_id, task_id, author, kind, created_at) VALUES (1, 1, 'human', 'decision', '2026-10-25T12:00:00.000Z');");
      out = spawn();
      assert.ok(out.includes(DENY), "a newer author 'human' decision keeps the spawn denied");
    });
  });

  it('a tmb:code-reviewer spawn for a verified task handed off at its commit passes every Agent-spawn gate silently (GH 1641)', () => {
    const work = join(sb.dir, 'review');
    const r = join(work, 'repo');
    repo(r, 'fix/5-pr');
    git(r, 'checkout', '-q', 'fix/5-pr');
    mkdirSync(join(r, 'changelog.d'));
    writeFileSync(join(r, 'changelog.d/5-pr.md'), '- the change\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-qm', 'feature');
    const sha = git(r, 'rev-parse', 'HEAD');
    const db = join(work, 'trajectory.db');
    exec(
      db,
      `CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL DEFAULT 1, branch_id TEXT NOT NULL,
         status TEXT NOT NULL, spec_body TEXT NOT NULL DEFAULT '', repo TEXT, parent_branch_id TEXT, files TEXT,
         commit_sha TEXT, effort TEXT NOT NULL DEFAULT 'medium');
       CREATE TABLE issues (id INTEGER PRIMARY KEY, objective TEXT NOT NULL DEFAULT 'test');
       CREATE TABLE repos (name TEXT, path TEXT, target_branch TEXT);
       CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
       CREATE TABLE verification_runs (id INTEGER PRIMARY KEY, task_id INTEGER, commit_sha TEXT, exit_code INTEGER, timed_out INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE validation_attempts (id INTEGER PRIMARY KEY, task_id INTEGER, verdict TEXT, created_at TEXT);
       CREATE TABLE discussions (id INTEGER PRIMARY KEY, issue_id INTEGER, task_id INTEGER, author TEXT, kind TEXT, created_at TEXT);
       CREATE TABLE audit (id INTEGER PRIMARY KEY, event_type TEXT NOT NULL, content_json TEXT);
       INSERT INTO issues (id) VALUES (1);`,
    );
    exec(db, "INSERT INTO repos (name, path, target_branch) VALUES ('plugin', ?, 'dev')", r);
    exec(db, "INSERT INTO tasks (id, branch_id, status, repo, parent_branch_id, commit_sha) VALUES (5, 'fix/5-pr', 'completed', 'plugin', 'dev', ?)", sha);
    exec(db, 'INSERT INTO verification_runs (task_id, commit_sha, exit_code) VALUES (5, ?, 0)', sha);
    exec(db, "INSERT INTO audit (event_type, content_json) VALUES ('review_handoff', json_object('task_id', 5, 'commit_sha', ?))", sha);
    const prompt = `task_id=5 commit_sha=${sha} branch_id=fix/5-pr repo=plugin repo_path=${r} attempt_n=1 subagent_session_id=sess-xyz`;
    const input = agent({ subagent_type: 'tmb:code-reviewer', effort: 'medium', prompt });
    assert.equal(dispatch(r, input, db), '', 'no deny, no rewrite, no context for the canonical reviewer name');
    exec(db, "UPDATE tasks SET status = 'running' WHERE id = 5;");
    assert.ok(dispatch(r, input, db).includes('has no review_handoff'), 'control: the same fixture with an open task is denied');
  });
});
