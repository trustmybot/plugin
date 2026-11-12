/**
 * git-push-guard (GH 1692), the l3 bash suite's cases in node:test: a push whose range holds a closed task's commit_sha without a passing
 * code-reviewer verdict is denied. Force pushes are judged the same way
 * (GH 3102); no DB, no new commits or untracked commits pass. SWE and code-reviewer pushes are
 * denied by identity, worktree pushes by path (a leading cd or -C beating a
 * stale cwd), and only a real push statement counts. An unreadable DB fails
 * closed, the WAL reads hold, a bare push beside linked worktrees is
 * ambiguous (GH 1196), and a rebased task commit needs a passing
 * verification run on its own SHA (GH 1518). Each case runs
 * `node dist/hooks.js git-push-guard` from a temp repo with a bare upstream.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, before, beforeEach, after, describe, it } from 'node:test';
import { makeSandbox, type Sandbox } from './hook-sandbox.js';
import { anchorTask, commit, DENY, GATE, gateEnv, git, has, hasNot, initRepo, insertRepo, insertTask, INTEGRATE, newDb, NO_DB, passTask, push, recordRun, signTask, sql } from './git-push-guard-l3.js';
import { REAL_SQLITE3, walGateCases } from './wal-gate-cases.js';

interface Repo {
  sb: Sandbox;
  repo: string;
  sha1: string;
  sha2: string;
}

/** main pushed with tracking at init, then two commits (SHA1, SHA2) ahead of origin/main. */
function setupRepo(): Repo {
  const sb = makeSandbox('push-guard');
  const repo = join(sb.dir, 'repo');
  initRepo(sb.env, repo, 'main');
  commit(sb.env, repo, 'init', { 'README.md': 'init\n' });
  git(sb.env, repo, 'push', '-qu', 'origin', 'main');
  const sha1 = commit(sb.env, repo, 'feat: A', { 'a.txt': 'feat A\n' });
  const sha2 = commit(sb.env, repo, 'feat: B', { 'b.txt': 'feat B\n' });
  return { sb, repo, sha1, sha2 };
}

function bothSigned(r: Repo): string {
  const db = newDb(r.repo);
  insertTask(db, 1, r.sha1);
  signTask(db, 1);
  insertTask(db, 2, r.sha2);
  signTask(db, 2);
  return db;
}

