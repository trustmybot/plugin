/**
 * Unit tests of the TypeScript merge-lifecycle gates (GH 1692):
 * clean-merged-branch and close-issue-on-merge. They cover the command, ref
 * and closing-ref parsing the parity corpus leans on, and the divergences from
 * the .sh that decision 703 allows: on a PATH holding neither jq nor the
 * sqlite3 CLI, where each .sh exits 0 untouched (and clean-merged-branch.sh
 * falls back to the default branch), both gates still act; and on a PATH with
 * no `timeout`, where close-issue-on-merge.sh waits out a hanging gh, the TS
 * gate kills it at 10 s.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attributionFooter } from '../hooks/attribution-footer.js';
import { findGate, gateNames } from '../hooks/registry.js';
import { branchFromCmd, cleanMergedBranch, integrated, namesMerge, worktreeForBranch } from '../hooks/clean-merged-branch.js';
import { closeIssueOnMerge, closingRefs, mergeArgs, refFromArgs, syncOn } from '../hooks/close-issue-on-merge.js';
import { mergeFailed, readMergePayload } from '../hooks/lib/merge.js';
import { cmdCwd } from '../hooks/lib/repo.js';
import { buildSandbox } from './hooks-merge-lifecycle-parity.suite.js';
const ALLOWED = { stdout: '', code: 0 };
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
/** Runs <fn> with process.stderr.write captured, returning what it wrote. */
async function stderrOf(fn) {
    const original = process.stderr.write.bind(process.stderr);
    let out = '';
    process.stderr.write = ((chunk) => {
        out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    });
    try {
        await fn();
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
        rmSync(s, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    it('branchFromCmd takes the first local branch after merge, past flags, URLs and numbers', async () => {
        const e = env();
        assert.equal(await branchFromCmd('gh pr merge 12 --squash https://x/y feat/open', repo(), e), 'feat/open');
        assert.equal(await branchFromCmd('gh pr merge no/such-branch', repo(), e), '');
    });
    it('integrated sees ancestor and squash merges, not open work', async () => {
        const e = env();
        assert.ok(await integrated(repo(), 'refs/heads/feat/ancestor', 'refs/heads/dev', e));
        assert.ok(await integrated(repo(), 'refs/heads/feat/squash', 'refs/heads/dev', e));
        assert.ok(!await integrated(repo(), 'refs/heads/feat/open', 'refs/heads/dev', e));
        assert.equal(await worktreeForBranch(repo(), 'feat/clean-wt', e), join(s, 'wt/clean'));
        assert.equal(await worktreeForBranch(repo(), 'main', e), '');
    });
    it('clean-merged-branch cleans a branch merged into repos.target_branch with no jq or sqlite3 CLI (decision 703)', async () => {
        let result;
        const err = await stderrOf(async () => {
            result = await cleanMergedBranch(payload('gh pr merge feat/ancestor --squash', repo()), env());
        });
        assert.deepEqual(result, ALLOWED);
        assert.equal(err, 'tmb: cleaned up merged branch feat/ancestor\n');
        assert.ok(!branches().includes('feat/ancestor'));
    });
    it('clean-merged-branch removes a clean worktree, keeps a dirty one, and honours its bypass', async () => {
        const err = await stderrOf(async () => {
            await cleanMergedBranch(payload('gh pr merge feat/clean-wt', repo()), env());
            await cleanMergedBranch(payload('gh pr merge feat/dirty-wt', repo()), env());
            await cleanMergedBranch(payload('gh pr merge feat/squash', repo()), env({ TMB_DISABLE_CLEAN_MERGED_BRANCH: '1' }));
        });
        assert.match(err, /^tmb: cleaned up merged branch feat\/clean-wt \(worktree .*\/wt\/clean\)\n/);
        assert.match(err, /branch feat\/dirty-wt is merged but its worktree .*\/wt\/dirty has uncommitted\/untracked changes/);
        assert.ok(!existsSync(join(s, 'wt/clean')));
        assert.ok(existsSync(join(s, 'wt/dirty')));
        assert.ok(branches().includes('feat/squash'));
    });
    it('close-issue-on-merge records the merge with no jq or sqlite3 CLI (decision 703)', async () => {
        let result;
        const err = await stderrOf(async () => {
            result = await closeIssueOnMerge(payload('gh pr merge 42 --squash', repo()), env());
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
    it('close-issue-on-merge writes remote_skipped with sync off and nothing on its bypass', async () => {
        await stderrOf(async () => {
            await closeIssueOnMerge(payload('gh pr merge 46', repo()), env({ TMB_DISABLE_REMOTE_SYNC: '1' }));
            await closeIssueOnMerge(payload('gh pr merge 48', repo()), env({ TMB_DISABLE_CLOSE_ISSUE_ON_MERGE: '1' }));
        });
        const skipped = rows("SELECT content_json FROM audit WHERE event_type = 'issue_auto_close_remote_skipped'");
        assert.deepEqual(skipped.map((r) => r.content_json), ['{"gh_iid":106,"reason":"sync_gate_off"}']);
        assert.equal(rows('SELECT status FROM issues WHERE id = 7')[0].status, 'open');
        assert.doesNotMatch(readFileSync(join(s, 'gh.log'), 'utf8'), /issue close/);
    });
    it('close-issue-on-merge runs gh in the checkout the merge ran in, the main one once its worktree is gone, not the hook process cwd (GH 2134)', async () => {
        const pwds = join(s, 'gh-pwd.log');
        writeFileSync(join(s, 'bin/gh'), `#!/bin/bash\npwd -P >> '${pwds}'\n`);
        chmodSync(join(s, 'bin/gh'), 0o755);
        const expected = realpathSync(repo());
        assert.notEqual(realpathSync(process.cwd()), expected);
        await closeIssueOnMerge(payload(`cd '${repo()}' && gh pr merge 46 --squash`, tmpdir()), env());
        await closeIssueOnMerge(payload(`cd '${join(s, 'wt/clean')}' && gh pr merge 46 --squash`, tmpdir()), env());
        await closeIssueOnMerge(payload(`cd '${join(repo(), '.claude/worktrees/removed')}' && gh pr merge 46 --squash`, tmpdir()), env());
        assert.deepEqual(readFileSync(pwds, 'utf8').trim().split('\n'), [expected, realpathSync(join(s, 'wt/clean')), expected]);
    });
    it('close-issue-on-merge runs gh in the payload cwd, not a git -C target, and reads a no-arg ref there too (F292-2)', async () => {
        const pwds = join(s, 'gh-pwd.log');
        writeFileSync(join(s, 'bin/gh'), `#!/bin/bash\npwd -P >> '${pwds}'\necho "$*" >> '${pwds}.args'\n`);
        chmodSync(join(s, 'bin/gh'), 0o755);
        const here = realpathSync(repo());
        const other = join(s, 'git-c-other');
        spawnSync('git', ['init', '-q', '-b', 'other-branch', other]);
        spawnSync('git', ['-C', other, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'i']);
        await closeIssueOnMerge(payload(`git -C ${other} fetch && gh pr merge 46 --squash`, here), env());
        assert.equal(readFileSync(pwds, 'utf8').trim().split('\n')[0], here);
        await closeIssueOnMerge(payload(`git -C ${other} fetch && gh pr merge --squash`, here), env());
        assert.doesNotMatch(readFileSync(`${pwds}.args`, 'utf8'), /other-branch/);
    });
    it('close-issue-on-merge runs gh in a submodule whose origin is its own remote, not the superproject (F292-3)', async () => {
        const pwds = join(s, 'gh-pwd.log');
        writeFileSync(join(s, 'bin/gh'), `#!/bin/bash\npwd -P >> '${pwds}'\n`);
        chmodSync(join(s, 'bin/gh'), 0o755);
        const upstream = realpathSync(s) + '/sub-upstream';
        const superproject = realpathSync(s) + '/superproject';
        const identity = ['-c', 'protocol.file.allow=always', '-c', 'user.name=x', '-c', 'user.email=x@x'];
        const git = (...args) => assert.equal(spawnSync('git', args, { stdio: 'ignore' }).status, 0, args.join(' '));
        git('init', '-q', upstream);
        git('-C', upstream, ...identity, 'commit', '-q', '--allow-empty', '-m', 'i');
        git('init', '-q', superproject);
        git('-C', superproject, 'remote', 'add', 'origin', 'https://github.com/o/super.git');
        git('-C', superproject, ...identity, 'submodule', 'add', '-q', upstream, 'sub');
        await closeIssueOnMerge(payload(`cd '${join(superproject, 'sub')}' && gh pr merge 46 --squash`, tmpdir()), env());
        const first = readFileSync(pwds, 'utf8').trim().split('\n')[0];
        assert.equal(spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: first, encoding: 'utf8' }).stdout.trim(), upstream);
    });
    it('a cd that did not run before gh chooses no directory for the footer or the merge (F292-4)', async () => {
        const pwds = join(s, 'gh-pwd.log');
        writeFileSync(join(s, 'bin/gh'), `#!/bin/bash\npwd -P >> '${pwds}'\nif [ "$2" = view ]; then echo Body; fi\n`);
        chmodSync(join(s, 'bin/gh'), 0o755);
        const a = join(realpathSync(s), 'probe-a');
        const b = join(realpathSync(s), 'probe-b');
        mkdirSync(a);
        mkdirSync(b);
        const url = 'https://github.com/o/a/pull/9';
        const readPwds = () => {
            const lines = readFileSync(pwds, 'utf8').trim().split('\n');
            writeFileSync(pwds, '');
            return lines;
        };
        const footer = (command) => attributionFooter(JSON.stringify({ tool_name: 'Bash', cwd: a, tool_input: { command }, tool_response: url }), env());
        footer(`gh pr create --title t --body "$(cat <<X\nTest plan:\ncd ${b}\nnpm test\nX\n)"`);
        assert.deepEqual(readPwds(), [a, a], 'footer: heredoc body');
        footer(`gh pr create --fill\ncd ${b} && git status`);
        assert.deepEqual(readPwds(), [a, a], 'footer: cd after gh');
        await closeIssueOnMerge(payload(`gh pr merge 46 --squash\ncd ${b} && git pull`, a), env());
        assert.equal(readPwds()[0], a, 'merge: cd after gh');
        await closeIssueOnMerge(payload(`gh pr merge 46 --squash --body "$(cat <<X\ncd ${b}\nX\n)"`, a), env());
        assert.equal(readPwds()[0], a, 'merge: heredoc body');
    });
    it('close-issue-on-merge reads a cd leading the first non-blank line, and only that line (F292-4)', async () => {
        const pwds = join(s, 'gh-pwd.log');
        writeFileSync(join(s, 'bin/gh'), `#!/bin/bash\npwd -P >> '${pwds}'\n`);
        chmodSync(join(s, 'bin/gh'), 0o755);
        const a = join(realpathSync(s), 'lead-a');
        const b = join(realpathSync(s), 'lead-b');
        mkdirSync(a);
        mkdirSync(b);
        const first = async (command) => {
            writeFileSync(pwds, '');
            await closeIssueOnMerge(payload(command, a), env());
            return readFileSync(pwds, 'utf8').trim().split('\n')[0];
        };
        assert.equal(await first(`\n  \ncd ${b} && gh pr merge 46 --squash`), b);
        assert.equal(await first(`echo start\ncd ${b}\ngh pr merge 46 --squash`), a);
        assert.equal(await first(`echo "cd ${b}" && gh pr merge 46 --squash`), a);
    });
    it('close-issue-on-merge kills a hanging gh at its 10 s bound with no timeout on PATH and exits 0 (decision 703)', async () => {
        const sleep = spawnSync('bash', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();
        const pidFile = join(s, 'gh.pid');
        writeFileSync(join(s, 'bin/gh'), `#!/bin/bash\necho $$ > '${pidFile}'\nexec '${sleep}' 600\n`);
        chmodSync(join(s, 'bin/gh'), 0o755);
        const e = env();
        assert.ok((e.PATH ?? '').split(':').every((dir) => !existsSync(join(dir, 'timeout'))), 'no timeout on PATH');
        let result;
        const err = await stderrOf(async () => {
            result = await closeIssueOnMerge(payload('gh pr merge 46 --squash', repo()), e);
        });
        assert.deepEqual(result, ALLOWED);
        assert.equal(err, '');
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        assert.ok(pid > 0);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the hung gh is gone once the gate returns');
        assert.equal(rows('SELECT status FROM issues WHERE id = 6')[0].status, 'open');
    });
});
//# sourceMappingURL=hooks-merge-lifecycle.test.js.map