/**
 * The prepush_observed row (GH 3281 slice 2), from both observers:
 * git-push-guard's deny path, the hook judge fed the ref lines git would have
 * sent, and observePush itself for the stdin-read-error and judge-throw
 * paths. An observing failure never changes the guard's deny.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { observePush } from '../hooks/pre-push/observe.js';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';
import { commit, DENY, GATE, gateEnv, git, initRepo, newDb, signTask, sql } from './git-push-guard-l3.js';

interface Observed {
  repo: string;
  source: string;
  deny_class: string | null;
  command_form: string | null;
  remote: string;
  refs: { local_ref: string; local_sha: string; remote_ref: string; remote_sha: string }[];
  hook_verdict: string;
  reason: string;
  legacy_verdict: string;
  agree: boolean;
  hook_live: { listed: boolean; command_matches: boolean; script_intact: boolean; switched_off: boolean };
  session_id: string | null;
}

let sb: Sandbox;
let n = 0;
const ZERO = '0'.repeat(40);

before(() => {
  sb = makeSandbox('prepush-observe');
});
after(() => sb.remove());

/** A repo `work` on main pushed to its origin, with a DB whose repos row protects main. */
function setup(): { repo: string; db: string } {
  n += 1;
  const repo = join(sb.dir, `work-${n}`);
  initRepo(sb.env, repo, 'main');
  commit(sb.env, repo, 'init', { 'README.md': 'init\n' });
  git(sb.env, repo, 'push', '-qu', 'origin', 'main');
  const db = newDb(repo);
  sql(db, `INSERT INTO repos (name, path, target_branch, protected_branches) VALUES ('work', ?, 'main', '["main"]')`, repo);
  return { repo, db };
}

function addTask(db: string, id: number, branch: string, sha: string): void {
  sql(
    db,
    `INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, created_at, updated_at)
       VALUES (?, 1, ?, ?, 'd', 'closed', '## body', ?, 'work', datetime('now'), datetime('now'))`,
    id, branch, `task ${id}`, sha,
  );
}

function rows(db: string): { from_node: string; issue_id: number; content: Observed }[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return (d.prepare("SELECT from_node, issue_id, content_json FROM audit WHERE event_type = 'prepush_observed' ORDER BY id").all() as { from_node: string; issue_id: number; content_json: string }[]).map(
      (r) => ({ from_node: r.from_node, issue_id: r.issue_id, content: JSON.parse(r.content_json) as Observed }),
    );
  } finally {
    d.close();
  }
}