describe('git-push-guard l3: the review gate', () => {
  let r: Repo;
  beforeEach(() => {
    r = setupRepo();
  });
  afterEach(() => r.sb.remove());
  const run = (cmd: string, db?: string, agent?: string) => push(r.sb, cmd, { cwd: r.repo, db, agent });

  it('non-push command passes through silently', () => hasNot(run('git status'), DENY, 'git status should not be gated'));

  it('GH 3102: git push --force with an unsigned commit is judged like any push: BLOCKED', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    has(run('git push --force origin main', db), 'task_id=1', 'a forced push of an unsigned commit must block');
  });

  it('GH 3102: git push -f with an unsigned commit is judged like any push: BLOCKED', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    has(run('git push -f origin main', db), 'task_id=1', 'a forced push (-f) of an unsigned commit must block');
  });

  it('GH 3102: git push --force with all-signed commits: allowed', () =>
    hasNot(run('git push --force origin main', bothSigned(r)), DENY, 'a forced push of reviewed commits passes this gate'));

  it('no DB: TMB not tracking, push allowed', () => hasNot(run('git push origin main', NO_DB), DENY, 'missing DB should not block'));

  it('no upstream new commits: nothing to gate, allowed', () => {
    const db = newDb(r.repo);
    git(r.sb.env, r.repo, 'reset', '-q', '--hard', 'origin/main');
    hasNot(run('git push origin main', db), DENY, 'no new commits should not block');
  });

  it('push with untracked commits (no matching task row): allowed', () =>
    hasNot(run('git push origin main', newDb(r.repo)), DENY, 'untracked commits should not block'));

  it('push with all-signed tracked commits: allowed', () => hasNot(run('git push origin main', bothSigned(r)), DENY, 'all-signed should not block'));

  it('push with one unsigned tracked commit: BLOCKED with helpful reason', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    signTask(db, 1);
    insertTask(db, 2, r.sha2);
    const out = run('git push origin main', db);
    has(out, DENY, 'unsigned commit must block');
    has(out, 'review before push', 'block message must mention bro review path');
    has(out, 'task_id=2', 'block message must list the unsigned task');
  });

  it('push with multiple unsigned tracked commits: BLOCKED, all listed', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    insertTask(db, 2, r.sha2);
    const out = run('git push origin main', db);
    has(out, DENY, 'unsigned commits must block');
    has(out, 'task_id=1', 'should list task 1');
    has(out, 'task_id=2', 'should list task 2');
  });

  it('push with mixed-signed (one signed, one not) commits: BLOCKED', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    signTask(db, 1);
    insertTask(db, 2, r.sha2);
    const out = run('git push origin main', db);
    has(out, DENY, 'mixed should block on unsigned');
    has(out, 'task_id=2', 'should list ONLY the unsigned task 2');
    hasNot(out, 'task_id=1 ', 'signed task 1 should not appear in block list');
  });

  it('GH 2413: a pass for an earlier commit_sha does not sign the pushed one', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    signTask(db, 1);
    insertTask(db, 2, r.sha1);
    anchorTask(db, 2, '2026-10-19T00:00:00.000Z');
    passTask(db, 2, '2026-10-19T00:01:00.000Z');
    sql(db, 'UPDATE tasks SET commit_sha = ? WHERE id = 2', r.sha2);
    anchorTask(db, 2, '2026-10-19T00:02:00.000Z');
    const out = run('git push origin main', db);
    has(out, DENY, 'a pass recorded before the anchor of the pushed commit must not admit it');
    has(out, 'unsigned commit(s)', 'the deny is the unsigned-commit deny');
    has(out, 'task_id=2', 'the deny lists the task whose commit moved');
    passTask(db, 2, '2026-10-19T00:03:00.000Z');
    hasNot(run('git push origin main', db), DENY, "a pass recorded after the pushed commit's anchor admits it");
  });

  it('GH 2413: a pass with no bro_verification_pass anchor for the commit is unsigned (fail-closed)', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    signTask(db, 1);
    insertTask(db, 2, r.sha2);
    passTask(db, 2);
    const out = run('git push origin main', db);
    has(out, DENY, 'a pass with no anchor must not admit the push');
    has(out, 'unsigned commit(s)', 'the deny is the unsigned-commit deny');
    has(out, 'task_id=2', 'the deny lists the unanchored task');
    hasNot(out, 'task_id=1 ', 'the anchored and passed task is signed');
  });

  it('GH 2412: the newest verdict gates: a fail after a pass BLOCKS, a newer pass allows', () => {
    const db = bothSigned(r);
    const verdict = (attempt: number, v: string) =>
      sql(
        db,
        `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
           VALUES (2, ?, 'code-reviewer', ?, 1, 'review', ?)`,
        attempt,
        v,
        new Date().toISOString(),
      );
    verdict(2, 'fail');
    const out = run('git push origin main', db);
    has(out, DENY, 'a newest fail must block despite the older pass');
    has(out, 'task_id=2', 'the task whose newest verdict is a fail is listed');
    hasNot(out, 'task_id=1 ', 'task 1, newest verdict pass, is not listed');
    verdict(3, 'pass');
    hasNot(run('git push origin main', db), DENY, 'a newer pass allows the push');
  });

  it('GH 2412 + GH 2413: a newer fail on top of a same-SHA pass BLOCKS the push', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    signTask(db, 1);
    insertTask(db, 2, r.sha2);
    anchorTask(db, 2, '2026-10-19T00:00:00.000Z');
    passTask(db, 2, '2026-10-19T00:01:00.000Z');
    hasNot(run('git push origin main', db), DENY, 'an anchored pass for the pushed SHA admits the push');
    sql(
      db,
      `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
         VALUES (2, 2, 'code-reviewer', 'fail', 1, 'regressed', '2026-10-19T00:02:00.000Z')`,
    );
    const out = run('git push origin main', db);
    has(out, DENY, 'a newer fail must block despite the anchored same-SHA pass');
    has(out, 'unsigned commit(s)', 'the deny is the unsigned-commit deny');
    has(out, 'task_id=2', 'the task whose newest verdict is a fail is listed');
    hasNot(out, 'task_id=1 ', 'task 1 stays signed');
  });

  it('SWE caller (tmb:swe): git push BLOCKED regardless of unsigned status', () => {
    const out = run('git push origin main', bothSigned(r), 'tmb:swe');
    has(out, DENY, 'SWE push must be blocked even with all-signed commits');
    has(out, 'SWE must never push', 'block message must reference swe.md rule');
  });

  it('SWE caller (swe): git push BLOCKED (bare agent_type variant)', () => {
    newDb(r.repo);
    has(run('git push origin main', NO_DB, 'swe'), DENY, 'bare swe agent_type must also be blocked');
  });

  it('GH 3102: SWE caller: git push --force is BLOCKED like any SWE push', () =>
    has(run('git push --force origin main', newDb(r.repo), 'tmb:swe'), 'SWE must never push', 'a forced push is still a push'));

  it('non-SWE caller: git push NOT blocked by SWE check (bro/regular-claude)', () =>
    hasNot(run('git push origin main', bothSigned(r)), DENY, 'non-SWE caller with all-signed should not be blocked'));

  it('code-reviewer caller (tmb:code-reviewer): git push BLOCKED with bro-owns-push message', () => {
    const out = run('git push origin main', bothSigned(r), 'tmb:code-reviewer');
    has(out, DENY, 'code-reviewer push must be blocked even with all-signed commits');
    has(out, 'verdict row', 'block message must reference the verdict row');
    has(out, 'bro', 'block message must state push decision belongs to bro');
  });

  it('code-reviewer caller (code-reviewer): git push BLOCKED (bare agent_type variant)', () => {
    newDb(r.repo);
    has(run('git push origin main', NO_DB, 'code-reviewer'), DENY, 'bare code-reviewer agent_type must also be blocked');
  });

  it('GH 3102: code-reviewer caller: git push --force is BLOCKED like any code-reviewer push', () =>
    has(run('git push --force origin main', newDb(r.repo), 'tmb:code-reviewer'), 'must not push', 'a forced push is still a push'));

  it('bro caller (no agent_type): git push with all-signed NOT blocked by role check', () =>
    hasNot(run('git push origin main', bothSigned(r)), DENY, 'bro/Human with all-signed commits must not be blocked by role check'));

  it('unreadable trajectory DB: push gate fails closed (tmb_gate_read __ERR__)', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    chmodSync(db, 0o000);
    let out: string;
    try {
      out = run('git push origin main', db);
    } finally {
      chmodSync(db, 0o644);
    }
    has(out, DENY, 'DB read error must deny, not allow');
    has(out, 'trajectory DB unavailable', 'deny names the unavailable DB');
  });
});

