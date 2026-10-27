/**
 * Unit tests of the TypeScript git branch guards (GH 1692): stay-on-base-guard,
 * branch-up-to-date-with-remote, no-worktree-branch-create and
 * no-remote-auth-guard. They cover registration, the shared read-loop helpers,
 * the remotes check, and the divergences from the .sh that decisions 703 and
 * 369 allow: each gate runs on a PATH holding git but neither jq nor the
 * sqlite3 CLI, where each .sh allows, and a command tree-sitter-bash cannot
 * parse is denied with git-guards' PARSE_REASON once the DB resolves.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PARSE_REASON } from '../hooks/git-guards.js';
import { findGate, gateNames } from '../hooks/registry.js';
import { commandOnPath } from '../hooks/lib/persona.js';
import { payloadCwdOf, readTabFields, statementRows } from '../hooks/lib/statement-rows.js';
import { jqInput } from '../hooks/lib/jq-raw.js';
import { stayOnBaseGuard } from '../hooks/stay-on-base-guard.js';
import { branchUpToDateWithRemote } from '../hooks/branch-up-to-date-with-remote.js';
import { noWorktreeBranchCreate } from '../hooks/no-worktree-branch-create.js';
import { hasRemoteUrl, noRemoteAuthGuard } from '../hooks/no-remote-auth-guard.js';
import { buildSandbox } from './hooks-git-branch-guards-parity.suite.js';
const GATES = {
    'stay-on-base-guard': stayOnBaseGuard,
    'branch-up-to-date-with-remote': branchUpToDateWithRemote,
    'no-worktree-branch-create': noWorktreeBranchCreate,
    'no-remote-auth-guard': noRemoteAuthGuard,
};
function reason(r) {
    assert.equal(r.code, 0);
    assert.ok(r.stdout.endsWith('\n'));
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
}
describe('git branch guards are registered', () => {
    for (const [name, gate] of Object.entries(GATES)) {
        it(`${name} is a gate dist/hooks-gates.txt lists`, () => {
            assert.equal(findGate(name), gate);
            assert.ok(gateNames().includes(name));
        });
    }
});
describe('git branch guard helpers', () => {
    it("readTabFields reads as `IFS=$'\\t' read -r`: tab runs split, the last field keeps the rest", () => {
        assert.deepEqual(readTabFields('\t\ta\t\tb\tc\t', 3), ['a', 'b', 'c']);
        assert.deepEqual(readTabFields('a\tb\tc', 2), ['a', 'b\tc']);
        assert.deepEqual(readTabFields('a', 3), ['a', '', '']);
    });
    it('statementRows re-reads the dir/stmt lines the .sh loop sees', () => {
        assert.deepEqual(statementRows([]), []);
        assert.deepEqual(statementRows([
            { dir: '/x', stmt: 'git checkout a' },
            { dir: '?', stmt: '' },
        ]), [
            { dir: '/x', stmt: 'git checkout a' },
            { dir: '?', stmt: '' },
        ]);
        assert.deepEqual(statementRows([{ dir: '/x', stmt: 'echo "a\nb"' }]), [
            { dir: '/x', stmt: 'echo "a' },
            { dir: 'b"', stmt: '' },
        ]);
    });
    it('payloadCwdOf takes .cwd // empty, minus trailing newlines', () => {
        assert.equal(payloadCwdOf(jqInput('{"cwd":"/a\\n"}'), {}), '/a');
    });
    it('hasRemoteUrl prints what the .sh jq filter prints', () => {
        assert.equal(hasRemoteUrl('[]'), 'false');
        assert.equal(hasRemoteUrl('[{"name":"origin","url":""}]'), 'false');
        assert.equal(hasRemoteUrl('[{"url":null},{"url":"https://x"}]'), 'true');
        assert.equal(hasRemoteUrl('[null]'), 'false');
        assert.equal(hasRemoteUrl('[1]'), '');
        assert.equal(hasRemoteUrl('not json'), '');
    });
});
describe('git branch guards without jq or the sqlite3 CLI (decision 703), and on a parse failure (decision 369)', () => {
    let base;
    let s;
    let bin;
    before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-git-branch-guards-')));
        s = join(base, 'sandbox');
        mkdirSync(s);
        buildSandbox(s);
        bin = join(base, 'bin');
        mkdirSync(bin);
        const git = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
        symlinkSync(git, join(bin, 'git'));
    });
    after(() => rmSync(base, { recursive: true, force: true }));
    const env = (extra = {}) => ({
        HOME: join(s, 'home'),
        CLAUDE_PROJECT_DIR: join(s, 'project'),
        TRAJECTORY_DB_PATH: join(s, 'trajectory.db'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        PATH: bin,
        LC_ALL: 'C',
        ...extra,
    });
    const noDb = () => {
        const e = env({ CLAUDE_PROJECT_DIR: join(s, 'nodb') });
        delete e.TRAJECTORY_DB_PATH;
        return e;
    };
    const bash = (command, cwd) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: join(s, cwd) });
    it('the PATH under test holds git but neither jq nor sqlite3', () => {
        assert.equal(commandOnPath('git', env()), true);
        assert.equal(commandOnPath('jq', env()), false);
        assert.equal(commandOnPath('sqlite3', env()), false);
    });
    it('stay-on-base-guard denies a checkout of an open task branch', async () => {
        assert.ok(reason(await stayOnBaseGuard(bash('git checkout feat/open', 'base'), env())).includes("Branch 'feat/open' belongs to open task #30."));
    });
    it('branch-up-to-date-with-remote denies attaching a branch behind origin', async () => {
        assert.ok(reason(await branchUpToDateWithRemote(bash('git worktree add ../wt feat/behind', 'stale'), env())).startsWith("BLOCKED: branch 'feat/behind' is behind origin/main by 1 commit(s)."));
    });
    it('no-worktree-branch-create denies -b', async () => {
        assert.ok(reason(await noWorktreeBranchCreate(bash('git worktree add -b feat/x ../x', 'project'), env())).includes('cannot create a branch'));
    });
    it('no-remote-auth-guard denies gh auth login with no remote URL', async () => {
        assert.ok(reason(await noRemoteAuthGuard(bash('gh auth login', 'stale'), env())).includes("Interactive 'gh auth login' will hang"));
    });
    const unparsable = [
        ['stay-on-base-guard', 'git checkout feat/open && (', 'base'],
        ['branch-up-to-date-with-remote', 'git worktree add ../wt feat/behind && (', 'stale'],
        ['no-worktree-branch-create', 'git worktree add ../x feat/x && (', 'project'],
        ['no-remote-auth-guard', 'gh auth login && (', 'stale'],
    ];
    for (const [name, command, cwd] of unparsable) {
        it(`${name} denies a command it cannot parse with PARSE_REASON once the DB resolves, and allows it with no DB`, async () => {
            assert.equal(reason(await GATES[name](bash(command, cwd), env())), PARSE_REASON);
            assert.deepEqual(await GATES[name](bash(command, cwd), noDb()), { stdout: '', code: 0 });
        });
    }
});
//# sourceMappingURL=hooks-git-branch-guards.test.js.map