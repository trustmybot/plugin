/**
 * remote-id-guard and no-remote-auth-guard end to end (GH 1692), the l3 bash
 * suites' cases in node:test. remote-id-guard denies remote-write text (gh/glab
 * create|edit|comment|close|… with author text) citing a local trajectory issue
 * id whose remote iid differs, naming the right remote ref; real refs, reads,
 * explicit remote markers (GH 1304), heredoc or quoted data (GH 1196), a missing
 * DB and TMB_DISABLE_REMOTE_ID_GUARD=1 allow, and an analysis past its deadline
 * allows with one stderr line and one remote_id_guard_overrun row (GH 1821),
 * plus every payload of tests/fixtures/hook-corpus/remote-id-guard/.
 * no-remote-auth-guard denies `gh auth login` / `glab auth login` while no
 * remote has a url, resolved from the command's cd target (H6), and fails open
 * without a DB, repo or repo_remotes table. Each case runs
 * `node dist/hooks.js <gate>` with CLAUDE_PROJECT_DIR pinned to a sandbox and
 * PWD set.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HOOKS_JS, makeSandbox, noCmdPath, PLUGIN_ROOT, runGate, type HookRun, type Sandbox } from './hook-sandbox.js';
import { DENY, gateEnv, git, has, hasNot, sql } from './git-push-guard-l3.js';
import { migratedDb, sqlExec } from './db-test-fixtures.js';
import { LOCAL_ISSUES, materialize } from './hooks-remote-id-guard-parity.suite.js';

const CORPUS = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus/remote-id-guard');

const bashInput = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
/** stdout as a `$(...)` reads it: trailing newlines gone. */
const out = (r: HookRun) => r.stdout.replace(/\n+$/, '');
const silent = (r: HookRun, msg: string) => assert.equal(out(r), '', msg);

function once<T>(f: () => T): () => T {
  let v: { value: T } | undefined;
  return () => (v ??= { value: f() }).value;
}