describe('git-push-guard l3: worktree-path push detection (audit item 14)', () => {
  let r: Repo;
  let wt: string;
  beforeEach(() => {
    r = setupRepo();
    wt = join(r.repo, '.claude/worktrees/feat-x');
  });
  afterEach(() => r.sb.remove());
  const run = (cmd: string, db: string, cwd = r.repo) => push(r.sb, cmd, { cwd, db });
  const oneSigned = () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    signTask(db, 1);
    return db;
  };

  it("push via 'cd .claude/worktrees/...' prefix: BLOCKED (no agent_type field)", () => {
    const out = run(`cd ${wt} && git push origin feat/x`, bothSigned(r));
    has(out, DENY, 'push from worktree cd prefix must block even without agent_type');
    has(out, '.claude/worktrees/', 'block message must reference worktree path');
  });

  it("push via 'git -C .claude/worktrees/...' flag: BLOCKED (no agent_type field)", () =>
    has(run(`git -C ${wt} push origin feat/x`, oneSigned()), DENY, 'push via git -C worktree path must block'));

  it('normal push from main checkout (no worktree in cmd): NOT blocked by worktree check', () =>
    hasNot(run('git push origin main', bothSigned(r)), DENY, 'normal push from main checkout must not be blocked by worktree check'));

  it("PWD in worktree but command does 'cd <main> && git push': NOT blocked (cd overrides stale PWD)", () => {
    const db = bothSigned(r);
    mkdirSync(wt, { recursive: true });
    hasNot(run(`cd ${r.repo} && git push origin main`, db, wt), DENY, 'cd to non-worktree path should override stale worktree PWD');
  });

  it("PWD in worktree, plain 'git push' (no cd, no -C): BLOCKED via PWD fallback", () => {
    const db = oneSigned();
    mkdirSync(wt, { recursive: true });
    has(run('git push origin main', db, wt), DENY, 'plain push with PWD-in-worktree must still block (legitimate worktree push)');
  });

  it("PWD in main, command 'cd <worktree> && git push': BLOCKED (cd target is worktree)", () => {
    const db = oneSigned();
    mkdirSync(wt, { recursive: true });
    has(run(`cd ${wt} && git push origin feat/x`, db, r.repo), DENY, 'cd into worktree should block even when PWD is main');
  });
});

