/**
 * Byte-for-byte parity of the TypeScript git-push-guard with
 * scripts/hooks/git-push-guard.sh (GH 1692) over
 * tests/fixtures/hook-corpus/git-push-guard/, in a sandbox of real git repos
 * and a trajectory DB: signed, unsigned and untracked commits, rebases of
 * task commits with and without a verification run, a rebase with
 * regenerated dist, a dist-only rebase, first pushes with no upstream and a
 * checkout with linked worktrees. Each payload's `@SANDBOX@` is the sandbox
 * dir, its `corpus_env` (removed before the run) overrides the env, and its
 * `corpus_expect` (removed too) is `allow` or a phrase of the deny reason.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus/git-push-guard');
const HOOK_SH = join(PLUGIN_ROOT, 'scripts/hooks/git-push-guard.sh');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 30;
const DIST = 'mcp/trajectory-server/dist/index.js';
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
};
function git(dir, ...args) {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
    return r.stdout.trim();
}
function commit(dir, files, msg) {
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', msg);
    return git(dir, 'rev-parse', 'HEAD');
}
/** A checkout on main whose first commit is pushed to its own bare origin. */
function repo(sandbox, name) {
    const dir = join(sandbox, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(sandbox, 'init', '-q', '--bare', `${name}.git`);
    git(dir, 'remote', 'add', 'origin', join(sandbox, `${name}.git`));
    commit(dir, { 'README.md': `${name}\n` }, 'init');
    git(dir, 'push', '-qu', 'origin', 'main');
    return dir;
}
/**
 * A task commit T on a side branch and its rebase R onto a newer pushed
 * main, R left unpushed; with `regenerate`, R's version of those files
 * differs from T's (a rebuilt dist).
 */
function rebased(sandbox, name, files, regenerate = {}) {
    const dir = repo(sandbox, name);
    git(dir, 'checkout', '-q', '-b', 'side');
    const task = commit(dir, files, `task work in ${name}`);
    git(dir, 'checkout', '-q', 'main');
    commit(dir, { 'other.txt': `${name} moved on\n` }, 'main moves on');
    git(dir, 'push', '-q', 'origin', 'main');
    git(dir, 'cherry-pick', task);
    if (Object.keys(regenerate).length > 0) {
        for (const [path, text] of Object.entries(regenerate))
            writeFileSync(join(dir, path), text);
        git(dir, 'commit', '-q', '-a', '--amend', '--no-edit');
    }
    return { task, rebase: git(dir, 'rev-parse', 'HEAD') };
}
function buildSandbox(sandbox) {
    mkdirSync(join(sandbox, 'project'));
    mkdirSync(join(sandbox, 'db'));
    writeFileSync(join(sandbox, 'bad.db'), 'this is not a sqlite database\n'.repeat(64));
    const signed = repo(sandbox, 'signed');
    const signedSha = commit(signed, { 'a.txt': 'signed work\n' }, 'feat: signed');
    const unsigned = repo(sandbox, 'unsigned');
    const unsignedA = commit(unsigned, { 'a.txt': 'unsigned A\n' }, 'feat: unsigned A');
    const unsignedB = commit(unsigned, { 'b.txt': 'unsigned B\n' }, 'feat: unsigned B');
    commit(repo(sandbox, 'untracked'), { 'a.txt': 'untracked\n' }, 'chore: untracked');
    const reb = rebased(sandbox, 'rebased', { 'r.txt': 'rebased work\n' });
    const rebOk = rebased(sandbox, 'rebased-ok', { 'r.txt': 'rebased-ok work\n' });
    const rebNo = rebased(sandbox, 'rebased-unreviewed', { 'r.txt': 'rebased-unreviewed work\n' });
    const dist = rebased(sandbox, 'dist', { 'src/a.ts': 'export const a = 1;\n', [DIST]: 'dist A\n' }, { [DIST]: 'dist B\n' });
    const distOnly = rebased(sandbox, 'dist-only', { [DIST]: 'dist only A\n' }, { [DIST]: 'dist only B\n' });
    const fp = repo(sandbox, 'first-push');
    git(fp, 'checkout', '-q', '-b', 'dev');
    const fpDev = commit(fp, { 'd.txt': 'dev only\n' }, 'feat: on dev');
    git(fp, 'push', '-q', 'origin', 'dev');
    git(fp, 'checkout', '-q', '-b', 'feat/fp');
    const fpFeat = commit(fp, { 'f.txt': 'feature\n' }, 'feat: feature');
    const fpd = repo(sandbox, 'first-push-default');
    git(fpd, 'checkout', '-q', '-b', 'feat/fpd');
    const fpdFeat = commit(fpd, { 'f.txt': 'feature default\n' }, 'feat: feature default');
    const multi = join(sandbox, 'multi');
    mkdirSync(multi);
    git(multi, 'init', '-q', '-b', 'main');
    commit(multi, { 'README.md': 'multi\n' }, 'init');
    git(multi, 'worktree', 'add', '-q', '-b', 'wt', join(sandbox, 'multi-wt'));
    const db = new DatabaseSync(join(sandbox, 'db/trajectory.db'));
    try {
        db.exec(SCHEMA);
        db.exec("INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'))");
        const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at) VALUES (?, 1, ?, ?, 'd', 'closed', '## body', ?, datetime('now'), datetime('now'))");
        const sign = db.prepare("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at) VALUES (?, 1, 'code-reviewer', 'pass', 1, 'LGTM', datetime('now'))");
        const rows = [
            [1, 'signed work', signedSha, true],
            [2, 'fix "quoted" title with ü', unsignedA, false],
            [3, 'a title | with a bar', unsignedB, false],
            [4, 'rebased work', reb.task, true],
            [5, 'rebased-ok work', rebOk.task, true],
            [6, 'rebased-unreviewed work', rebNo.task, false],
            [7, 'dev only', fpDev, false],
            [8, 'feature', fpFeat, true],
            [9, 'feature default', fpdFeat, false],
            [10, 'dist rebuilt', dist.task, true],
            [11, 'dist only', distOnly.task, true],
        ];
        for (const [id, title, sha, passed] of rows) {
            task.run(id, `feat/t-${id}`, title, sha);
            if (passed)
                sign.run(id);
        }
        db.prepare("INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (5, ?, 'gate', datetime('now'), datetime('now'), 0, 60, 0)").run(rebOk.rebase);
        db.prepare("INSERT INTO repos (name, path, target_branch) VALUES ('fp', ?, 'dev'), ('signed', ?, 'main')").run(fp, signed);
    }
    finally {
        db.close();
    }
}
function materialize(file, sandbox) {
    const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', sandbox);
    const { corpus_env: env = {}, corpus_expect: expect = '', ...payload } = JSON.parse(text);
    return { input: JSON.stringify(payload), env, expect };
}
function run(cmd, args, input, env, cwd) {
    const r = spawnSync(cmd, args, { input, env, cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error)
        throw r.error;
    return { code: r.status, stdout: r.stdout };
}
const corpus = readdirSync(CORPUS)
    .filter((f) => f.endsWith('.json'))
    .sort();
describe('git-push-guard parity: bash vs node over a git and DB sandbox', { skip: !HAVE_SQLITE_CLI && 'the .sh needs the sqlite3 CLI' }, () => {
    let sandbox;
    before(() => {
        sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gpg-parity-')));
        buildSandbox(sandbox);
    });
    after(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });
    it(`the corpus holds at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
        assert.ok(corpus.length >= MIN_CORPUS, `${corpus.length} payloads`);
        for (const f of corpus)
            assert.notEqual(materialize(join(CORPUS, f), '/s').expect, '', f);
    });
    for (const f of corpus) {
        for (const locale of LOCALES) {
            it(`${f} (LC_ALL=${locale})`, () => {
                const { input, env: extra, expect } = materialize(join(CORPUS, f), sandbox);
                const env = {
                    ...process.env,
                    CLAUDE_PROJECT_DIR: join(sandbox, 'project'),
                    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
                    TRAJECTORY_DB_PATH: join(sandbox, 'db/trajectory.db'),
                    LC_ALL: locale,
                    ...extra,
                };
                delete env.TMB_HOOKS_SQLITE;
                const cwd = join(sandbox, 'project');
                const bash = run('bash', [HOOK_SH], input, env, cwd);
                const node = run(process.execPath, [HOOKS_BUNDLE, 'git-push-guard'], input, env, cwd);
                assert.equal(node.code, bash.code, 'exit code');
                assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                assert.equal(bash.code, 0);
                if (expect === 'allow') {
                    assert.equal(bash.stdout, '', 'allowed');
                }
                else {
                    const out = JSON.parse(bash.stdout);
                    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
                    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(expect), out.hookSpecificOutput.permissionDecisionReason);
                }
            });
        }
    }
});
//# sourceMappingURL=hooks-git-push-guard-parity.test.js.map