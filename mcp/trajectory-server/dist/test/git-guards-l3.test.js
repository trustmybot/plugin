/**
 * git-guards end to end (GH 1692), the l3 bash suite's cases in node:test: a
 * force push to a protected branch, a direct commit, merge, rebase or
 * cherry-pick on one, a branch create off a non-target base and a PR/MR whose
 * base is not the configured pr_target are denied, with the policy read from
 * the repo's `repos` row (safe defaults when its columns are unset) and only
 * for registered repos. `cd <worktree> &&`, `git -C <dir>` and a dir set in a
 * variable by the same command decide the branch; a bare command beside linked
 * worktrees is ambiguous (GH 1196); heredoc and quoted text is data (GH 1281);
 * a fast-forward to the branch's own upstream is a sync (GH 1596). Each case
 * runs `node dist/hooks.js git-guards` from a temp repo with CLAUDE_PROJECT_DIR
 * pinned to the sandbox and PWD set.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeSandbox, runGate } from './hook-sandbox.js';
import { commit, DENY, gateEnv, git, has, hasNot, newDb, NO_DB, sql } from './git-push-guard-l3.js';
/** The gate's stdout and stderr for a Bash <command> (a `2>&1`). */
function guard(sb, command, opts) {
    const payload = { tool_name: 'Bash' };
    if (opts.agent !== undefined)
        payload.agent_type = opts.agent;
    if (opts.payloadCwd !== undefined)
        payload.cwd = opts.payloadCwd;
    payload.tool_input = { command };
    const r = runGate(opts.gate ?? 'git-guards', {
        cwd: opts.cwd,
        input: JSON.stringify(payload),
        env: { ...gateEnv(sb, opts.cwd), TRAJECTORY_DB_PATH: opts.db ?? NO_DB, ...opts.env },
    });
    return r.stdout + r.stderr;
}
/** A repo at <dir> on <branch> with one commit. */
function initAt(sb, dir, branch) {
    mkdirSync(dir, { recursive: true });
    git(sb.env, dir, 'init', '-q', '-b', branch);
    commit(sb.env, dir, 'init', { 'README.md': 'init\n' });
    return dir;
}
/** A repos row for <path>; unset columns stay NULL. */
function register(db, name, path, cols = {}) {
    sql(db, 'INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES (?, ?, ?, ?, ?)', name, path, cols.target ?? null, cols.model ?? null, cols.protected ?? null);
}
function insertTask(db, branch, parent = null) {
    sql(db, `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, description, status, spec_body, created_at, updated_at)
       VALUES (1, 1, ?, ?, 'test task', 'd', 'pending', '', datetime('now'), datetime('now'))`, branch, parent);
}
/** main with a worktree .claude/worktrees/task-1 on feat/cli-todo; registered with no policy columns. */
function worktreeRepo(sb) {
    const repo = initAt(sb, join(sb.dir, 'repo'), 'main');
    git(sb.env, repo, 'worktree', 'add', '-b', 'feat/cli-todo', '.claude/worktrees/task-1', '-q');
    const db = newDb(repo);
    register(db, 'fixture', repo);
    return { repo, db };
}
/** main with a worktree .claude/worktrees/cli-todo on feat/cli-todo and a task on that branch. */
function slugRepo(sb) {
    const repo = initAt(sb, join(sb.dir, 'repo'), 'main');
    git(sb.env, repo, 'branch', 'feat/cli-todo', 'HEAD');
    git(sb.env, repo, 'worktree', 'add', '-q', '.claude/worktrees/cli-todo', 'feat/cli-todo');
    const db = newDb(repo);
    register(db, 'fixture', repo);
    insertTask(db, 'feat/cli-todo');
    return { repo, db };
}
/** dev, target dev, gitflow, [main, dev] protected. */
function glabRepo(sb) {
    const repo = initAt(sb, join(sb.dir, 'repo'), 'dev');
    const db = newDb(repo);
    register(db, 'fixture', repo, { target: 'dev', model: 'gitflow', protected: '["main","dev"]' });
    return { repo, db };
}
/** A registered main-only repo on <branch> with no policy columns. */
function unconfiguredRepo(sb, branch) {
    const repo = initAt(sb, join(sb.dir, 'repo'), branch);
    const db = newDb(repo);
    register(db, 'fixture', repo);
    return { repo, db };
}
const deny = (out, msg) => has(out, DENY, msg);
const allow = (out, msg) => hasNot(out, DENY, msg);
let sb;
beforeEach(() => {
    sb = makeSandbox('git-guards');
});
afterEach(() => sb.remove());
describe('git-guards l3: no policy, read-only and early exit', () => {
    const plain = () => initAt(sb, join(sb.dir, 'plain'), 'main');
    it('no config (fresh install) is non-blocking for commits', () => {
        const repo = initAt(sb, join(sb.dir, 'fresh'), 'main');
        git(sb.env, repo, 'switch', '-q', '-c', 'feat/fresh');
        allow(guard(sb, 'git commit -m test', { cwd: repo }), 'should NOT block on fresh install');
    });
    it('non-git command passes through', () => allow(guard(sb, 'ls -la', { cwd: plain() }), 'ls should not fire hook'));
    it('git status is not gated (read-only)', () => allow(guard(sb, 'git status', { cwd: plain() }), 'git status should pass'));
    it('git log is not gated (read-only)', () => allow(guard(sb, 'git log --oneline -5', { cwd: plain() }), 'git log should pass'));
    it('#549: unregistered repo: guard no-ops (commit on protected branch not blocked)', () => {
        const repo = initAt(sb, join(sb.dir, 'unreg'), 'main');
        const db = newDb(repo);
        allow(guard(sb, 'git commit -m broken', { cwd: repo, db }), 'unregistered repo must not block (no-op)');
    });
    it("early-exit: 'legit foo' does NOT match the git/gh word boundary", () => {
        const r = runGate('git-guards', {
            cwd: plain(),
            input: JSON.stringify({ tool_input: { command: 'legit foo' } }),
            env: { ...gateEnv(sb, join(sb.dir, 'plain')), TRAJECTORY_DB_PATH: NO_DB },
        });
        assert.equal(r.stdout + r.stderr, '', 'legit must early-exit with no output');
    });
    it('glab: glab mr list (read-only) is NOT blocked (early-exit passes glab)', () => allow(guard(sb, 'glab mr list', { cwd: plain() }), 'glab mr list must not be blocked'));
});
describe('git-guards l3: worktree-aware commit (v0.3.2)', () => {
    let f;
    beforeEach(() => {
        f = worktreeRepo(sb);
    });
    const run = (cmd) => guard(sb, cmd, { cwd: f.repo, db: f.db });
    it("bare 'git commit' from project root on main IS blocked", () => {
        const out = run("git commit -m 'broken'");
        deny(out, 'commit with no dir while worktrees exist must block');
        has(out, 'ambiguous_git_target', 'the deny names the real reason, not a protected-branch rule');
    });
    it("bare 'git commit' in a repo without worktrees on main IS blocked", () => {
        git(sb.env, f.repo, 'worktree', 'remove', '--force', '.claude/worktrees/task-1');
        has(run("git commit -m 'broken'"), 'main is a shared workflow base', 'with one checkout the cwd names the branch');
    });
    it("'cd .claude/worktrees/task-1 && git commit' is ALLOWED (worktree on feature branch)", () => allow(run("cd .claude/worktrees/task-1 && git commit -m 'feat: add x'"), 'commit from worktree on feat/cli-todo must pass'));
    it("'cd /abs/path/worktree && git commit' (absolute path) is ALLOWED", () => allow(run(`cd ${f.repo}/.claude/worktrees/task-1 && git commit -m 'feat: add x'`), 'absolute-path cd should also work'));
    it("'cd <main-worktree> && git commit' STILL blocks (cd to root + commit on main)", () => deny(run(`cd ${f.repo} && git commit -m 'broken'`), 'cd to root then commit on main should still block'));
    it("'git -C <worktree> commit' is ALLOWED (git -C path syntax)", () => allow(run("git -C .claude/worktrees/task-1 commit -m 'feat: add x'"), 'git -C <worktree> commit should pass'));
    it("'git checkout -b' from worktree on feature branch is blocked by rule 4, naming the worktree branch", () => {
        const out = run('cd .claude/worktrees/task-1 && git checkout -b feat/sub-task');
        deny(out, 'rule 4 must see feat/cli-todo (not main) and block since not on PR_TARGET');
        has(out, 'feat/cli-todo', 'block message must reference the worktree branch');
    });
    it("rule 4 doesn't false-fire when origin doesn't exist (rev-parse without --verify bug)", () => hasNot(run('git checkout -b feat/new-from-main'), 'is behind origin', 'no-remote repo must not falsely report behind-origin'));
});
describe('git-guards l3: worktree branch via DB lookup (v0.3.3)', () => {
    let f;
    beforeEach(() => {
        f = slugRepo(sb);
    });
    const run = (cmd) => guard(sb, cmd, { cwd: f.repo, db: f.db });
    it('worktree on feature branch: commit ALLOWED via DB lookup', () => allow(run(`cd ${f.repo}/.claude/worktrees/cli-todo && git commit -m 'feat: add x'`), 'detached worktree on feature branch must not block'));
    it('worktree with no DB match: commit allowed (fail-open)', () => {
        sql(f.db, 'DELETE FROM tasks WHERE id=1');
        allow(run(`cd ${f.repo}/.claude/worktrees/cli-todo && git commit -m 'feat: add x'`), 'no DB match must not block (fail-open)');
    });
});
describe('git-guards l3: quote-bearing slug', () => {
    it('injection: quote-bearing slug resolves a PROTECTED branch and BLOCKS the commit', () => {
        const repo = initAt(sb, join(sb.dir, 'repo'), 'main');
        git(sb.env, repo, 'branch', "feat/o'brien-cli", 'HEAD');
        git(sb.env, repo, 'worktree', 'add', '-q', '--detach', ".claude/worktrees/o'brien-cli");
        const db = newDb(repo);
        register(db, 'fixture', repo, { target: 'main', model: 'github-flow', protected: `["main", "feat/o'brien-cli"]` });
        insertTask(db, "feat/o'brien-cli");
        const out = guard(sb, `cd "${repo}/.claude/worktrees/o'brien-cli" && git commit -m 'feat: add x'`, { cwd: repo, db });
        deny(out, 'quote-bearing protected slug must BLOCK; empty means the lookup SQL errored out');
        has(out, "feat/o'brien-cli", 'block message must name the quoted branch resolved via DB lookup');
    });
});
describe('git-guards l3: force push and word-boundary matching (#347, #319, #1016)', () => {
    let f;
    beforeEach(() => {
        f = worktreeRepo(sb);
    });
    const run = (cmd) => guard(sb, cmd, { cwd: f.repo, db: f.db });
    it('#347: git push --follow-tags is NOT a force push (must pass)', () => allow(run('git push origin main --follow-tags'), '--follow-tags must not trigger force-push block'));
    it('#347: compound command with -f AFTER push clause is NOT a force push', () => allow(run('git push origin main && rm -f /tmp/x'), 'rm -f after && must not trigger force-push block'));
    it('#347: git push -f to protected branch IS blocked', () => deny(run('git push -f origin main'), 'git push -f to main must block'));
    it('#347: git push --force to protected branch IS blocked', () => deny(run('git push --force origin main'), 'git push --force to main must block'));
    it('#347: git push --force-with-lease to protected branch IS blocked', () => deny(run('git push --force-with-lease origin main'), 'git push --force-with-lease to main must block'));
    it('#319: git commit-tree plumbing is NOT blocked (word-boundary matching)', () => allow(run('git commit-tree abc123'), 'commit-tree plumbing must not block'));
    it("#319: 'git commit' inside --body argument text is NOT blocked", () => allow(run("gh issue create --body 'run git commit to apply'"), 'git commit in arg text must not block'));
    it('#319: git merge onto protected branch IS blocked', () => deny(run('git merge feat/cli'), 'git merge on main must block'));
    it('#319: git rebase onto protected branch IS blocked', () => deny(run('git rebase feat/cli'), 'git rebase on main must block'));
    it('#319: git cherry-pick onto protected branch IS blocked', () => deny(run('git cherry-pick abc123'), 'git cherry-pick on main must block'));
    it("early-exit: 'foo;git commit -m x' on protected branch IS blocked (; separator, no space)", () => deny(run('foo;git commit -m x'), 'semicolon-joined git commit on main must block'));
    it("early-exit: 'echo y&&git commit' on protected branch IS blocked (&& separator, no space)", () => deny(run('echo y&&git commit -m x'), '&&-joined git commit on main must block'));
    it('#1016: git  push --force origin main (double space) IS blocked', () => deny(run('git  push --force origin main'), 'double-space force push to main must block'));
    it('#1016: git  push  -f origin main (double space) IS blocked', () => deny(run('git  push  -f origin main'), 'double-space -f force push to main must block'));
});
describe('git-guards l3: separator x subcommand matrix', () => {
    const SEPARATORS = ['', ';', '&&', '||'];
    const SUBCOMMANDS = ['commit -m x', 'merge feat/other', 'rebase main', 'cherry-pick abc123', 'push -f origin main'];
    const LOOKALIKES = ['legit commit -m x', 'github.com/repo', 'ls .git/hooks', 'cat .git/config'];
    const ALL_SEP = ['', ';', '&&', '||', '|', '$('];
    it('every separator joined to every dangerous subcommand on a protected branch is denied', () => {
        const f = worktreeRepo(sb);
        const cmds = [
            ...SEPARATORS.flatMap((sep) => SUBCOMMANDS.map((sub) => (sep === '' ? `git ${sub}` : `echo prefix${sep}git ${sub}`))),
            ...SUBCOMMANDS.map((sub) => `echo prefix\ngit ${sub}`),
        ];
        for (const cmd of cmds)
            deny(guard(sb, cmd, { cwd: f.repo, db: f.db }), `must block: ${cmd}`);
    });
    it('non-git lookalikes joined by every separator are allowed', () => {
        const f = worktreeRepo(sb);
        const cmds = [
            ...ALL_SEP.flatMap((sep) => LOOKALIKES.map((l) => (sep === '' ? l : `echo prefix${sep}${l}`))),
            ...LOOKALIKES.map((l) => `echo prefix\n${l}`),
        ];
        for (const cmd of cmds)
            allow(guard(sb, cmd, { cwd: f.repo, db: f.db }), `must allow: ${cmd}`);
    });
});
describe('git-guards l3: glab mr create and Rule 1 base matching', () => {
    let f;
    beforeEach(() => {
        f = glabRepo(sb);
    });
    const run = (cmd) => guard(sb, cmd, { cwd: f.repo, db: f.db });
    it('glab: glab mr create --target-branch wrong: deny', () => {
        const out = run("glab mr create --target-branch wrong --source-branch feat/x --title 'x'");
        deny(out, 'wrong target must block');
        has(out, 'BLOCKED', 'deny reason must say BLOCKED');
    });
    it('glab: glab mr create --target-branch dev (== PR_TARGET): allow', () => allow(run("glab mr create --target-branch dev --source-branch feat/x --title 'x'"), 'correct target must allow'));
    it('glab: glab mr create -b dev (short flag, == PR_TARGET): allow', () => allow(run("glab mr create -b dev -s feat/x --title 'x'"), 'short -b correct target must allow'));
    it('glab: glab mr create -b main + --source-branch dev: allow (release exception)', () => allow(run("glab mr create -b main --source-branch dev --title 'release'"), 'dev->main with source=dev must allow'));
    it('glab: glab mr create -b main + --source-branch feat/x: deny (release exception non-dev source)', () => deny(run("glab mr create -b main --source-branch feat/x --title 'x'"), 'dev->main with non-dev source must block'));
    it('glab: glab mr create -b main + -s dev: allow (short -s source=dev release exception)', () => allow(run("glab mr create -b main -s dev --title 'release'"), 'short -s dev must allow release exception'));
    it('#1032: gh pr create --base dev-old (PR_TARGET=dev) must NOT be accepted: deny', () => deny(run('gh pr create --base dev-old --head feat/x --title x'), '--base dev-old must not substring-match dev'));
    it('#1032: gh pr create --base development (PR_TARGET=dev) must NOT be accepted: deny', () => deny(run('gh pr create --base development --head feat/x --title x'), '--base development must not substring-match dev'));
    it('#1032: gh pr create --base dev (exact): allow', () => allow(run('gh pr create --base dev --head feat/x --title x'), 'exact --base dev must be accepted'));
    it('#1032: dev->main exception must NOT accept --base maintenance: deny', () => deny(run('gh pr create --base maintenance --head dev --title x'), '--base maintenance must not match the dev->main exception'));
    it('#1032: dev->main exception with exact --base main --head dev: allow', () => allow(run('gh pr create --base main --head dev --title release'), 'exact dev->main release merge must be allowed'));
    it('#15/H2: dev->main gh pr create (no --head) reads head=dev from the cd target: ALLOWED', () => {
        const elsewhere = join(sb.dir, 'elsewhere');
        mkdirSync(elsewhere);
        allow(guard(sb, `cd ${f.repo} && gh pr create --base main --title release`, { cwd: elsewhere, db: f.db }), 'current branch (dev), read from the cd target, must allow the release PR');
    });
    it('#15/H2: dev->main gh pr create (no --head) from a FEATURE branch (read via cd target): BLOCKS', () => {
        git(sb.env, f.repo, 'checkout', '-q', '-b', 'feat/x');
        const elsewhere = join(sb.dir, 'elsewhere');
        mkdirSync(elsewhere);
        deny(guard(sb, `cd ${f.repo} && gh pr create --base main --title oops`, { cwd: elsewhere, db: f.db }), 'head=feat/x (read from cd target) must block the dev->main exception');
    });
});
describe('git-guards l3: Rule 1 substring false positives', () => {
    it("echo quoting 'gh pr create --base x' or 'glab mr create --target-branch x' is NOT blocked", () => {
        const f = worktreeRepo(sb);
        allow(guard(sb, 'echo "run gh pr create --base dev from your feature branch"', { cwd: f.repo, db: f.db }), 'gh pr create inside quoted echo must not block');
        allow(guard(sb, 'echo "run glab mr create --target-branch dev from your feature branch"', { cwd: f.repo, db: f.db }), 'glab mr create inside quoted echo must not block');
    });
});
describe('git-guards l3: registration-based managed-repo scope (#693, #15/H8)', () => {
    /** <sandbox>/ws holding the DB, with repos managed and sibling on main; "both" registers sibling too. */
    function workspace(mode) {
        const ws = join(sb.dir, 'ws');
        mkdirSync(ws);
        const db = newDb(ws);
        const managed = initAt(sb, join(ws, 'managed'), 'main');
        const sibling = initAt(sb, join(ws, 'sibling'), 'main');
        register(db, 'managed', managed);
        if (mode === 'both')
            register(db, 'sibling', sibling);
        const run = (dir, cmd) => guard(sb, `cd ${dir} && ${cmd}`, { cwd: ws, db });
        return { ws, db, managed, sibling, run };
    }
    it('#693: registered repo direct commit to main IS blocked', () => {
        const w = workspace('single');
        deny(w.run(w.managed, 'git commit -m broken'), "commit on registered repo's protected main must block");
    });
    it('#693: unregistered sibling direct commit to main is ALLOWED (no-op)', () => {
        const w = workspace('single');
        allow(w.run(w.sibling, 'git commit -m wip'), 'commit in unregistered sibling tree must no-op');
    });
    it('#693: unregistered sibling branch-from-main is ALLOWED (Rule 4 no-op)', () => {
        const w = workspace('single');
        allow(w.run(w.sibling, 'git checkout -b feat/x'), 'branch creation in unregistered sibling must no-op');
    });
    it('#693: when BOTH siblings are registered, each is independently guarded', () => {
        const w = workspace('both');
        deny(w.run(w.managed, 'git commit -m broken'), 'registered managed repo must block');
        deny(w.run(w.sibling, 'git commit -m broken'), 'registered sibling repo must also block');
    });
    it('#15/H8: command in non-repo workspace root (no cd target): no-op, not a guessed-policy block', () => {
        const w = workspace('single');
        allow(guard(sb, 'git checkout -b feat/x', { cwd: w.ws, db: w.db }), 'unresolved repo must no-op (no main-policy enforcement)');
    });
});
describe('git-guards l3: per-repo protected_branches and safe defaults (#693, #987)', () => {
    /** main, then switched to release; protected_branches set to <protectedJson> when given. */
    function releaseRepo(protectedJson) {
        const repo = initAt(sb, join(sb.dir, 'repo'), 'main');
        git(sb.env, repo, 'switch', '-q', '-c', 'release');
        const db = newDb(repo);
        register(db, 'fixture', repo, protectedJson === undefined ? {} : { protected: protectedJson });
        return { repo, db };
    }
    it("#693: per-repo protected_branches wins: commit on per-repo-protected 'release' blocks", () => {
        const f = releaseRepo('["release"]');
        deny(guard(sb, 'git commit -m broken', { cwd: f.repo, db: f.db }), 'per-repo protected_branches=[release] must block commit on release');
    });
    it('#693: per-repo unset: safe-default protected (release NOT in [main,dev], commit allowed)', () => {
        const f = releaseRepo();
        allow(guard(sb, 'git commit -m wip', { cwd: f.repo, db: f.db }), 'with per-repo empty, safe-default [main,dev] does not cover release: no block');
    });
    it('#987: unconfigured registered repo: direct commit on main DENIED (safe default, no fail-open)', () => {
        const f = unconfiguredRepo(sb, 'main');
        deny(guard(sb, 'git commit -m broken', { cwd: f.repo, db: f.db }), 'unconfigured repo must deny commit on default-protected main');
    });
    it('#987: unconfigured registered repo: direct commit on dev DENIED (safe default protects dev too)', () => {
        const f = unconfiguredRepo(sb, 'dev');
        deny(guard(sb, 'git commit -m broken', { cwd: f.repo, db: f.db }), 'unconfigured repo must deny commit on default-protected dev');
    });
    it('#987: unconfigured registered repo: force-push to main DENIED (safe default, no fail-open)', () => {
        const f = unconfiguredRepo(sb, 'main');
        deny(guard(sb, 'git push -f origin main', { cwd: f.repo, db: f.db }), 'unconfigured repo must deny force-push to default-protected main');
    });
    it('repos row without target: PR target resolves from origin/HEAD', () => {
        const f = unconfiguredRepo(sb, 'main');
        git(sb.env, f.repo, 'branch', 'trunk');
        git(sb.env, f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
        allow(guard(sb, 'gh pr create --base trunk --head feat/x', { cwd: f.repo, db: f.db }), 'base equal to the origin/HEAD branch is the PR target');
        has(guard(sb, 'gh pr create --base main --head feat/x', { cwd: f.repo, db: f.db }), 'PRs must target trunk', 'other base denied, naming the resolved target');
    });
});
describe('git-guards l3: configured target_branch ref missing (#13/H3)', () => {
    let f;
    beforeEach(() => {
        const repo = initAt(sb, join(sb.dir, 'repo'), 'main');
        const db = newDb(repo);
        register(db, 'fixture', repo, { target: 'dev', model: 'gitflow', protected: '["main","dev"]' });
        f = { repo, db };
    });
    it('missing target_branch ref: branch-from-default (main) ALLOWED', () => allow(guard(sb, 'git checkout -b feat/x', { cwd: f.repo, db: f.db }), "branch from real default (main) must be allowed when configured 'dev' ref is missing"));
    it('missing target_branch ref: branch from a NON-default branch still BLOCKS', () => {
        git(sb.env, f.repo, 'branch', 'feat/existing');
        git(sb.env, f.repo, 'checkout', '-q', 'feat/existing');
        const out = guard(sb, 'git checkout -b feat/y', { cwd: f.repo, db: f.db });
        deny(out, 'fallback target is main, not blanket-allow: branching off feat/existing must block');
        has(out, 'from main', 'block message must name the fallback default branch');
    });
});
describe('git-guards l3: Rule 2 splits by command class (#1070, #1073)', () => {
    /** main plus staging (a task's parent_branch_id) and feat/plain. */
    function taskParentRepo(protectedJson, target) {
        const repo = initAt(sb, join(sb.dir, 'repo'), 'main');
        git(sb.env, repo, 'branch', 'staging', 'HEAD');
        git(sb.env, repo, 'branch', 'feat/plain', 'HEAD');
        const db = newDb(repo);
        register(db, 'fixture', repo, { target, model: 'github-flow', protected: protectedJson });
        insertTask(db, 'feat/child', 'staging');
        return { repo, db };
    }
    it("#1070: git commit on a task's parent_branch_id (absent from protected_branches) IS blocked", () => {
        const f = taskParentRepo('["main"]', 'main');
        git(sb.env, f.repo, 'checkout', '-q', 'staging');
        const out = guard(sb, 'git commit -m x', { cwd: f.repo, db: f.db });
        deny(out, "commit on task-parent base 'staging' must block");
        has(out, 'staging', 'deny message must name the shared base');
        has(out, 'surface it to the Human', 'no-remote deny message must teach the surface-to-Human recovery');
    });
    it('#1073: git merge into a plain feature branch in the main checkout IS blocked (integration is PR-only)', () => {
        const f = taskParentRepo('["main"]', 'main');
        git(sb.env, f.repo, 'checkout', '-q', 'feat/plain');
        const out = guard(sb, 'git merge feat/child', { cwd: f.repo, db: f.db });
        deny(out, 'merge in the main checkout must block regardless of target branch');
        has(out, 'integration is PR-only', 'deny message must teach the PR-only integration path');
    });
    it('#1070: git commit on target_branch is blocked even when protected_branches is empty', () => {
        const f = taskParentRepo('[]', 'main');
        const out = guard(sb, 'git commit -m x', { cwd: f.repo, db: f.db });
        deny(out, "commit on target_branch 'main' must block despite empty protected_branches");
        has(out, 'main', 'deny message must name the target base');
    });
    it('#1073: git merge inside a worktree is ALLOWED (SWE integration mechanics)', () => {
        const f = worktreeRepo(sb);
        allow(guard(sb, 'cd .claude/worktrees/task-1 && git merge feat/other', { cwd: f.repo, db: f.db }), 'merge inside a task worktree must be allowed');
    });
    it('#1073: git rebase inside a worktree is ALLOWED (SWE integration mechanics)', () => {
        const f = worktreeRepo(sb);
        allow(guard(sb, 'cd .claude/worktrees/task-1 && git rebase main', { cwd: f.repo, db: f.db }), 'rebase inside a task worktree must be allowed');
    });
});
describe('git-guards l3: in-command branch create before the commit (#54, #58)', () => {
    let f;
    beforeEach(() => {
        f = worktreeRepo(sb);
    });
    const run = (cmd) => guard(sb, cmd, { cwd: f.repo, db: f.db });
    const protectDev = () => sql(f.db, `UPDATE repos SET protected_branches='["main","dev"]'`);
    it('#54: fresh-clone compound (clone + checkout -b feat/x + commit) is ALLOWED', () => allow(run("git clone https://example.com/x.git repo && cd repo && git checkout -b feat/x && git commit -m 'bump'"), 'in-command checkout -b feat/x must land the commit on the new branch'));
    it('#54: in-command checkout -b dev (protected name) is DENIED', () => {
        protectDev();
        deny(run("git clone https://example.com/x.git repo && cd repo && git checkout -b dev && git commit -m 'bump'"), 'creating a protected branch name must still block the commit');
    });
    it('#54: plain git commit with cwd on protected main is DENIED (regression)', () => deny(run('git commit -m broken'), 'no in-command branch-create: fail-closed cwd resolution denies on main'));
    it('#54: branch-create AFTER the commit in the command text is DENIED', () => deny(run('git commit -m broken && git checkout -b feat/late'), 'a create that follows the commit does not cover it: deny'));
    it('#54: git switch -c feat/y variant is ALLOWED', () => allow(run("git clone https://example.com/x.git repo && cd repo && git switch -c feat/y && git commit -m 'bump'"), 'switch -c feat/y must land the commit on the new branch'));
    it('#54: create-then-switch-back (checkout -b feat/z && git checkout dev && commit) is DENIED', () => deny(run('git checkout -b feat/z && git checkout dev && git commit -m x'), 'a plain checkout after the create re-ambiguates the landing branch: deny'));
    it('#58: laundering (checkout -b feat/x && commit && checkout dev && commit) is DENIED', () => {
        protectDev();
        const out = run(`cd ${f.repo} && git checkout -b feat/x && git commit -m a && git checkout dev && git commit -m b`);
        deny(out, 'a trailing commit landing on protected dev must be blocked even after a clean feature-branch commit');
        has(out, 'dev is a shared workflow base', 'the deny names the protected landing branch');
    });
    it('#58: two commits on the same feature branch (checkout -b feat/x && commit && commit) is ALLOWED', () => allow(run(`cd ${f.repo} && git checkout -b feat/x && git commit -m a && git commit -m b`), 'every commit lands on the non-protected feat/x: allowed'));
});
describe('git-guards l3: target dir from the command, heredocs are data (GH 1196, GH 1281, GH 1595, GH 1610, GH 1911)', () => {
    let repo;
    let wt;
    let db;
    beforeEach(() => {
        repo = initAt(sb, join(sb.dir, 'repo'), 'dev');
        git(sb.env, repo, 'remote', 'add', 'origin', join(repo, '.origin.git'));
        git(sb.env, repo, 'branch', 'fix/thing');
        git(sb.env, repo, 'worktree', 'add', '-q', '.claude/worktrees/thing', 'fix/thing');
        db = newDb(repo);
        register(db, 'fixture', repo, { target: 'dev', model: 'gitflow', protected: '["main","dev"]' });
        wt = join(repo, '.claude/worktrees/thing');
    });
    const run = (agent, payloadCwd, cmd, gate) => guard(sb, cmd, { cwd: repo, db, agent, payloadCwd, gate });
    const dropWorktree = () => git(sb.env, repo, 'worktree', 'remove', '--force', wt);
    it("GH 1196: bro 'git -C <main> push' with payload cwd inside a worktree: allowed", () => allow(run(undefined, wt, `git -C ${repo} push origin fix/thing`), 'an explicit -C target decides, not the payload cwd'));
    it("GH 1196: bro 'cd <main> && gh issue create' with payload cwd inside a worktree: allowed", () => allow(run(undefined, wt, `cd ${repo} && gh issue create --title x --body y`), 'an issue create is not a git-workflow op'));
    it("GH 1196: SWE 'cd <wt> && git commit' with the main checkout on dev: allowed", () => allow(run('swe', repo, `cd ${wt} && git commit -m 'fix: thing'`), "the cd target's branch (fix/thing) decides, not main's dev"));
    it("GH 1196: SWE bare 'git commit' with worktrees present: ambiguous_git_target with the remedy", () => {
        const out = run('swe', repo, "git commit -m 'fix: thing'");
        deny(out, 'no dir and several checkouts must deny');
        has(out, 'ambiguous_git_target', 'the deny names the real reason');
        has(out, 'git -C <path> or cd <path>', 'the deny carries the remedy');
        hasNot(out, 'shared workflow base', 'never the protected-branch rule the agent did not break');
    });
    it('GH 1196: markdown-only heredoc mentioning git commit / gh pr merge: allowed', () => {
        const heredoc = [`cat > ${wt}/notes.md <<'EOF'`, "Run git commit -m 'x' on dev, then gh pr merge 12 --merge.", 'git merge feat/x', 'EOF'].join('\n');
        allow(run('swe', repo, heredoc), 'heredoc content is data');
        allow(run('swe', repo, `python3 -c "open('t.txt','w').write('gh pr merge 3; git commit -m x')"`), "a python program's text is data");
    });
    it('GH 1196: protected-branch commit with an explicit dir: still denied, remote named correctly', () => {
        const out = run('swe', wt, `git -C ${repo} commit -m 'fix: thing'`);
        has(out, 'dev is a shared workflow base', 'an explicit dir on protected dev denies');
        has(out, 'open a PR into dev', 'the repo has a remote: the recovery says so');
        hasNot(out, 'no remote', 'never the false no-remote claim');
    });
    it("GH 1196: 'cd $D && git commit' with worktrees present: ambiguous_git_target, as git-push-guard", () => {
        let out = run('swe', repo, 'cd $D && git commit -m x');
        has(out, 'ambiguous_git_target', 'a dir behind a variable in a repo with worktrees is ambiguous');
        has(out, 'git -C <path> or cd <path>', 'the deny carries the remedy');
        out = run(undefined, repo, 'cd $D && git checkout -b feat/y');
        has(out, 'ambiguous_git_target', 'a branch create behind a variable dir is ambiguous too');
        has(run(undefined, repo, 'cd $D && git push origin fix/thing', 'git-push-guard'), 'ambiguous_git_target', 'git-push-guard gives the same verdict for the same unknown dir');
    });
    it('GH 1281: bro gh issue comment whose $( ) heredoc body names cd && git commit: allowed', () => {
        const cmd = ['gh issue comment 1 --body "$(cat <<\'EOF\'', 'run: cd x && git commit --amend then rebase', 'and `cd x && git push origin dev` after', 'EOF', ')"'].join('\n');
        allow(run(undefined, repo, cmd), 'the comment body is data');
    });
    it('GH 1281: bro heredoc into a --body-file naming git push origin dev: allowed', () => {
        const cmd = ["cat > notes.md <<'EOF'", 'git push origin dev', 'git commit --amend', 'EOF', 'gh issue comment 1 --body-file notes.md'].join('\n');
        allow(run(undefined, repo, cmd), 'the notes file body is data');
    });
    it('GH 1281: git commit on dev in the main checkout: still denied', () => {
        dropWorktree();
        has(run(undefined, repo, 'git commit -m x'), 'dev is a shared workflow base', 'a real commit on protected dev denies');
    });
    it("GH 1281: 'cd <wt> && git commit --amend' on a feature branch: allowed; same on the main checkout at dev: denied", () => {
        allow(run(undefined, repo, `cd ${wt} && git commit --amend`), "judged against the worktree's fix/thing");
        has(run(undefined, wt, `cd ${repo} && git commit --amend`), 'dev is a shared workflow base', "judged against the main checkout's dev");
    });
    it("GH 1196: 'cd $D && git commit' without worktrees: judged in the payload cwd", () => {
        dropWorktree();
        let out = run('swe', repo, 'cd $D && git commit -m x');
        hasNot(out, 'ambiguous_git_target', 'one checkout is never ambiguous');
        has(out, 'dev is a shared workflow base', "judged on the payload cwd's branch (dev)");
        git(sb.env, repo, 'checkout', '-q', 'fix/thing');
        out = run('swe', repo, 'cd $D && git commit -m x');
        allow(out, 'on a feature branch the commit is allowed');
    });
    it("GH 1595: 'R=<wt>; git -C $R commit' with worktrees present: resolved, allowed", () => {
        const out = run('swe', repo, `R=${wt}; git -C $R commit -m x`);
        hasNot(out, 'ambiguous_git_target', 'a variable set to a literal in the same command names the dir');
        allow(out, 'the commit lands on fix/thing');
        has(run('swe', repo, `R=${repo}; git -C "$R" commit -m x`), 'dev is a shared workflow base', 'resolved to the main checkout, judged on its dev');
    });
    it("GH 1610: swe 'WT=<own worktree>; cd $WT && git add f && git commit': allowed", () => {
        allow(run('swe', repo, `WT=${wt}; cd $WT && git add f && git commit -m x`), 'the cd target comes from the same command');
        allow(run('swe', repo, `export WT=${wt} && cd "\${WT}" && git commit -m x`), 'export VAR=<literal> && cd ${VAR} resolves too');
    });
    it("GH 1911: 'W=<repo>; git -C $W commit' keeps its dir past a quoted '(' and a data heredoc, not past an expanding one", () => {
        let out = run('swe', repo, `W=${repo}; git -C $W commit -q -m "a (b)"`);
        hasNot(out, 'ambiguous_git_target', 'quoted parens in -m are data');
        has(out, 'dev is a shared workflow base', 'resolved to the main checkout, judged on its dev');
        out = run('swe', repo, `W=${repo}; git -C $W commit -q -F - <<EOM\nmsg\nEOM`);
        hasNot(out, 'ambiguous_git_target', '-F - <<EOM with a plain body is data');
        has(out, 'dev is a shared workflow base', 'the heredoc form resolves to the main checkout too');
        out = run('swe', repo, `W=${repo}; : <<EOM\n$((W=0))\nEOM\ngit -C $W commit -q -m x`);
        has(out, 'ambiguous_git_target', 'an unquoted heredoc body that assigns still kills the variable');
    });
    it("GH 2404: 'W=<dir>; git -C $W commit … 2>&1' keeps its dir past a literal redirect, not past one that can reassign", () => {
        let out = run('swe', repo, `W=${wt}; git -C $W commit -m x 2>&1`);
        hasNot(out, 'ambiguous_git_target', 'an fd duplication cannot reassign the variable');
        allow(out, 'the commit lands on fix/thing');
        allow(run('swe', repo, `W=${wt}; git -C "$W" commit -m x 2>/dev/null | tail -3`), 'a literal redirect before a pipe resolves too');
        out = run('swe', repo, `W=${repo}; git -C $W commit -m x 2>&1`);
        hasNot(out, 'ambiguous_git_target', 'resolved to the main checkout');
        has(out, 'dev is a shared workflow base', "judged on the main checkout's dev");
        for (const redirect of ['>$(W=0)', '2>$((W=0))', '>"$W"/log']) {
            out = run(undefined, repo, `W=${wt}; git -C $W merge x ${redirect}`);
            deny(out, `${redirect} can reassign the variable`);
            has(out, 'comes through a variable', `${redirect} leaves the dir unresolved`);
        }
    });
    it("GH 1595: 'cd $UNSET && git commit' with worktrees present: unresolvable-dir deny, not 'names no directory'", () => {
        const out = run('swe', repo, 'cd $UNSET && git commit -m x');
        has(out, 'ambiguous_git_target', 'the deny keeps its token');
        has(out, 'comes through a variable', 'the deny says the dir is behind something the guard cannot resolve');
        has(out, 'Pass the literal path', 'the deny carries the remedy');
        hasNot(out, 'names no directory', 'the statement does name a dir');
        has(run('swe', repo, `if true; then R=${wt}; fi; cd $R && git commit -m x`), 'comes through a variable', 'a conditional assignment is not trusted');
        deny(run(undefined, repo, `R=${wt}; echo $[R=0]; git -C $R merge fix/thing`), 'arithmetic in an argument can reassign the variable');
        deny(run(undefined, repo, `R=${wt}; true <<EOF\n$[R=0]\nEOF\ngit -C $R merge fix/thing`), 'a heredoc body can reassign the variable');
        has(run(undefined, repo, 'cd $UNSET && git push origin fix/thing', 'git-push-guard'), 'comes through a variable', 'git-push-guard names the unresolvable dir the same way');
    });
});
describe('git-guards l3: a fast-forward to its own upstream is a sync (GH 1596)', () => {
    let repo;
    let db;
    beforeEach(() => {
        const origin = join(sb.dir, 'origin.git');
        mkdirSync(origin);
        git(sb.env, origin, 'init', '-q', '--bare');
        repo = initAt(sb, join(sb.dir, 'work'), 'main');
        git(sb.env, repo, 'remote', 'add', 'origin', origin);
        git(sb.env, repo, 'push', '-q', '-u', 'origin', 'main');
        git(sb.env, repo, 'switch', '-q', '-c', 'feat/x');
        commit(sb.env, repo, 'x', { x: 'x\n' });
        git(sb.env, repo, 'push', '-q', '-u', 'origin', 'feat/x');
        git(sb.env, repo, 'switch', '-q', 'main');
        db = newDb(repo);
        register(db, 'fixture', repo, { target: 'main', model: 'github-flow', protected: '["main"]' });
    });
    const run = (cmd) => guard(sb, cmd, { cwd: repo, db, payloadCwd: repo });
    const integration = (cmd) => has(run(cmd), 'integration is PR-only', `denied: ${cmd}`);
    it("'git merge --ff-only origin/main' on main tracking origin/main, main checkout: allowed", () => {
        allow(run('git merge --ff-only origin/main'), "a fast-forward to the branch's own upstream is a sync");
        allow(run(`git -C ${repo} merge --ff-only @{u}`), "@{u} is always the branch's own upstream");
        allow(run('git switch feat/x && git merge --ff-only origin/feat/x'), "an inline switch && ff-only to the switched branch's upstream");
    });
    it("ff-only to another branch, a plain merge, or a ';'-joined switch stay denied", () => {
        let out = run('git merge --ff-only origin/feat/x');
        has(out, 'integration is PR-only', 'ff-only to a branch other than the upstream is integration');
        has(out, 'git pull --ff-only', 'the deny names the sync route');
        has(run('git merge origin/main'), 'integration is PR-only', 'a merge without --ff-only stays denied');
        has(run('git merge --ff-only --no-verify origin/main'), 'integration is PR-only', 'an unknown merge option stays denied');
        has(run('git switch feat/x; git merge --ff-only origin/feat/x'), 'integration is PR-only', 'a failed switch before ; would fast-forward main onto feat/x');
        has(run('git switch feat/x && echo ok && git merge --ff-only origin/feat/x'), 'integration is PR-only', 'the switch must be the statement right before the merge');
        out = run('git rebase origin/main');
        has(out, 'integration is PR-only', 'rebase is unchanged');
        hasNot(out, 'git pull --ff-only', 'the sync hint is for merges');
        allow(run('git fetch origin && git merge --ff-only origin/main'), 'fetch && ff-only to the upstream stays a sync');
    });
    it("on a feature branch, a switch to main the guard cannot follow does not borrow the feature branch's upstream", () => {
        git(sb.env, repo, 'switch', '-q', 'feat/x');
        git(sb.env, repo, 'config', 'alias.co', 'checkout');
        for (const c of [
            'git switch -q main && git merge --ff-only origin/feat/x',
            'git checkout --quiet main && git merge --ff-only origin/feat/x',
            'git switch main >/dev/null && git merge --ff-only origin/feat/x',
            'git co main && git merge --ff-only origin/feat/x',
            'git switch --discard-changes main && git merge --ff-only origin/feat/x',
            "bash -c 'git switch -q main' && git merge --ff-only origin/feat/x",
            'echo x > .git/HEAD && git merge --ff-only origin/feat/x',
        ])
            integration(c);
        allow(run('git switch -q main && git merge --ff-only origin/main'), "switch -q main && ff-only to main's own upstream is a sync");
    });
    it("a switch a '!' or '||' can skip, or a branch change anywhere in the command, voids the sync exception", () => {
        for (const c of [
            '! git switch feat/x && git merge --ff-only origin/feat/x',
            'true || git switch feat/x && git merge --ff-only origin/feat/x',
            'git branch -u origin/feat/x && git merge --ff-only @{u}',
            'git branch --set-upstream-to=origin/feat/x main; git merge --ff-only @{u}',
            'git reset -q --hard origin/feat/x; git merge --ff-only @{u}',
        ])
            integration(c);
    });
    it('a local upstream (branch.<b>.remote = .) is integration, not a sync', () => {
        git(sb.env, repo, 'branch', '-q', '-u', 'feat/x', 'main');
        for (const c of ['git merge --ff-only feat/x', 'git merge --ff-only @{u}'])
            integration(c);
    });
});
//# sourceMappingURL=git-guards-l3.test.js.map