describe('git-push-guard l3: push detection', () => {
  let r: Repo;
  beforeEach(() => {
    r = setupRepo();
  });
  afterEach(() => r.sb.remove());
  const run = (cmd: string, agent?: string) => push(r.sb, cmd, { cwd: r.repo, db: NO_DB, agent });

  for (const [name, cmd] of [
    ["grep for 'git push' in a file", 'grep "git push" tests/l1-lint/something.sh'],
    ["echo mentioning 'git push'", 'echo "Don\'t forget to git push"'],
    ["cat pipe grep for 'git push'", 'cat docs/git-conventions.md | grep "git push"'],
    ["git log --grep='git push'", 'git log --grep="git push"'],
    ["git commit -m mentioning 'git push'", 'git commit -m "fix: make git push idempotent"'],
  ])
    it(`false-positive: ${name} — NOT blocked`, () => hasNot(run(cmd), DENY, `${name} must not be detected as a push`));

  for (const [name, cmd] of [
    ["'git push origin main'", 'git push origin main'],
    ["'git -C /some/path push origin feature'", 'git -C /some/path push origin feature'],
    ["'cd /repo && git push'", 'cd /repo && git push'],
    ["'git status; git push'", 'git status; git push'],
    ["'make build || git push'", 'make build || git push'],
    ["#1016: 'git  push' (double space)", 'git  push origin main'],
    ["#1016: leading-whitespace '   git push'", '   git push origin main'],
    ["#1016: 'bash -c \"git push origin main\"' wrapper", 'bash -c "git push origin main"'],
    ["#1016: 'eval \"git push origin main\"' wrapper", 'eval "git push origin main"'],
  ])
    it(`positive: ${name} — IS_PUSH triggers (SWE blocked)`, () => has(run(cmd, 'tmb:swe'), DENY, `${cmd} must be detected as a push and blocked for SWE`));

  it('#1016 + GH 3102: double-space force push reaches the unsigned gate', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    has(push(r.sb, 'git  push  --force origin main', { cwd: r.repo, db }), 'task_id=1', 'double-space force push is judged like any push');
  });

  it("#1016: false-positive — 'bash -c \"echo git push\"' is NOT a push", () =>
    hasNot(run('bash -c "echo git push done"', 'tmb:swe'), DENY, 'echo of git push inside a wrapper must not fire'));
});

