/**
 * clean-merged-branch end to end (GH 1692), the l3 bash suite's cases in
 * node:test. After a successful `gh pr merge` / `glab mr merge` the PostToolUse
 * gate removes the merged branch's clean worktree, deletes the local branch and
 * prunes, when the branch is not protected and its work is in its base
 * (ancestor, squash or rebase merge, GH 1674). A dirty worktree is skipped with
 * a warning; everything else is silent; TMB_DISABLE_CLEAN_MERGED_BRANCH=1
 * bypasses. Each case runs `node dist/hooks.js clean-merged-branch` with
 * CLAUDE_PROJECT_DIR pinned to the sandbox and PWD set.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate } from './hook-sandbox.js';
import { gateEnv, git, has, hasNot, sql, tryGit } from './git-push-guard-l3.js';
import { sqlExec } from './db-test-fixtures.js';
const GATE = 'clean-merged-branch';
const MERGED = '✓ Merged pull request';
describe('clean-merged-branch l3', () => {
    let sb;
    let repo;
    let db;
    let squashes = 0;
    const g = (dir, ...args) => git(sb.env, dir, ...args);
    const ok = (dir, ...args) => tryGit(sb.env, dir, args).status === 0;
    const branchExists = (b, dir = repo) => ok(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`);
    const wt = (slug) => join(sb.dir, `wt-${slug}`);
    const input = (command, cwd = repo, response = MERGED) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: response, cwd });
    /** The gate's stdout and stderr (a `2>&1`), trailing newlines gone. */
    function runHook(payload, env = {}) {
        const r = runGate(GATE, { cwd: sb.dir, input: payload, env: { ...gateEnv(sb, sb.dir), TRAJECTORY_DB_PATH: db, ...env } });
        return (r.stdout + r.stderr).replace(/\n+$/, '');
    }
    function commitAll(dir, msg, files) {
        for (const [name, body] of Object.entries(files))
            writeFileSync(join(dir, name), body);
        g(dir, 'add', '.');
        g(dir, 'commit', '-qm', msg);
    }
    /** A feature branch merged into dev (dev fast-forwarded to it), with an attached worktree. */
    function makeMerged(branch, slug) {
        g(repo, 'branch', branch, 'dev');
        g(repo, 'worktree', 'add', '-q', wt(slug), branch);
        commitAll(wt(slug), `feat ${slug}`, { [`f-${slug}.txt`]: `feature ${slug}\n` });
        g(repo, 'branch', '-f', 'dev', branch);
    }
    /** Squash-merges <branch> into dev from a scratch worktree, then advances dev past it. */
    function squashIntoDev(branch) {
        const base = wt('squash-base');
        g(repo, 'worktree', 'add', '-q', base, 'dev');
        g(base, 'merge', '-q', '--squash', branch);
        g(base, 'commit', '-qm', `${branch} (#1)`);
        squashes += 1;
        commitAll(base, 'later dev work', { [`later-${squashes}.txt`]: 'later\n' });
        g(repo, 'worktree', 'remove', base);
    }
    function initRepo(dir, base) {
        mkdirSync(dir, { recursive: true });
        g(dir, 'init', '-q', '-b', '_parking');
        g(dir, 'config', 'user.email', 't@t.io');
        g(dir, 'config', 'user.name', 't');
        commitAll(dir, 'init', { 'README.md': 'init\n' });
        g(dir, 'branch', base, '_parking');
    }
    before(() => {
        sb = makeSandbox('clean-merged-branch');
        repo = join(sb.dir, 'repo');
        initRepo(repo, 'dev');
        db = join(sb.dir, '.claude/tmb/trajectory.db');
        mkdirSync(join(sb.dir, '.claude/tmb'), { recursive: true });
        sqlExec(db, readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
        sql(db, `INSERT INTO repos (name, path, target_branch, protected_branches) VALUES ('repo', ?, 'dev', '["main","dev"]')`, g(repo, 'rev-parse', '--show-toplevel'));
    });
    after(() => sb.remove());
    it('(a) merged clean branch + worktree → both removed', () => {
        makeMerged('feat/clean', 'clean');
        assert.ok(existsSync(wt('clean')), 'setup worktree missing');
        const out = runHook(input('gh pr merge feat/clean --squash --delete-branch'));
        has(out, 'cleaned up merged branch feat/clean', 'cleanup report');
        assert.ok(!branchExists('feat/clean'), 'branch still present');
        assert.ok(!existsSync(wt('clean')), 'worktree still present');
    });
    it("(a') glab mr merge also triggers cleanup (git/gh/glab parity)", () => {
        makeMerged('feat/glab', 'glab');
        const out = runHook(input('glab mr merge feat/glab --squash'));
        has(out, 'cleaned up merged branch feat/glab', 'glab cleanup report');
        assert.ok(!branchExists('feat/glab'), 'glab branch still present');
    });
    it('(b) protected branch (dev) → untouched', () => {
        g(repo, 'worktree', 'add', '-q', wt('dev'), 'dev');
        runHook(input('gh pr merge --squash', wt('dev')));
        assert.ok(branchExists('dev'), 'dev branch was deleted');
        assert.ok(existsSync(wt('dev')), 'dev worktree was removed');
        tryGit(sb.env, repo, ['worktree', 'remove', wt('dev')]);
    });
    it("(b') protected via repos.protected_branches → untouched", () => {
        sql(db, `UPDATE repos SET protected_branches = '["main","dev","release"]' WHERE name='repo'`);
        g(repo, 'branch', 'release', 'dev');
        runHook(input('gh pr merge release --squash'));
        assert.ok(branchExists('release'), "protected 'release' branch deleted");
        tryGit(sb.env, repo, ['branch', '-D', 'release']);
        sql(db, `UPDATE repos SET protected_branches = '["main","dev"]' WHERE name='repo'`);
    });
    it('(c) dirty worktree → skipped with warning, not removed', () => {
        makeMerged('feat/dirty', 'dirty');
        writeFileSync(join(wt('dirty'), 'scratch.txt'), 'uncommitted\n');
        const out = runHook(input('gh pr merge feat/dirty --squash'));
        has(out, 'uncommitted/untracked changes', 'dirty warning');
        assert.ok(branchExists('feat/dirty'), 'dirty branch was deleted');
        assert.ok(existsSync(wt('dirty')), 'dirty worktree was removed');
    });
    it('(d) non-merge Bash command → no-op (silent)', () => {
        makeMerged('feat/nonmerge', 'nonmerge');
        assert.equal(runHook(input('git status')), '', 'non-merge command is silent');
        assert.ok(branchExists('feat/nonmerge'), 'branch deleted on non-merge cmd');
    });
    it('(e) not-merged branch (not an ancestor of base) → untouched', () => {
        g(repo, 'branch', 'feat/unmerged', 'dev');
        g(repo, 'worktree', 'add', '-q', wt('unmerged'), 'feat/unmerged');
        commitAll(wt('unmerged'), 'diverge', { 'd.txt': 'diverge\n' });
        runHook(input('gh pr merge feat/unmerged --squash'));
        assert.ok(branchExists('feat/unmerged'), 'unmerged branch deleted');
        tryGit(sb.env, repo, ['worktree', 'remove', '--force', wt('unmerged')]);
        tryGit(sb.env, repo, ['branch', '-D', 'feat/unmerged']);
    });
    it("(e') squash-merged multi-commit branch + worktree → both removed (GH 1674)", () => {
        g(repo, 'branch', 'feat/squashed', 'dev');
        g(repo, 'worktree', 'add', '-q', wt('squashed'), 'feat/squashed');
        commitAll(wt('squashed'), 'squash part 1', { 'sq.txt': 'one\n' });
        commitAll(wt('squashed'), 'squash part 2', { 'sq.txt': 'two\n', 'sq2.txt': 'extra\n' });
        squashIntoDev('feat/squashed');
        assert.ok(!ok(repo, 'merge-base', '--is-ancestor', 'feat/squashed', 'dev'), 'setup — squashed tip is an ancestor');
        const out = runHook(input('gh pr merge feat/squashed --squash'));
        has(out, 'cleaned up merged branch feat/squashed', 'squash cleanup report');
        assert.ok(!branchExists('feat/squashed'), 'squash-merged branch still present');
        assert.ok(!existsSync(wt('squashed')), 'squash-merged worktree still present');
    });
    it("(e'') squash-merged branch with an unmerged follow-up commit → kept (GH 1674)", () => {
        g(repo, 'branch', 'feat/partial', 'dev');
        g(repo, 'worktree', 'add', '-q', wt('partial'), 'feat/partial');
        commitAll(wt('partial'), 'partial part 1', { 'p.txt': 'first\n' });
        squashIntoDev('feat/partial');
        commitAll(wt('partial'), 'follow-up not in dev', { 'p2.txt': 'followup\n' });
        const out = runHook(input('gh pr merge feat/partial --squash'));
        hasNot(out, 'cleaned up merged branch', 'no cleanup report');
        assert.ok(branchExists('feat/partial'), 'branch with unmerged work deleted');
        tryGit(sb.env, repo, ['worktree', 'remove', '--force', wt('partial')]);
        tryGit(sb.env, repo, ['branch', '-D', 'feat/partial']);
    });
    it("(e''') 2000 unmerged commits — git cherry output past the pipe buffer → kept (GH 1674)", () => {
        let stream = '';
        for (let i = 1; i <= 2000; i++) {
            stream += `commit refs/heads/feat/huge\ncommitter t <t@t.io> ${1700000000 + i} +0000\ndata 4\nbig\n`;
            if (i === 1)
                stream += 'from refs/heads/dev\n';
            stream += `M 100644 inline huge.txt\ndata ${String(i).length + 1}\n${i}\n`;
        }
        const r = tryGit(sb.env, repo, ['fast-import', '--quiet'], stream);
        assert.equal(r.status, 0, `fast-import: ${r.stderr}`);
        assert.equal(g(repo, 'rev-list', '--count', 'dev..feat/huge'), '2000', 'setup — expected 2000 unmerged commits');
        const out = runHook(input('gh pr merge feat/huge --squash'));
        hasNot(out, 'cleaned up merged branch', 'no cleanup report');
        assert.ok(branchExists('feat/huge'), 'branch with 2000 unmerged commits deleted');
        tryGit(sb.env, repo, ['branch', '-D', 'feat/huge']);
    });
    it('(f) TMB_DISABLE_CLEAN_MERGED_BRANCH=1 bypass → untouched', () => {
        makeMerged('feat/bypass', 'bypass');
        const out = runHook(input('gh pr merge feat/bypass --squash'), { TMB_DISABLE_CLEAN_MERGED_BRANCH: '1' });
        assert.equal(out, '', 'bypass silences the hook');
        assert.ok(branchExists('feat/bypass'), 'branch deleted despite bypass');
    });
    it('(g) failed merge response → untouched', () => {
        makeMerged('feat/failed', 'failed');
        runHook(input('gh pr merge feat/failed --squash', repo, 'GraphQL: Pull request is not mergeable'));
        assert.ok(branchExists('feat/failed'), 'branch deleted on failed merge');
    });
    it('(h) merged branch with no worktree → branch still deleted', () => {
        g(repo, 'branch', 'feat/nowt', 'dev');
        const out = runHook(input('gh pr merge feat/nowt --squash'));
        has(out, 'cleaned up merged branch feat/nowt', 'no-worktree cleanup report');
        assert.ok(!branchExists('feat/nowt'), 'branch not deleted');
    });
    it("(i) multi-repo: 'cd <sibling> && gh pr merge' resolves the SIBLING repo, not the payload cwd/$PWD", () => {
        const sib = join(sb.dir, 'sibling');
        initRepo(sib, 'main');
        g(sib, 'branch', 'feat/sib', 'main');
        g(sib, 'worktree', 'add', '-q', wt('sib'), 'feat/sib');
        commitAll(wt('sib'), 'feat sib', { 's.txt': 'work\n' });
        g(sib, 'branch', '-f', 'main', 'feat/sib');
        sql(db, `INSERT INTO repos (name, path, target_branch, protected_branches) VALUES ('sibling', ?, 'main', '["main"]')`, g(sib, 'rev-parse', '--show-toplevel'));
        const out = runHook(input(`cd ${sib} && gh pr merge feat/sib --squash`));
        has(out, 'cleaned up merged branch feat/sib', 'cd target (sibling) must be resolved, not payload cwd');
        assert.ok(!branchExists('feat/sib', sib), 'sibling branch not deleted');
        assert.ok(branchExists('dev'), "first repo's dev branch affected");
    });
    it('(e) base resolves to a missing ref → merged branch left alone', () => {
        makeMerged('feat/nobase', 'nobase');
        sql(db, "UPDATE repos SET target_branch = NULL WHERE name='repo'");
        g(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
        const out = runHook(input('gh pr merge feat/nobase --squash'));
        hasNot(out, 'cleaned up merged branch', 'no cleanup report');
        assert.ok(branchExists('feat/nobase'), 'branch deleted without a resolvable base');
        g(repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
        sql(db, "UPDATE repos SET target_branch = 'dev' WHERE name='repo'");
    });
});
//# sourceMappingURL=clean-merged-branch-l3.test.js.map