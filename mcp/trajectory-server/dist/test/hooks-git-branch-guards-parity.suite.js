/**
 * Parity of the TypeScript git branch guards with their scripts/hooks/<gate>.sh
 * (GH 1692): stay-on-base-guard, branch-up-to-date-with-remote,
 * no-worktree-branch-create and no-remote-auth-guard, over
 * tests/fixtures/hook-corpus/<gate>/, in a sandbox of real git repos, local
 * bare origins (no network) and a trajectory DB.
 *
 * The repos: base (tasks 30 feat/open running and 31 feat/closed closed, a
 * remotes row with a URL), multi (a linked worktree, task 32 feat/multi-open),
 * stale (no target_branch, feat/behind one commit behind its origin's main,
 * feat/fresh level with it, no remotes rows), devtgt (target dev, which its
 * origin lacks), norem (no origin, a remotes row with an empty URL) and unreg
 * (no repos row). Task 33 feat/norepo has no repo, so its worktree falls back
 * to the checkout's. Beside them: a corrupt DB and a project with none.
 *
 * A payload names the sandbox as @SANDBOX@ and the PATH without jq or without
 * the sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@; corpus_env (null unsets),
 * corpus_cwd (under the sandbox, default base), corpus_stdin (the raw stdin)
 * and corpus_expect (`empty` for no stdout, else a phrase of the deny reason)
 * are removed before the run. A payload with corpus_divergent names a
 * divergence decision 703 allows: corpus_expect is then { bash, ts } and the
 * sides' stdout must differ. The payload × locale (C, en_US.UTF-8) runs split
 * across hooks-git-branch-guards-parity.shard-<k>of<n>.test.ts, each shard
 * with its own sandbox; shard 1 also runs the whole-corpus check.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { shardOf } from './shard.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 8;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
export const GIT_BRANCH_GATES = ['branch-up-to-date-with-remote', 'no-remote-auth-guard', 'no-worktree-branch-create', 'stay-on-base-guard'];
const UNSET = ['TRAJECTORY_DB_PATH', 'TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'TMB_HOOKS_SQLITE', 'TMB_DB_WRITE_TIMEOUT_MS', 'LANG', 'LC_CTYPE'];
const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
};
function git(dir, ...args) {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
    return r.stdout.trim();
}
function commit(dir, name) {
    writeFileSync(join(dir, name), `${name}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', `add ${name}`);
}
/** A checkout on main with no remote. */
function local(s, name) {
    const dir = join(s, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'README.md');
    return dir;
}
/** A checkout on main pushed to its own bare origin. */
function repo(s, name) {
    const dir = local(s, name);
    git(s, 'init', '-q', '--bare', `${name}.git`);
    git(dir, 'remote', 'add', 'origin', join(s, `${name}.git`));
    git(dir, 'push', '-qu', 'origin', 'main');
    return dir;
}
export function buildSandbox(s) {
    mkdirSync(join(s, 'home'));
    mkdirSync(join(s, 'project'));
    mkdirSync(join(s, 'nodb'));
    writeFileSync(join(s, 'bad.db'), 'this is not a sqlite database\n'.repeat(64));
    const base = repo(s, 'base');
    for (const b of ['feat/open', 'feat/closed', 'feat/norepo'])
        git(base, 'branch', b);
    const multi = repo(s, 'multi');
    git(multi, 'worktree', 'add', '-q', '-b', 'feat/wt', join(multi, '.claude/worktrees/wt'));
    const stale = repo(s, 'stale');
    const first = git(stale, 'rev-parse', 'HEAD');
    git(s, 'clone', '-q', '-b', 'main', join(s, 'stale.git'), 'stale-other');
    commit(join(s, 'stale-other'), 'two.txt');
    git(join(s, 'stale-other'), 'push', '-q', 'origin', 'main');
    git(stale, 'fetch', '-q', 'origin');
    git(stale, 'branch', 'feat/fresh', 'origin/main');
    git(stale, 'branch', 'feat/behind', first);
    git(stale, 'update-ref', 'refs/remotes/origin/main', first);
    const devtgt = repo(s, 'devtgt');
    git(devtgt, 'branch', 'feat/d');
    const norem = local(s, 'norem');
    git(norem, 'branch', 'feat/n');
    const unreg = repo(s, 'unreg');
    git(unreg, 'branch', 'feat/u');
    const db = new DatabaseSync(join(s, 'trajectory.db'));
    try {
        db.exec(SCHEMA);
        const row = db.prepare('INSERT INTO repos (name, path, target_branch) VALUES (?, ?, ?)');
        row.run('base', base, 'main');
        row.run('multi', multi, 'main');
        row.run('stale', stale, null);
        row.run('devtgt', devtgt, 'dev');
        row.run('norem', norem, 'main');
        const remote = db.prepare("INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES (?, 'origin', ?, ?, 1)");
        remote.run('base', 'github', 'https://github.com/example/base.git');
        remote.run('norem', 'gitlab', '');
        db.exec("INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'))");
        const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, created_at, updated_at) VALUES (?, 1, ?, 'd', ?, ?, datetime('now'), datetime('now'))");
        task.run(30, 'feat/open', 'running', 'base');
        task.run(31, 'feat/closed', 'closed', 'base');
        task.run(32, 'feat/multi-open', 'pending', 'multi');
        task.run(33, 'feat/norepo', 'needs_validation', null);
    }
    finally {
        db.close();
    }
}
/** PATH with <cmd> gone: each dir holding it replaced by a dir of links to everything else. */
function noCmdPath(dir, cmd, path) {
    let n = 0;
    return path
        .split(':')
        .filter((d) => d !== '')
        .map((d) => {
        if (!existsSync(join(d, cmd)))
            return d;
        n += 1;
        const shadow = join(dir, String(n));
        mkdirSync(shadow, { recursive: true });
        let names = [];
        try {
            names = readdirSync(d);
        }
        catch {
            /* unreadable dir: empty shadow */
        }
        for (const name of names)
            if (name !== cmd)
                symlinkSync(join(d, name), join(shadow, name));
        return shadow;
    })
        .join(':');
}
export function materialize(file, s, paths) {
    const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', s).replaceAll('@NOJQ_PATH@', paths.noJq).replaceAll('@NOSQLITE_PATH@', paths.noSqlite);
    const { corpus_env: env = {}, corpus_cwd: cwd = 'base', corpus_stdin: stdin, corpus_expect: expect = '', corpus_divergent: divergent, ...payload } = JSON.parse(text);
    return { input: Buffer.from(stdin ?? JSON.stringify(payload)), env, cwd: join(s, cwd), expect, divergent };
}
function caseEnv(s, locale, extra, cwd) {
    const env = { ...process.env, ...GIT_ENV };
    for (const key of UNSET)
        delete env[key];
    Object.assign(env, {
        HOME: join(s, 'home'),
        CLAUDE_PROJECT_DIR: join(s, 'project'),
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        TRAJECTORY_DB_PATH: join(s, 'trajectory.db'),
        LC_ALL: locale,
        PWD: cwd,
    });
    for (const [key, value] of Object.entries(extra)) {
        if (value === null)
            delete env[key];
        else
            env[key] = value;
    }
    return env;
}
/** stdin comes from a file, not a pipe: a .sh that exits before reading it would make a piped write fail with EPIPE. */
function run(cmd, args, c, stdinFile, env) {
    writeFileSync(stdinFile, c.input);
    const fd = openSync(stdinFile, 'r');
    try {
        const r = spawnSync(cmd, args, { stdio: [fd, 'pipe', 'pipe'], env, cwd: c.cwd, encoding: 'utf8', timeout: 30_000 });
        if (r.error)
            throw r.error;
        return { code: r.status, stdout: r.stdout };
    }
    finally {
        closeSync(fd);
    }
}
/** `empty`: no stdout; anything else: a deny whose reason holds the phrase. */
function assertExpect(side, r, expect) {
    if (expect === 'empty') {
        assert.equal(r.stdout, '', `${side}: no output`);
        return;
    }
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', side);
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(expect), `${side}: ${out.hookSpecificOutput.permissionDecisionReason}`);
}
export function corpusFiles(gate) {
    const dir = join(CORPUS_ROOT, gate);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}