describe('remote-id-guard l3', () => {
  const GATE = 'remote-id-guard';
  let sb: Sandbox;
  let db: string;
  let project: string;
  let hooksJs: string;

  function run(input: string, env: NodeJS.ProcessEnv = {}): HookRun {
    return runGate(GATE, { cwd: project, input, hooksJs, env: { ...gateEnv(sb, project), TRAJECTORY_DB_PATH: db, ...env } });
  }
  const hook = (command: string, env: NodeJS.ProcessEnv = {}) => run(bashInput(command), env);

  const overrunRows = () => {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
      return (d.prepare("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'remote_id_guard_overrun'").get() as { n: number }).n;
    } finally {
      d.close();
    }
  };

  before(() => {
    sb = makeSandbox('remote-id-guard-l3');
    project = join(sb.dir, 'project');
    mkdirSync(project);
    hooksJs = join(sb.dir, 'hooks.js');
    symlinkSync(HOOKS_JS, hooksJs);
    db = join(sb.dir, 'trajectory.db');
    migratedDb(db);
    for (const [id, objective, gh, gl] of LOCAL_ISSUES) {
      sql(
        db,
        "INSERT INTO issues (id, objective, gh_iid, gl_iid, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        id,
        objective,
        gh,
        gl,
      );
    }
    sqlExec(join(sb.dir, 'no-issues.db'), 'CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT)');
    writeFileSync(join(sb.dir, 'bad.db'), 'this is not a sqlite database\n');
  });
  after(() => sb.remove());

  describe('(a) a local id whose remote iid differs: deny', () => {
    const a = once(() => hook("gh pr create --title x --body 'Closes #5'"));
    it('(a) gh pr create body citing local #5 (gh_iid 42): deny', () => has(out(a()), DENY, 'deny decision'));
    it('(a) deny reason names the correct remote ref #42', () => has(out(a()), '#42', 'correct remote ref shown'));
    it("GH 1864: deny reason quotes the local issue's objective", () => has(out(a()), 'local #5: \\"Local five | pipe title\\"', 'objective quoted'));
    it('(a) deny output is valid JSON', () => assert.doesNotThrow(() => JSON.parse(a().stdout), `not JSON: ${a().stdout}`));
    it('(a) -b short flag form also denies', () => has(out(hook("gh pr create -t x -b 'fixes #5'")), DENY, 'deny on -b form'));
    it('(a) gh issue close --comment with local #5: deny', () =>
      has(out(hook("gh issue close 1 --comment 'dup of #5'")), DENY, 'deny on issue close comment'));
    it('(a) glab mr create body with local #7 (gl_iid 88): deny, shows #88', () => {
      const o = out(hook("glab mr create --title x --description 'see #7'"));
      has(o, DENY, 'deny on glab gl_iid mismatch');
      has(o, '#88', 'correct gl remote ref shown');
    });
  });

  describe('(H7) the provider decides which iid to cite', () => {
    const gl = once(() => out(hook("glab mr create --title x --description 'see #10'")));
    it('(H7) gh pr create citing local #10: deny, shows the GitHub iid #50', () => {
      const o = out(hook("gh pr create --title x --body 'see #10'"));
      has(o, DENY, 'gh provider must deny on #10');
      has(o, '#50', 'gh command must resolve the GitHub iid');
      has(o, 'GitHub', 'gh command must name GitHub');
    });
    it('(H7) glab mr create citing local #10: deny, shows the GitLab iid #60 (not #50)', () => {
      has(gl(), DENY, 'glab provider must deny on #10');
      has(gl(), '#60', 'glab command must resolve the GitLab iid, not the GitHub one');
      has(gl(), 'GitLab', 'glab command must name GitLab');
    });
    it('(H7) glab mr create citing #10 does NOT cite the GitHub iid #50', () => hasNot(gl(), '#50', 'glab command must not surface the GitHub iid'));
  });

  describe('(b)-(e) real refs, reads, a missing DB and the bypass: allow', () => {
    it('(b) gh pr create body citing #42 (aligned/real ref): allow (silent)', () =>
      silent(hook("gh pr create --title x --body 'Closes #42'"), 'aligned ref allowed'));
    it('(b) gh pr create citing #9 (local but unmapped): allow', () => silent(hook("gh pr create --title x --body 'about #9'"), 'unmapped local id left alone'));
    it('(b) gh pr create citing #999 (not a local id at all): allow', () =>
      silent(hook("gh pr create --title x --body 'see #999'"), 'non-local ref left alone'));
    it('(c) gh pr list: no-op (silent)', () => silent(hook('gh pr list'), 'read command silent'));
    it('(c) gh issue view 5: no-op even though #5 mismatched', () => silent(hook('gh issue view 5'), 'view is a read, no text flag'));
    it('(c) gh pr create WITHOUT author text (no body/title): no-op', () => silent(hook('gh pr create --fill'), 'no author text → no scan'));
    it('(d) missing DB: fail-open (allow)', () =>
      silent(hook("gh pr create --body 'Closes #5'", { TRAJECTORY_DB_PATH: join(sb.dir, 'no-such.db') }), 'missing DB → allow'));
    it('(d) DB without issues table: fail-open (allow)', () =>
      silent(hook("gh pr create --body 'Closes #5'", { TRAJECTORY_DB_PATH: join(sb.dir, 'no-issues.db') }), 'absent issues table → allow'));
    it('(e) TMB_DISABLE_REMOTE_ID_GUARD=1: bypass (allow)', () =>
      silent(hook("gh pr create --body 'Closes #5'", { TMB_DISABLE_REMOTE_ID_GUARD: '1' }), 'bypass env honored'));
  });

  describe('(f)-(h) explicit remote markers (GH 1304)', () => {
    it('(f) GH-5 marker: allow (silent)', () => silent(hook("gh pr create --body 'Fixes GH-5'"), 'GH-<n> is an explicit remote id'));
    it('(g) remote:5 and owner/repo#5 markers: allow (silent)', () =>
      silent(hook("gh pr create --body 'see remote:5 and trustmybot/plugin#5'"), 'remote:<n> and owner/repo#<n> are explicit remote ids'));
    it('(g) GL-5 marker: allow (silent)', () => silent(hook("glab mr create --title x --description 'see gl-5'"), 'GL-<n> is an explicit remote id'));
    it('(h) GH-5 plus bare #5: deny, reason shows local objective and marker hint', () => {
      const o = out(hook("gh issue comment 9 --body 'GH-5 and #5'"));
      has(o, DENY, 'bare #5 still caught');
      has(o, '#5 → #42 (GitHub)', 'mapping shown');
      has(o, 'Local five | pipe title', 'local objective shown, pipe intact');
      has(o, 'GH-<n>', 'marker hint shown');
    });
  });

  describe('GH 1196: a remote-write named in a heredoc or quoted text is data', () => {
    it('GH 1196: markdown heredoc quoting a gh pr create citing #5: allow', () =>
      silent(hook("cat > notes.md <<'EOF'\ngh pr create --body 'Closes #5'\nEOF"), 'heredoc content is not a remote write'));
    it('GH 1196: echo quoting a gh issue comment citing #5: allow', () =>
      silent(hook(`echo "gh issue comment 1 --body 'see #5'"`), 'quoted text is not a remote write'));
  });

  describe("GH 1821: the guard bounds its own work below dispatch's 6 s budget", () => {
    const PATHOLOGICAL = 'echo a && '.repeat(1000) + "gh pr create --title x --body 'Closes #5'";
    const overrunEnv = { TMB_REMOTE_ID_GUARD_DEADLINE_S: '1', TMB_REMOTE_ID_GUARD_TEST_OVERRUN: '1' };
    let before: number;
    let overrun: HookRun;
    let elapsed: number;

    it("GH 1821: heredoc + compound gh api && python3 - <<'EOF' repro: allowed well under 6 s", () => {
      const c = materialize(join(CORPUS, 'bash-gh-api-heredoc-compound.json'), sb.dir, { noJq: '', noSqlite: '' });
      const t0 = Date.now();
      const r = run(c.input);
      const ms = Date.now() - t0;
      assert.equal(r.status, 0, 'repro exit code');
      assert.equal(out(r), '', 'repro stdout');
      assert.ok(ms < 4000, `repro took ${ms}ms, want < 4000ms (default 3 s deadline + 1 s)`);
    });

    it('GH 1821: analysis past TMB_REMOTE_ID_GUARD_DEADLINE_S=1 allows within deadline + 1 s', () => {
      before = overrunRows();
      const t0 = Date.now();
      overrun = hook(PATHOLOGICAL, overrunEnv);
      elapsed = Date.now() - t0;
      assert.equal(overrun.status, 0, 'overrun exit code');
      assert.equal(out(overrun), '', 'overrun stdout (no deny JSON)');
      assert.ok(elapsed < 2000, `overrun took ${elapsed}ms, want < 2000ms`);
    });

    it('GH 1821: overrun prints one stderr line naming the deadline', () => {
      const err = overrun.stderr.replace(/\n+$/, '');
      assert.equal(err.split('\n').filter((l) => l !== '').length, 1, 'stderr line count');
      has(err, '1s deadline (TMB_REMOTE_ID_GUARD_DEADLINE_S)', 'stderr names the deadline');
    });

    it('GH 1821: overrun writes one remote_id_guard_overrun audit row', () => {
      const now = overrunRows();
      assert.equal(now, before + 1, 'overrun row count');
      assert.ok(now > 0, 'no remote_id_guard_overrun rows');
      const d = new DatabaseSync(db, { readOnly: true });
      let row: { issue_id: number; from_node: string; content_json: string };
      try {
        row = d
          .prepare("SELECT issue_id, from_node, content_json FROM audit WHERE event_type = 'remote_id_guard_overrun' ORDER BY id DESC LIMIT 1")
          .get() as typeof row;
      } finally {
        d.close();
      }
      assert.equal(`${row.issue_id}|${row.from_node}`, '-1|hook:remote-id-guard', 'issue and from_node');
      const content = JSON.parse(row.content_json) as { deadline_s: unknown; elapsed_s: unknown };
      assert.equal(String(content.deadline_s), '1', 'content_json.deadline_s');
      assert.ok(typeof content.elapsed_s === 'number' && content.elapsed_s >= 1, `content_json.elapsed_s: ${row.content_json}`);
    });

    it('GH 1821: overrun leaves no process of the guard behind', (t) => {
      spawnSync('sleep', ['0.3']);
      const pg = spawnSync('pgrep', ['-f', hooksJs], { encoding: 'utf8' });
      if (pg.status !== 0 && pg.status !== 1) {
        t.skip(`pgrep cannot list processes here (exit ${pg.status})`);
        return;
      }
      assert.equal(pg.status, 1, `a ${hooksJs} process survived the overrun: ${pg.stdout}`);
    });

    it('GH 1821: overrun with no trajectory DB still allows', () => {
      const r = hook(PATHOLOGICAL, { ...overrunEnv, TRAJECTORY_DB_PATH: join(sb.dir, 'no-such.db') });
      assert.equal(r.status, 0, 'overrun without DB exit code');
      assert.equal(out(r), '', 'overrun without DB stdout');
    });

    it('GH 1821: an invalid TMB_REMOTE_ID_GUARD_DEADLINE_S falls back to the default', () =>
      has(out(hook("gh pr create --title x --body 'Closes #5'", { TMB_REMOTE_ID_GUARD_DEADLINE_S: 'abc' })), DENY, 'deny under the default deadline'));
  });

  describe('hook corpus: the payloads the TS port (GH 1692) inherits', () => {
    for (const name of readdirSync(CORPUS)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      it(`corpus ${name}`, () => {
        const path = sb.env.PATH ?? '';
        const paths = { noJq: noCmdPath(join(sb.dir, `nojq-${name}`), 'jq', path), noSqlite: noCmdPath(join(sb.dir, `nosqlite-${name}`), 'sqlite3', path) };
        const c = materialize(join(CORPUS, name), sb.dir, paths);
        const expect = typeof c.expect === 'object' ? c.expect.ts : c.expect;
        const r = run(c.input, c.env);
        assert.equal(r.status, 0, `${name} exit code`);
        if (expect === 'allow') {
          assert.equal(out(r), '', `${name} allows`);
          return;
        }
        has(out(r), DENY, `${name} denies`);
        const reason = (JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
        has(reason, expect, `${name} deny reason`);
      });
    }
  });
});