describe('git-push-guard l3: WAL reads on a first push bounded by the repos row target_branch', () => {
  let r: Repo;
  let db: string;
  before(() => {
    r = setupRepo();
    db = newDb(r.repo);
    git(r.sb.env, r.repo, 'checkout', '-q', '-b', 'dev');
    git(r.sb.env, r.repo, 'push', '-q', 'origin', 'dev');
    git(r.sb.env, r.repo, 'checkout', '-q', '-b', 'feat/wal');
    const sha3 = commit(r.sb.env, r.repo, 'feat: C', { 'c.txt': 'feat C\n' });
    insertTask(db, 1, r.sha2);
    insertTask(db, 3, sha3);
    signTask(db, 3);
    insertRepo(db, 'wal', r.repo, 'dev');
  });
  after(() => r.sb.remove());

  it('fixture precondition: the push of the signed feature commit is allowed', () =>
    hasNot(push(r.sb, 'git push origin feat/wal', { cwd: r.repo, db }), DENY, 'an empty target read would fall back to main and gate the unsigned dev commit'));

  describe('through the sqlite3 CLI', { skip: REAL_SQLITE3 === '' && 'needs the sqlite3 CLI' }, () => {
    walGateCases({
      label: GATE,
      gate: GATE,
      get db() {
        return db;
      },
      get proj() {
        return r.repo;
      },
      input: JSON.stringify({ tool_input: { command: 'git push origin feat/wal' } }),
      expect: '',
      forbid: DENY,
      get cwd() {
        return r.repo;
      },
      env: () => gateEnv(r.sb, r.repo),
      work: () => join(r.sb.dir, 'wal-work'),
    });
  });
});

describe('git-push-guard l3: GH 1196 role from identity, dir from the command', () => {
  let r: Repo;
  let wt: string;
  beforeEach(() => {
    r = setupRepo();
    git(r.sb.env, r.repo, 'branch', 'feat/wt');
    wt = join(r.repo, '.claude/worktrees/wt');
    git(r.sb.env, r.repo, 'worktree', 'add', '-q', wt, 'feat/wt');
  });
  afterEach(() => r.sb.remove());
  const run = (agent: string | undefined, payloadCwd: string, cmd: string, db?: string) => push(r.sb, cmd, { cwd: r.repo, db, agent, payloadCwd });

  it("bro 'git -C <main> push' with payload cwd inside a worktree → allowed", () =>
    hasNot(run(undefined, wt, `git -C ${r.repo} push origin main`, bothSigned(r)), DENY, 'bro pushing the main checkout by -C is not an SWE push nor a worktree push'));

  it("bro 'cd <main> && git push' with payload cwd inside a worktree → allowed", () =>
    hasNot(run(undefined, wt, `cd ${r.repo} && git push origin main`, bothSigned(r)), DENY, 'the leading cd decides the dir'));

  it("bro bare 'git push' while worktrees exist → ambiguous_git_target, not an SWE rule", () => {
    const out = run(undefined, r.repo, 'git push origin main', newDb(r.repo));
    has(out, 'ambiguous_git_target', 'the deny names the real reason');
    has(out, 'Allowed form: git -C <path> push origin main', 'the deny carries the remedy');
    hasNot(out, 'SWE must never push', 'bro is never told an SWE rule');
  });

  it("GH 2404: bro 'P=<main>; git -C $P push origin <sha>:refs/heads/x 2>&1' reaches the review gate, not ambiguous_git_target", () => {
    const cmd = `P=${r.repo}; git -C $P push origin ${r.sha2}:refs/heads/x`;
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    signTask(db, 1);
    insertTask(db, 2, r.sha2);
    let out = run(undefined, r.repo, `${cmd} 2>&1`, db);
    hasNot(out, 'ambiguous_git_target', 'an fd duplication cannot reassign the variable');
    has(out, 'task_id=2', 'the unsigned task commit is gated as usual');
    has(run(undefined, r.repo, `${cmd} 2>$((P=0))`, db), 'ambiguous_git_target', 'a redirect that can reassign stays unresolved');
    signTask(db, 2);
    out = run(undefined, r.repo, `${cmd} 2>&1`, db);
    hasNot(out, DENY, 'both commits signed: the push passes');
  });

  it('SWE push is denied by identity, whatever the dir', () =>
    has(run('swe', r.repo, `git -C ${r.repo} push origin main`), 'SWE must never push', 'identity decides the role'));

  it('a heredoc that writes markdown mentioning git push is not a push', () => {
    const db = newDb(r.repo);
    insertTask(db, 1, r.sha1);
    const heredoc = `cat > ${wt}/notes.md <<'EOF'\nthen git push origin main\nEOF`;
    hasNot(run('swe', r.repo, heredoc, db), DENY, 'heredoc content is data');
  });
});