function guard(repo: string, db: string, command: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const r = runGate(GATE, {
    cwd: repo,
    input: JSON.stringify({ tool_input: { command }, session_id: 'sess-1' }),
    env: { ...gateEnv(sb, repo), TRAJECTORY_DB_PATH: db, ...extraEnv },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

describe('git-push-guard deny path records the hook judge beside it (SC6)', () => {
  it('GH 3187 shape: a retry branch carrying its failed task\'s commit — the guard denies, the hook judge admits, agree false', () => {
    const { repo, db } = setup();
    git(sb.env, repo, 'checkout', '-q', '-b', 'fix/a');
    const failed = commit(sb.env, repo, 'feat: f', { 'f.txt': 'f\n' });
    addTask(db, 11, 'fix/a', failed);
    git(sb.env, repo, 'checkout', '-q', '-b', 'fix/b');
    const tip = commit(sb.env, repo, 'feat: g', { 'g.txt': 'g\n' });
    addTask(db, 23, 'fix/b', tip);
    signTask(db, 23);

    const out = guard(repo, db, 'git push -u origin fix/b');
    assert.ok(out.includes(DENY), `the command-text judge denies the carried commit:\n${out}`);
    const written = rows(db);
    assert.equal(written.length, 1);
    const [row] = written;
    assert.equal(row.from_node, 'hook:git-push-guard');
    assert.equal(row.issue_id, -1);
    assert.equal(row.content.legacy_verdict, 'deny');
    assert.equal(row.content.hook_verdict, 'admit', row.content.reason);
    assert.equal(row.content.agree, false);
    assert.equal(row.content.repo, 'work');
    assert.equal(row.content.remote, 'origin');
    assert.equal(row.content.session_id, 'sess-1');
    assert.deepEqual(row.content.refs, [{ local_ref: 'refs/heads/fix/b', local_sha: tip, remote_ref: 'refs/heads/fix/b', remote_sha: ZERO }]);
    assert.deepEqual(row.content.hook_live, { listed: false, command_matches: false, script_intact: false, switched_off: false });
    assert.equal(row.content.source, 'legacy_deny');
    assert.equal(row.content.deny_class, null);
    assert.equal(row.content.command_form, null);
  });

  it('with prepush_hook off the command-text judge still denies an unreviewed push, and the row says switched_off', () => {
    const { repo, db } = setup();
    sql(db, "INSERT INTO plugin_config (key, value_json) VALUES ('prepush_hook', '\"off\"')");
    const sha = commit(sb.env, repo, 'feat: s', { 's.txt': 's\n' });
    addTask(db, 8, 'fix/s', sha);
    assert.ok(guard(repo, db, 'git push origin main').includes(DENY));
    const [row] = rows(db);
    assert.equal(row.content.legacy_verdict, 'deny');
    assert.equal(row.content.hook_live.switched_off, true);
  });

  it('both judges deny an unreviewed push to a protected branch: agree true, remote sha from origin/main', () => {
    const { repo, db } = setup();
    const base = git(sb.env, repo, 'rev-parse', 'HEAD');
    const sha = commit(sb.env, repo, 'feat: x', { 'x.txt': 'x\n' });
    addTask(db, 5, 'fix/x', sha);

    assert.ok(guard(repo, db, 'git push origin main').includes(DENY));
    const [row] = rows(db);
    assert.equal(row.content.hook_verdict, 'deny');
    assert.match(row.content.reason, /refs\/heads\/main is a protected branch/);
    assert.equal(row.content.agree, true);
    assert.deepEqual(row.content.refs, [{ local_ref: 'refs/heads/main', local_sha: sha, remote_ref: 'refs/heads/main', remote_sha: base }]);
  });

  it('a delete refspec is synthesized as git sends it: (delete) and the zero sha', () => {
    const { repo, db } = setup();
    const sha = commit(sb.env, repo, 'feat: y', { 'y.txt': 'y\n' });
    addTask(db, 6, 'fix/y', sha);
    git(sb.env, repo, 'push', '-q', 'origin', 'main:refs/heads/doomed');
    git(sb.env, repo, 'fetch', '-q', 'origin');
    const remoteMain = git(sb.env, repo, 'rev-parse', 'origin/main');
    assert.ok(guard(repo, db, 'git push origin main :refs/heads/doomed').includes(DENY));
    const [row] = rows(db);
    assert.deepEqual(
      [...row.content.refs].sort((a, b) => a.remote_ref.localeCompare(b.remote_ref)),
      [
        { local_ref: '(delete)', local_sha: ZERO, remote_ref: 'refs/heads/doomed', remote_sha: sha },
        { local_ref: 'refs/heads/main', local_sha: sha, remote_ref: 'refs/heads/main', remote_sha: remoteMain },
      ],
    );
  });

  it('a failing observe write is swallowed: the deny is unchanged and no row lands', () => {
    const { repo, db } = setup();
    const sha = commit(sb.env, repo, 'feat: z', { 'z.txt': 'z\n' });
    addTask(db, 7, 'fix/z', sha);
    const plain = guard(repo, db, 'git push origin main');
    sql(db, "DELETE FROM audit WHERE event_type = 'prepush_observed'");
    sql(db, "CREATE TRIGGER no_observe BEFORE INSERT ON audit WHEN NEW.event_type = 'prepush_observed' BEGIN SELECT RAISE(ABORT, 'observe write refused'); END");
    assert.equal(guard(repo, db, 'git push origin main'), plain);
    assert.deepEqual(rows(db), []);
  });

  it('an admitted push writes no row from the guard', () => {
    const { repo, db } = setup();
    git(sb.env, repo, 'checkout', '-q', '-b', 'spike');
    commit(sb.env, repo, 'spike', { 's.txt': 's\n' });
    assert.ok(!guard(repo, db, 'git push origin spike').includes(DENY));
    assert.deepEqual(rows(db), []);
  });
});

describe('observePush: the error verdicts (SC5)', () => {
  const observe = (repo: string, db: string, refLines: string | null, judge?: Parameters<typeof observePush>[2]) =>
    observePush(
      { dir: repo, remote: 'origin', refLines, readError: refLines === null ? 'EAGAIN' : undefined, legacyVerdict: 'admit', sessionId: '', caller: 'pre-push' },
      { ...sb.env, TRAJECTORY_DB_PATH: db },
      judge,
    );

  it('a stdin read error records hook_verdict error', async () => {
    const { repo, db } = setup();
    const r = await observe(repo, db, null);
    assert.equal(r.ok, true);
    const [row] = rows(db);
    assert.equal(row.from_node, 'hook:pre-push');
    assert.equal(row.content.source, 'pre_push');
    assert.equal(row.content.hook_verdict, 'error');
    assert.match(row.content.reason, /could not read git's ref lines on stdin \(EAGAIN\)/);
    assert.equal(row.content.agree, false);
    assert.equal(row.content.session_id, null);
  });

  it('a judge that throws records hook_verdict error', async () => {
    const { repo, db } = setup();
    const head = git(sb.env, repo, 'rev-parse', 'HEAD');
    const r = await observe(repo, db, `refs/heads/main ${head} refs/heads/main ${ZERO}\n`, () =>
      Promise.reject(new Error('judge exploded')),
    );
    assert.equal(r.ok, true);
    const [row] = rows(db);
    assert.equal(row.content.hook_verdict, 'error');
    assert.equal(row.content.reason, 'the pre-push judge threw: judge exploded');
    assert.equal(row.content.refs.length, 1);
  });
});