describe('no-remote-auth-guard l3', () => {
  const GATE = 'no-remote-auth-guard';
  const REPOS_SCHEMA = `CREATE TABLE repos (
  name TEXT PRIMARY KEY, path TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  target_branch TEXT, branching_model TEXT, protected_branches TEXT
);
CREATE TABLE repo_remotes (
  repo TEXT NOT NULL REFERENCES repos(name) ON DELETE CASCADE ON UPDATE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github','gitlab','other')),
  url TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo, name)
);`;
  let sb: Sandbox;
  let db: string;
  let dbWithRemote: string;
  let mrDb: string;
  let withRepo: string;
  let normRepo: string;

  function hook(command: string, dbPath = db, cwd = sb.dir): HookRun {
    return runGate(GATE, { cwd, input: bashInput(command), env: { ...gateEnv(sb, cwd), TRAJECTORY_DB_PATH: dbPath } });
  }
  function fixtureDb(name: string, statements: string): string {
    const path = join(sb.dir, name);
    sqlExec(path, statements);
    return path;
  }

  before(() => {
    sb = makeSandbox('no-remote-auth-guard-l3');
    db = fixtureDb(
      'trajectory.db',
      `${REPOS_SCHEMA}
       INSERT INTO repos (name, path) VALUES ('repo', '/tmp/repo');
       INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES ('repo', 'origin', 'github', '', 1);`,
    );
    dbWithRemote = fixtureDb(
      'trajectory-with-remote.db',
      `${REPOS_SCHEMA}
       INSERT INTO repos (name, path) VALUES ('repo', '/tmp/repo');
       INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES ('repo', 'origin', 'github', 'https://github.com/org/repo.git', 1);`,
    );
    withRepo = join(sb.dir, 'with-remote');
    normRepo = join(sb.dir, 'no-remote');
    for (const r of [withRepo, normRepo]) {
      mkdirSync(r);
      git(sb.env, r, 'init', '-q', '-b', 'main');
    }
    const withReal = git(sb.env, withRepo, 'rev-parse', '--show-toplevel');
    const normReal = git(sb.env, normRepo, 'rev-parse', '--show-toplevel');
    mrDb = fixtureDb(
      'multirepo.db',
      `${REPOS_SCHEMA}
       INSERT INTO repos (name, path) VALUES ('with', '${withReal}'), ('norm', '${normReal}');
       INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES
         ('with', 'origin', 'github', 'https://github.com/org/with.git', 1),
         ('norm', 'origin', 'github', '', 1);`,
    );
  });
  after(() => sb.remove());

  describe('login with no remote url: deny', () => {
    const a = once(() => hook('gh auth login'));
    const b = once(() => out(hook('glab auth login')));
    it('(a) gh auth login with no remote url: deny', () => has(out(a()), DENY, 'deny decision'));
    it('(a) gh auth login: deny reason mentions BLOCKED', () => has(out(a()), 'BLOCKED', 'BLOCKED in reason'));
    it("(a) gh auth login: deny reason names tool 'gh'", () => has(out(a()), 'gh auth login', 'tool name in reason'));
    it('(a) gh auth login: output is valid JSON', () => assert.doesNotThrow(() => JSON.parse(a().stdout), `output failed jq parse — got: ${a().stdout}`));
    it('(b) glab auth login with no remote url: deny', () => has(b(), DENY, 'deny decision'));
    it('(b) glab auth login: deny reason mentions BLOCKED', () => has(b(), 'BLOCKED', 'BLOCKED in reason'));
    it("(b) glab auth login: deny reason names tool 'glab'", () => has(b(), 'glab auth login', 'tool name in reason'));
  });

  describe('a remote url, a non-login command or no DB: allow', () => {
    it('(c) gh auth login with remote url present: allow (silent)', () => silent(hook('gh auth login', dbWithRemote), 'no output when remote configured'));
    it('(d) gh auth status: allow (silent)', () => silent(hook('gh auth status'), 'auth status not blocked'));
    it('(e) glab auth status: allow (silent)', () => silent(hook('glab auth status'), 'glab auth status not blocked'));
    it('(f) ls: allow with no output', () => silent(hook('ls'), 'unrelated command silent'));
    it('(g) gh pr list: allow (silent)', () => silent(hook('gh pr list'), 'non-auth gh command silent'));
    it('(h) missing DB: fail-open (allow)', () => silent(hook('gh auth login', join(sb.dir, 'no-such.db')), 'missing DB → allow'));
    it('gh auth token: allow (not login)', () => silent(hook('gh auth token'), 'auth token not blocked'));
    it('glab auth login with remote url present: allow (silent)', () => silent(hook('glab auth login', dbWithRemote), 'glab allow when remote configured'));
    it('no registered repo: fail-open (allow)', () =>
      silent(hook('gh auth login', fixtureDb('trajectory-no-remotes.db', REPOS_SCHEMA)), 'no repos row → allow'));
  });

  describe('repo_remotes (v35)', () => {
    it('registered repo with no repo_remotes rows: deny', () => {
      const zero = fixtureDb('trajectory-zero-rows.db', `${REPOS_SCHEMA} INSERT INTO repos (name, path) VALUES ('repo', '/tmp/repo');`);
      has(out(hook('gh auth login', zero)), DENY, 'no remote rows → deny');
    });
    it('pre-v35 DB without the repo_remotes table: fail-open (allow)', () => {
      const pre = fixtureDb(
        'trajectory-pre-v35.db',
        "CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, remotes TEXT); INSERT INTO repos (name, path, remotes) VALUES ('repo', '/tmp/repo', '[]');",
      );
      silent(hook('gh auth login', pre), 'unreadable remotes → allow');
    });
    it('blank origin plus an upstream with a url: allow', () => {
      const up = fixtureDb(
        'trajectory-upstream.db',
        `${REPOS_SCHEMA} INSERT INTO repos (name, path) VALUES ('repo', '/tmp/repo');
         INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES
           ('repo', 'origin', 'github', '', 1),
           ('repo', 'upstream', 'gitlab', 'https://gitlab.com/org/repo.git', 0);`,
      );
      silent(hook('gh auth login', up), 'a remote row with a url → allow');
    });
  });

  describe('subshell-wrapped forms: deny', () => {
    const gh = once(() => out(hook('(gh auth login)')));
    const glab = once(() => out(hook('(glab auth login)')));
    it('subshell (gh auth login): deny', () => has(gh(), DENY, 'subshell gh auth login must deny'));
    it('subshell (gh auth login): deny reason mentions BLOCKED', () => has(gh(), 'BLOCKED', 'BLOCKED in reason for subshell gh'));
    it('subshell (glab auth login): deny', () => has(glab(), DENY, 'subshell glab auth login must deny'));
    it('subshell (glab auth login): deny reason mentions BLOCKED', () => has(glab(), 'BLOCKED', 'BLOCKED in reason for subshell glab'));
  });

  describe('(H6) remotes resolve from the cd/-C target, not $PWD', () => {
    it('(H6) cd into the no-remote sibling → deny (resolved from cd target, not $PWD)', () =>
      has(out(hook(`cd ${normRepo} && gh auth login`, mrDb, withRepo)), DENY, 'no-remote sibling must deny even when $PWD has a remote'));
    it('(H6) cd into the with-remote sibling → allow (resolved from cd target, not $PWD)', () =>
      silent(hook(`cd ${withRepo} && gh auth login`, mrDb, normRepo), 'with-remote sibling must allow even when $PWD has no remote'));
    it('GH 1196: heredoc mentioning gh auth login → allow (data, not a login)', () =>
      silent(hook("cat > notes.md <<'EOF'\ngh auth login\nEOF", mrDb, normRepo), 'heredoc content is not a login'));
    it("GH 1196: payload cwd names the with-remote sibling → allow (no false no-remote claim)", () => {
      const r = runGate(GATE, {
        cwd: normRepo,
        input: JSON.stringify({ tool_name: 'Bash', cwd: withRepo, tool_input: { command: 'gh auth login' } }),
        env: { ...gateEnv(sb, normRepo), TRAJECTORY_DB_PATH: mrDb },
      });
      silent(r, "the payload cwd's repo has a remote");
    });
  });
});