describe('git-push-guard l3: GH 1518 rebased task commits need a verification run', () => {
  let r: Repo;
  let db: string;
  let rsha: string;
  let rebased: string;
  beforeEach(() => {
    r = setupRepo();
    db = newDb(r.repo);
    const { env } = r.sb;
    git(env, r.repo, 'checkout', '-q', '-b', 'feat/r', 'origin/main');
    rsha = commit(env, r.repo, 'feat: R', { 'r.txt': 'feat R\n' });
    git(env, r.repo, 'checkout', '-q', '-b', 'feat/r-rebased', 'main');
    git(env, r.repo, 'cherry-pick', rsha);
    rebased = git(env, r.repo, 'rev-parse', 'HEAD');
    git(env, r.repo, 'checkout', '-q', '-b', 'feat/other', 'main');
    commit(env, r.repo, 'feat: other', { 'o.txt': 'other\n' });
    insertTask(db, 5, rsha);
    signTask(db, 5);
  });
  afterEach(() => r.sb.remove());
  const pushBranch = (branch: string) => {
    git(r.sb.env, r.repo, 'checkout', '-q', branch);
    return push(r.sb, `git push origin ${branch}`, { cwd: r.repo, db });
  };

  it('the reviewed task commit itself → allowed', () => hasNot(pushBranch('feat/r'), DENY, 'the reviewed SHA is covered by its review'));

  it('an integrated rebase (passing run on its SHA) → allowed', () => {
    recordRun(db, 5, rebased, 0);
    hasNot(pushBranch('feat/r-rebased'), DENY, 'a rebased SHA with a passing verification run ships');
  });

  const recordIntegrated = (carry: boolean, fromNode = 'hook:integrate') => {
    sql(
      db,
      `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         SELECT 1, 'feat/r', ?4, 'task_integrated', 'integrated',
           json_object('task_id', 5, 'reviewed_sha', ?1, 'commit_sha', ?2, 'base', 'main', 'run_id', 1), ?3
         FROM audit a WHERE a.event_type = 'bro_verification_pass' AND json_extract(a.content_json, '$.task_id') = 5`,
      rsha,
      rebased,
      new Date(Date.now() + 1000).toISOString(),
      fromNode,
    );
    if (carry) {
      sql(
        db,
        `UPDATE audit SET content_json = json_set(content_json, '$.review_anchor_at',
           (SELECT created_at FROM audit WHERE event_type = 'bro_verification_pass' AND json_extract(content_json, '$.task_id') = 5))
         WHERE event_type = 'task_integrated'`,
      );
    }
    sql(db, 'UPDATE tasks SET commit_sha = ? WHERE id = 5', rebased);
    recordRun(db, 5, rebased, 0);
  };

  it('GH 2082: an integrated head with a carried pass and a passing run → allowed', () => {
    recordIntegrated(true);
    hasNot(pushBranch('feat/r-rebased'), DENY, "the reviewed pass carries to the integrated head through review_anchor_at");
  });

  it('GH 2546: a legacy hook:integrate row (no review_anchor_at) carries the reviewed SHA anchor → allowed', () => {
    recordIntegrated(false);
    hasNot(pushBranch('feat/r-rebased'), DENY, "the legacy row takes its reviewed_sha's anchor");
  });

  it('GH 2082: an integrated head without a carried pass → BLOCKED as unsigned', () => {
    recordIntegrated(false, 'hook:other');
    const out = pushBranch('feat/r-rebased');
    has(out, DENY, 'a task_integrated row from another author anchors after the reviewed pass');
    has(out, 'unsigned commit(s)', 'the deny is the unsigned-commit deny');
    has(out, 'task_id=5', 'the deny names the integrated task');
  });

  it('a rebased SHA with the reviewed patch-id and no run → BLOCKED', () => {
    const out = pushBranch('feat/r-rebased');
    has(out, DENY, 'an unverified rebase must block');
    has(out, rebased, 'the deny names the rebased SHA');
    has(out, 'task_id=5', 'the deny names the reviewed task');
    has(out, INTEGRATE, 'the deny points at cli.js integrate');
  });

  it('a rebased SHA whose only run failed → BLOCKED', () => {
    recordRun(db, 5, rebased, 1);
    has(pushBranch('feat/r-rebased'), DENY, 'a failing run does not cover the rebase');
  });

  it('an unrelated commit beside a reviewed task → allowed', () =>
    hasNot(pushBranch('feat/other'), DENY, "a commit matching no reviewed patch-id keeps today's behaviour"));

  it("a rebase of an unreviewed task's commit → BLOCKED even with a passing run", () => {
    sql(db, 'DELETE FROM validation_attempts WHERE task_id = 5;');
    recordRun(db, 5, rebased, 0);
    const out = pushBranch('feat/r-rebased');
    has(out, DENY, "an unreviewed task's rebased commit must block");
    has(out, rebased, 'the deny names the rebased SHA');
    has(out, 'task_id=5', 'the deny names the task');
    has(out, 'no passing review', 'the deny says the task is unreviewed');
  });

  it("GH 2413: a rebase of a task whose pass predates its current commit's anchor → BLOCKED as unreviewed", () => {
    sql(db, 'DELETE FROM validation_attempts WHERE task_id = 5;');
    sql(db, "DELETE FROM audit WHERE event_type = 'bro_verification_pass';");
    passTask(db, 5, '2026-10-19T00:00:00.000Z');
    anchorTask(db, 5, '2026-10-19T00:01:00.000Z');
    recordRun(db, 5, rebased, 0);
    const out = pushBranch('feat/r-rebased');
    has(out, DENY, 'a pass from before the current commit was verified does not review it');
    has(out, rebased, 'the deny names the rebased SHA');
    has(out, 'task_id=5', 'the deny names the task');
    has(out, 'the task has no passing review', 'the deny says the task is unreviewed');
  });

  it('a rebase matching a reviewed and an unreviewed task is judged by the reviewed one', () => {
    const { env } = r.sb;
    git(env, r.repo, 'checkout', '-q', '-b', 'feat/r-again', 'origin/main');
    git(env, r.repo, 'cherry-pick', rsha);
    git(env, r.repo, 'commit', '-q', '--amend', '-m', 'feat: R again');
    insertTask(db, 4, git(env, r.repo, 'rev-parse', 'HEAD'));
    recordRun(db, 5, rebased, 0);
    hasNot(pushBranch('feat/r-rebased'), DENY, "the reviewed task's integrated rebase ships");
  });
});