const cases = GIT_BRANCH_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));
export function gitBranchGuardsParityShard(k, n) {
    describe(`git branch guards parity: bash vs node over a git and DB sandbox (shard ${k} of ${n})`, { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' }, () => {
        let base;
        let s;
        let paths;
        before(() => {
            base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-git-branch-parity-')));
            s = join(base, 'sandbox');
            mkdirSync(s);
            buildSandbox(s);
            const path = process.env.PATH ?? '';
            paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
        });
        after(() => {
            rmSync(base, { recursive: true, force: true });
        });
        if (k === 1) {
            it(`every git branch guard has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
                for (const gate of GIT_BRANCH_GATES) {
                    const files = corpusFiles(gate);
                    assert.ok(files.length >= MIN_CORPUS, `${gate}: ${files.length} payloads`);
                    for (const f of files) {
                        const { expect, divergent } = materialize(join(CORPUS_ROOT, gate, f), '/s', { noJq: '', noSqlite: '' });
                        if (divergent === undefined)
                            assert.ok(typeof expect === 'string' && expect !== '', `${gate}/${f}: an expectation`);
                        else
                            assert.ok(typeof expect === 'object' && divergent !== '' && expect.bash !== '' && expect.ts !== '', `${gate}/${f}: a divergent case names why and expects each side`);
                    }
                }
            });
        }
        for (const { gate, f, locale } of shardOf(cases, k, n)) {
            it(`${gate} / ${f} (LC_ALL=${locale})`, () => {
                const c = materialize(join(CORPUS_ROOT, gate, f), s, paths);
                const env = caseEnv(s, locale, c.env, c.cwd);
                const stdinFile = join(base, 'stdin');
                const bash = run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c, stdinFile, env);
                const node = run(process.execPath, [HOOKS_BUNDLE, gate], c, stdinFile, env);
                assert.equal(bash.code, 0, 'bash exit');
                assert.equal(node.code, 0, 'node exit');
                if (c.divergent === undefined) {
                    assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                    assertExpect('bash', bash, c.expect);
                }
                else {
                    const expect = c.expect;
                    assert.notEqual(node.stdout, bash.stdout, `divergent (${c.divergent}): the sides must differ`);
                    assertExpect('bash', bash, expect.bash);
                    assertExpect('ts', node, expect.ts);
                }
            });
        }
    });
}
//# sourceMappingURL=hooks-git-branch-guards-parity.suite.js.map