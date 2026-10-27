/**
 * Unit tests of the TypeScript merge-lifecycle gates (GH 1692):
 * clean-merged-branch and close-issue-on-merge. They cover the command, ref
 * and closing-ref parsing the parity corpus leans on, and the divergences from
 * the .sh that decision 703 allows: on a PATH holding neither jq nor the
 * sqlite3 CLI, where each .sh exits 0 untouched (and clean-merged-branch.sh
 * falls back to the default branch), both gates still act.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findGate, gateNames } from '../hooks/registry.js';
import { branchFromCmd, cleanMergedBranch, integrated, namesMerge, worktreeForBranch } from '../hooks/clean-merged-branch.js';
import { closeIssueOnMerge, closingRefs, mergeArgs, refFromArgs, syncOn } from '../hooks/close-issue-on-merge.js';
import { mergeFailed, readMergePayload } from '../hooks/lib/merge.js';
import { cmdCwd } from '../hooks/lib/repo.js';
import { buildSandbox } from './hooks-merge-lifecycle-parity.suite.js';
const ALLOWED = { stdout: '', code: 0 };
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
/** Runs <fn> with process.stderr.write captured, returning what it wrote. */
function stderrOf(fn) {
    const original = process.stderr.write.bind(process.stderr);
    let out = '';
    process.stderr.write = ((chunk) => {
        out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    });
    try {
        fn();
    }
    finally {
        process.stderr.write = original;
    }
    return out;
}
function payload(command, cwd, response = { stdout: 'merged' }) {
    return JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        cwd,
        tool_input: { command },
        tool_response: response,
    });
}
describe('merge-lifecycle gates are registered', () => {
    it('clean-merged-branch and close-issue-on-merge are gates dist/hooks-gates.txt lists', () => {
        assert.equal(findGate('clean-merged-branch'), cleanMergedBranch);
        assert.equal(findGate('close-issue-on-merge'), closeIssueOnMerge);
        assert.ok(gateNames().includes('clean-merged-branch'));
        assert.ok(gateNames().includes('close-issue-on-merge'));
    });
});
describe('merge-lifecycle parsing', () => {
    it('readMergePayload reads the fields as jq -r does, an object response as compact JSON', () => {
        const p = readMergePayload('{"tool_name":"Bash","tool_input":{"command":"gh pr merge 1\\n"},"tool_response":{"stdout":"ok","n":1.0}}');
        assert.equal(p.toolName, 'Bash');
        assert.equal(p.command, 'gh pr merge 1');
        assert.equal(p.response, '{"stdout":"ok","n":1.0}');
        assert.equal(readMergePayload('not json').toolName, '');
    });
    it('mergeFailed spots each failure signal, case-insensitively', () => {
        for (const r of ['{"is_error":true}', '"error": x', 'Failed to merge', 'NOT MERGEABLE', 'merge conflict', 'GraphQL: nope'])
            assert.ok(mergeFailed(r), r);
        assert.ok(!mergeFailed('✓ Merged pull request #12'));
    });
    it('cmdCwd takes a leading cd (quoted, the longest reading), else git -C, else the payload cwd', () => {
        const input = JSON.stringify({ cwd: '/base/' });
        const env = { PWD: '/pwd' };
        assert.equal(cmdCwd('cd "/a b" && gh pr merge', input, env), '/a b');
        assert.equal(cmdCwd("cd 'sub dir'; x", input, env), '/base/sub dir');
        assert.equal(cmdCwd('cd "ab"x y', input, env), '/base/"ab"x');
        assert.equal(cmdCwd('echo\n  cd rel && x', input, env), '/base/rel');
        assert.equal(cmdCwd("git -C '/repo' status && gh pr merge", input, env), '/repo');
        assert.equal(cmdCwd('gh pr merge 1', input, env), '/base/');
        assert.equal(cmdCwd('gh pr merge 1', 'not json', env), '/pwd');
    });
    it('namesMerge matches gh pr merge / glab mr merge as words on one line', () => {
        assert.ok(namesMerge('x && gh  pr merge 12'));
        assert.ok(namesMerge('glab mr merge 3'));
        assert.ok(!namesMerge('gh pr merged'));
        assert.ok(!namesMerge('xgh pr merge'));
        assert.ok(!namesMerge('gh pr\nmerge'));
    });
    it('mergeArgs reads the merging statement past assignments and wrappers, never quoted or heredoc text', () => {
        assert.deepEqual(mergeArgs('A=1 sudo env gh pr merge 12 --squash; echo ok'), ['12', '--squash']);
        assert.deepEqual(mergeArgs('cd x && glab mr merge 7'), ['7']);
        assert.deepEqual(mergeArgs('gh pr merge'), []);
        assert.equal(mergeArgs('echo "gh pr merge 12"'), null);
        assert.equal(mergeArgs("cat <<'EOF'\ngh pr merge 12\nEOF"), null);
        assert.equal(mergeArgs('gh pr view 12'), null);
    });
    it('refFromArgs skips flags, flag values and redirections', () => {
        assert.equal(refFromArgs(['--squash', '-t', 'title', '-R', 'o/r', '>/dev/null', '42']), '42');
        assert.equal(refFromArgs(['', '--delete-branch']), '');
        assert.equal(refFromArgs(['feat/x', '12']), 'feat/x');
    });
    it('closingRefs unions closingIssuesReferences and body refs, sorted numerically and unique', () => {
        const json = JSON.stringify({
            closingIssuesReferences: [{ number: 20 }, { number: 3 }],
            body: 'Closes GH #3\r\nfixes #11 and Resolved #2, refs #9',
        });
        assert.deepEqual(closingRefs(json), ['2', '3', '11', '20']);
        assert.deepEqual(closingRefs(''), []);
        assert.deepEqual(closingRefs('{"closingIssuesReferences":null,"body":null}'), []);
    });
    it('closingRefs stops a value at an item jq cannot index, as jq does', () => {
        assert.deepEqual(closingRefs('{"closingIssuesReferences":[{"number":1},"x",{"number":3}]}{"closingIssuesReferences":[{"number":5}]}'), ['1', '5']);
    });
    it('syncOn honours TMB_DISABLE_REMOTE_SYNC before reading the config', () => {
        for (const off of ['1', 'true', 'yes'])
            assert.equal(syncOn('/no/such.db', { TMB_DISABLE_REMOTE_SYNC: off }), false);
        assert.equal(syncOn('/no/such.db', { TMB_DISABLE_REMOTE_SYNC: 'false' }), false);
    });
});
describe('merge-lifecycle gates over a git and DB sandbox', () => {
    let base;
    let s;
    let pristine;
    let tools;
    before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-merge-gates-')));
        s = join(base, 'sandbox');
        pristine = join(base, 'pristine');
        tools = join(base, 'tools');
        mkdirSync(tools);
        for (const cmd of ['git', 'cat', 'tr']) {
            const path = spawnSync('bash', ['-c', `command -v ${cmd}`], {
                encoding: 'utf8',
            }).stdout.trim();
            symlinkSync(path, join(tools, cmd));
        }
        buildSandbox(s);
        cpSync(s, pristine, { recursive: true, verbatimSymlinks: true });
    });
    beforeEach(() => {
        rmSync(s, { recursive: true, force: true });
        cpSync(pristine, s, { recursive: true, verbatimSymlinks: true });
    });
    after(() => rmSync(base, { recursive: true, force: true }));
    /** A PATH of the gh stub, git, cat and tr: no jq and no sqlite3 CLI. */
    const env = (extra = {}) => ({
        PATH: `${join(s, 'bin')}:${tools}`,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        CLAUDE_PROJECT_DIR: join(s, 'project'),
        TRAJECTORY_DB_PATH: join(s, PROJECT_DB),
        LC_ALL: 'C',
        ...extra,
    });
    const repo = () => join(s, 'project/repo');
    const branches = () => spawnSync('git', ['-C', repo(), 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { encoding: 'utf8' }).stdout.trim().split('\n');
    const rows = (sql) => {
        const db = new DatabaseSync(join(s, PROJECT_DB), { readOnly: true });
        try {
            return db.prepare(sql).all();
        }
        finally {
            db.close();
        }
    };
    it('branchFromCmd takes the first local branch after merge, past flags, URLs and numbers', () => {
        const e = env();
        assert.equal(branchFromCmd('gh pr merge 12 --squash https://x/y feat/open', repo(), e), 'feat/open');
        assert.equal(branchFromCmd('gh pr merge no/such-branch', repo(), e), '');
    });
    it('integrated sees ancestor and squash merges, not open work', () => {
        const e = env();
        assert.ok(integrated(repo(), 'refs/heads/feat/ancestor', 'refs/heads/dev', e));
        assert.ok(integrated(repo(), 'refs/heads/feat/squash', 'refs/heads/dev', e));
        assert.ok(!integrated(repo(), 'refs/heads/feat/open', 'refs/heads/dev', e));
        assert.equal(worktreeForBranch(repo(), 'feat/clean-wt', e), join(s, 'wt/clean'));
        assert.equal(worktreeForBranch(repo(), 'main', e), '');
    });
    it('clean-merged-branch cleans a branch merged into repos.target_branch with no jq or sqlite3 CLI (decision 703)', () => {
        let result;
        const err = stderrOf(() => {
            result = cleanMergedBranch(payload('gh pr merge feat/ancestor --squash', repo()), env());
        });
        assert.deepEqual(result, ALLOWED);
        assert.equal(err, 'tmb: cleaned up merged branch feat/ancestor\n');
        assert.ok(!branches().includes('feat/ancestor'));
    });
    it('clean-merged-branch removes a clean worktree, keeps a dirty one, and honours its bypass', () => {
        const err = stderrOf(() => {
            cleanMergedBranch(payload('gh pr merge feat/clean-wt', repo()), env());
            cleanMergedBranch(payload('gh pr merge feat/dirty-wt', repo()), env());
            cleanMergedBranch(payload('gh pr merge feat/squash', repo()), env({ TMB_DISABLE_CLEAN_MERGED_BRANCH: '1' }));
        });
        assert.match(err, /^tmb: cleaned up merged branch feat\/clean-wt \(worktree .*\/wt\/clean\)\n/);
        assert.match(err, /branch feat\/dirty-wt is merged but its worktree .*\/wt\/dirty has uncommitted\/untracked changes/);
        assert.ok(!existsSync(join(s, 'wt/clean')));
        assert.ok(existsSync(join(s, 'wt/dirty')));
        assert.ok(branches().includes('feat/squash'));
    });
    it('close-issue-on-merge records the merge with no jq or sqlite3 CLI (decision 703)', () => {
        let result;
        const err = stderrOf(() => {
            result = closeIssueOnMerge(payload('gh pr merge 42 --squash', repo()), env());
        });
        assert.deepEqual(result, ALLOWED);
        assert.equal(err, 'tmb: auto-closed issue 3 on merge\ntmb: auto-closed issue 1 on merge\n');
        const issues = rows('SELECT id, status FROM issues WHERE id IN (1, 2, 3) ORDER BY id');
        assert.deepEqual(issues.map((r) => `${r.id}:${r.status}`), ['1:closed', '2:open', '3:closed']);
        const bypassed = rows("SELECT content_json FROM audit WHERE event_type = 'review_gate_bypassed' AND summary LIKE 'Task % merged without a passing review' ORDER BY id");
        assert.deepEqual(bypassed.map((r) => r.content_json), [
            '{"task_id":30,"commit_sha":"abc1234","closed_by":"close-issue-on-merge"}',
            '{"task_id":32,"commit_sha":null,"closed_by":"close-issue-on-merge"}',
            '{"task_id":35,"commit_sha":null,"closed_by":"close-issue-on-merge"}',
        ]);
        const deferred = rows("SELECT summary FROM audit WHERE event_type = 'issue_auto_close_deferred'");
        assert.deepEqual(deferred.map((r) => r.summary), ['Merge left issue 2 open: tasks 34 still live']);
        assert.equal(rows("SELECT COUNT(*) AS n FROM tasks WHERE branch_id = 'feat/close' AND status <> 'closed'")[0].n, 0);
        assert.equal(rows('SELECT exit_reason FROM agent_runs WHERE task_id = 32')[0].exit_reason, 'completed');
        assert.match(readFileSync(join(s, 'gh.log'), 'utf8'), /^issue close 101$/m);
    });
    it('close-issue-on-merge writes remote_skipped with sync off and nothing on its bypass', () => {
        stderrOf(() => {
            closeIssueOnMerge(payload('gh pr merge 46', repo()), env({ TMB_DISABLE_REMOTE_SYNC: '1' }));
            closeIssueOnMerge(payload('gh pr merge 48', repo()), env({ TMB_DISABLE_CLOSE_ISSUE_ON_MERGE: '1' }));
        });
        const skipped = rows("SELECT content_json FROM audit WHERE event_type = 'issue_auto_close_remote_skipped'");
        assert.deepEqual(skipped.map((r) => r.content_json), ['{"gh_iid":106,"reason":"sync_gate_off"}']);
        assert.equal(rows('SELECT status FROM issues WHERE id = 7')[0].status, 'open');
        assert.doesNotMatch(readFileSync(join(s, 'gh.log'), 'utf8'), /issue close/);
    });
});
//# sourceMappingURL=hooks-merge-lifecycle.test.js.map