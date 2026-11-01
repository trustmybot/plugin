/**
 * Parity of the TypeScript agent-spawn-dispatch, ensure-swe-worktree and
 * record-swe-spawn gates with their scripts/hooks/<gate>.sh (GH 1692), over
 * tests/fixtures/hook-corpus/<gate>/. A template sandbox is built once and
 * copied to the same path before each side runs, so both sides start from
 * byte-identical git repos and DBs. Both sides must print the same stdout and
 * stderr and leave the sandbox alike: every path, with the files inside a .git
 * dir compared by name only, each other file by its sha256 and each DB as its
 * tasks and agent_runs rows, every timestamp the run wrote masked as <now>,
 * the epoch-ms tail of a session spawn_id as <ms> and a duration_ms equal to
 * its run's window as "window". jq's own `jq: ` stderr lines (the .sh leaves
 * ensure-swe-worktree's jq calls unsilenced) are part of the no-jq divergence
 * and dropped from the bash side.
 *
 * project/ is the workspace: its DB registers plugin (absolute path), docs (a
 * path relative to the workspace), ghost (no path) and slashed (plugin's path
 * with a trailing slash). plugin has a linked worktree for feat/linked, a
 * session worktree recorded as task 12's tasks.worktree_path (GH 2032), a
 * plain dir squatting the slug of feat/squat and no branch for task 15. The
 * tasks: clean running (10), linked pending (11), recorded worktree (12),
 * recorded but gone (13), squatted (14), no branch (15), docs pending (16),
 * ghost (17), empty branch_id (18), closed with no commit (19), running for a
 * reviewer (20), two review FAILs (21), an unregistered repo (22), runs the
 * sweep must keep (23) and slashed (24). single/ registers one repo, ws/ none
 * and is a git repo itself; fresh/ is a schema-only DB and bad/ a corrupt one.
 *
 * A payload follows hooks-swe-run-parity.suite.ts's corpus keys. A divergent
 * payload's sides need not share an exit code; each side's observed text then
 * leads with `exit=<code>`. The payload × locale (C, en_US.UTF-8) runs split
 * across hooks-agent-spawn-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { goldenBash, goldenRoots, sandboxSha, settledTree } from './golden.js';
import { shardOf } from './shard.js';
import { byLocale, corpusFiles, materialize, noCmdPath, run } from './hooks-swe-run-parity.suite.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 8;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const SEEDED = new Set([T1, T2, FUTURE]);
const TS_RE = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g;
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
const XCRUN_CACHE_NOISE = /^git: error: couldn't create cache file '[^']*xcrun_db-[^']*' \(errno=Operation not permitted\)\n/gm;
const JQ_STDERR = /^jq: .*\n/gm;
export const AGENT_SPAWN_GATES = ['agent-spawn-dispatch', 'ensure-swe-worktree', 'record-swe-spawn'];
const UNSET = [
    'TRAJECTORY_DB_PATH',
    'TMB_TEST_RUN_ID',
    'TMB_FORBID_LIVE_SYNC',
    'TMB_HOOKS_SQLITE',
    'TMB_DB_WRITE_TIMEOUT_MS',
    'TMB_DISABLE_ENSURE_SWE_WORKTREE',
    'TMB_ALLOW_BRANCH_MISMATCH',
    'TMB_SKIP_CODE_REVIEWER_SPAWN_NOTE',
    'TMB_SKIP_CODE_REVIEWER_PREFLIGHT',
    'LANG',
    'LC_CTYPE',
];
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: T1,
    GIT_COMMITTER_DATE: T1,
};
function git(dir, ...args) {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
}
function gitRepo(dir, ...branches) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), `${basename(dir)}\n`);
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-qm', 'init');
    for (const branch of branches)
        git(dir, 'branch', branch);
}
function trajectoryDb(path, rows) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
        db.exec(SCHEMA);
        db.exec('PRAGMA foreign_keys = OFF');
        db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'agent spawn', 'open', ?, ?)").run(T1, T1);
        rows(db);
    }
    finally {
        db.close();
    }
}
function addTask(db, id, branch, status, repo, extra = {}) {
    db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, spec_body, repo, effort, worktree_path, created_at, updated_at) VALUES (?, 1, ?, 'd', ?, 'Implement it.', ?, ?, ?, ?, ?)").run(id, branch, status, repo, extra.effort ?? 'medium', extra.worktree ?? null, T1, T1);
}
function addRun(db, task, spawnId, startedAt, completedAt = null) {
    db.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, spawn_id, started_at, completed_at, duration_ms) VALUES (?, 1, 'swe', ?, ?, ?, 0)").run(task, spawnId, startedAt, completedAt);
}
/** The template sandbox, built at <s>. */
export function buildTemplate(s) {
    rmSync(s, { recursive: true, force: true });
    mkdirSync(join(s, 'home'), { recursive: true });
    mkdirSync(join(s, 'bare'));
    const plugin = join(s, 'project/plugin');
    gitRepo(plugin, 'feat/clean', 'feat/linked', 'feat/adopted', 'feat/gone', 'feat/squat', 'feat/closed', 'feat/review', 'feat/rework', 'feat/keep', 'feat/slashed', 'feat/lowfx');
    git(plugin, 'worktree', 'add', '-q', '.claude/worktrees/linked', 'feat/linked');
    git(plugin, 'worktree', 'add', '-q', '.claude/worktrees/session-1', 'feat/adopted');
    mkdirSync(join(plugin, '.claude/worktrees/squat'), { recursive: true });
    gitRepo(join(s, 'project/docs'), 'docs/readme');
    trajectoryDb(join(s, PROJECT_DB), (db) => {
        const repo = db.prepare('INSERT INTO repos (name, path, last_scanned_at) VALUES (?, ?, ?)');
        repo.run('plugin', plugin, T1);
        repo.run('docs', 'docs', T1);
        repo.run('ghost', '', T1);
        repo.run('slashed', `${plugin}/`, T1);
        addTask(db, 10, 'feat/clean', 'running', 'plugin', { effort: 'high' });
        addTask(db, 11, 'feat/linked', 'pending', 'plugin');
        addTask(db, 12, 'feat/adopted', 'running', 'plugin', { worktree: join(plugin, '.claude/worktrees/session-1') });
        addTask(db, 13, 'feat/gone', 'running', 'plugin', { worktree: join(s, 'gone-worktree') });
        addTask(db, 14, 'feat/squat', 'running', 'plugin');
        addTask(db, 15, 'feat/missing-branch', 'running', 'plugin');
        addTask(db, 16, 'docs/readme', 'pending', 'docs');
        addTask(db, 17, 'feat/ghost', 'running', 'ghost');
        addTask(db, 18, '', 'running', 'plugin');
        addTask(db, 19, 'feat/closed', 'closed', 'plugin');
        addTask(db, 20, 'feat/review', 'running', 'plugin');
        addTask(db, 21, 'feat/rework', 'running', 'plugin');
        addTask(db, 22, 'feat/nowhere', 'running', 'nowhere');
        addTask(db, 23, 'feat/keep', 'running', 'plugin');
        addTask(db, 24, 'feat/slashed', 'running', 'slashed');
        addRun(db, 10, 'tool_use:toolu_stale', T1);
        addRun(db, 10, null, T1);
        addRun(db, 10, 'tool_use:toolu_done', T1, T2);
        addRun(db, 23, 'agent-keyed', T1);
        addRun(db, 23, 'tool_use:toolu_future', FUTURE);
        const fail = db.prepare("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (21, ?, 'code-reviewer', 'fail', 1, ?)");
        fail.run(1, T1);
        fail.run(2, T2);
    });
    gitRepo(join(s, 'single/solo'), 'feat/solo');
    trajectoryDb(join(s, 'single/.claude/tmb/trajectory.db'), (db) => {
        db.prepare('INSERT INTO repos (name, path, last_scanned_at) VALUES (?, ?, ?)').run('solo', join(s, 'single/solo'), T1);
        addTask(db, 30, 'feat/solo', 'running', null);
    });
    gitRepo(join(s, 'ws'), 'feat/ws');
    trajectoryDb(join(s, 'ws/.claude/tmb/trajectory.db'), (db) => {
        addTask(db, 40, 'feat/ws', 'running', null);
    });
    trajectoryDb(join(s, 'fresh/.claude/tmb/trajectory.db'), () => { });
    mkdirSync(join(s, 'bad/.claude/tmb'), { recursive: true });
    writeFileSync(join(s, 'bad/.claude/tmb/trajectory.db'), 'this is not a sqlite database\n'.repeat(64));
}
function masked(value) {
    if (typeof value !== 'string')
        return value;
    return value.replace(TS_RE, (ts) => (SEEDED.has(ts) ? ts : '<now>')).replace(/^(tool_use:.*:)\d{10,}$/, '$1<ms>');
}
function maskRows(rows) {
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, masked(v)])));
}
function sha(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}
/** A DB as its tasks and agent_runs rows, timestamps the run wrote masked; any other file as its sha256. */
function dumpDb(path) {
    let db;
    try {
        db = new DatabaseSync(path, { readOnly: true });
    }
    catch {
        return sha(path);
    }
    try {
        const tasks = db.prepare('SELECT id, status, updated_at, completed_at FROM tasks ORDER BY id').all();
        const runs = db
            .prepare(`SELECT id, task_id, issue_id, agent_type, started_at, repo, root_dir, host, session_id, effort, model, spawn_id,
                plugin_version, exit_reason, usage_source, completed_at,
                CASE WHEN completed_at IS NOT NULL AND completed_at <> started_at AND duration_ms > 0
                          AND duration_ms = CAST(ROUND((julianday(completed_at) - julianday(started_at)) * 86400000) AS INTEGER)
                     THEN 'window' ELSE duration_ms END AS duration_ms
           FROM agent_runs ORDER BY id`)
            .all();
        return JSON.stringify({ tasks: maskRows(tasks), agent_runs: maskRows(runs) });
    }
    catch {
        return sha(path);
    }
    finally {
        db.close();
    }
}
/** Every path under <root> but SQLite's side files; a file inside a .git dir by name, a DB as dumpDb, any other file as its sha256. */
function snapshot(root) {
    const out = {};
    const walk = (dir, inGit) => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name);
            if (/-(wal|shm|journal)$/.test(name))
                continue;
            const rel = relative(root, path);
            const st = statSync(path);
            if (st.isDirectory()) {
                out[`${rel}/`] = null;
                walk(path, inGit || name === '.git');
            }
            else if (inGit) {
                out[rel] = null;
            }
            else {
                out[rel] = name.endsWith('.db') ? dumpDb(path) : sandboxSha(path, root);
            }
        }
    };
    walk(root, false);
    return out;
}
export function caseEnv(s, locale, extra, cwd) {
    const env = { ...process.env };
    for (const key of UNSET)
        delete env[key];
    Object.assign(env, {
        HOME: join(s, 'home'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        CLAUDE_PROJECT_DIR: join(s, 'project'),
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        TRAJECTORY_DB_PATH: join(s, PROJECT_DB),
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
function quiet(r, side) {
    let stderr = r.stderr.replace(XCRUN_CACHE_NOISE, '');
    if (side === 'bash')
        stderr = stderr.replace(JQ_STDERR, '');
    return { ...r, stderr };
}
/**
 * `empty`: no stdout or stderr; `!<phrase>`: the phrase is nowhere in what is observed; anything else: a phrase
 * of `exit=<code>`, the output or the project DB rows.
 */
function assertExpect(side, r, tree, expect, dbRel) {
    const output = r.stdout + r.stderr;
    if (expect === 'empty') {
        assert.equal(output, '', `${side}: no output`);
        return;
    }
    const observed = `exit=${r.code}\n${output}\n${tree[dbRel] ?? ''}\n${Object.keys(tree).join('\n')}`;
    if (expect.startsWith('!')) {
        assert.ok(!observed.includes(expect.slice(1)), `${side} never observes ${JSON.stringify(expect.slice(1))}`);
        return;
    }
    assert.ok(observed.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${observed.slice(0, 2000)}`);
}
const cases = AGENT_SPAWN_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));
export function agentSpawnParityShard(k, n) {
    describe(`agent-spawn gates parity: bash vs node over a copied sandbox (shard ${k} of ${n})`, { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' }, () => {
        let base;
        let s;
        let template;
        let paths;
        const restore = () => {
            rmSync(s, { recursive: true, force: true });
            cpSync(template, s, { recursive: true });
        };
        before(() => {
            base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-agent-spawn-parity-')));
            s = join(base, 'sandbox');
            template = join(base, 'template');
            buildTemplate(s);
            cpSync(s, template, { recursive: true });
            const path = process.env.PATH ?? '';
            paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
        });
        after(() => {
            rmSync(base, { recursive: true, force: true });
        });
        if (k === 1) {
            it(`every agent-spawn gate has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
                for (const gate of AGENT_SPAWN_GATES) {
                    const list = corpusFiles(gate);
                    assert.ok(list.length >= MIN_CORPUS, `${gate}: ${list.length} payloads`);
                    for (const f of list) {
                        const { expect, divergent } = materialize(join(CORPUS_ROOT, gate, f), '/s', { noJq: '', noSqlite: '' });
                        if (divergent === undefined)
                            assert.ok(typeof expect === 'string' ? expect !== '' : !('bash' in expect) && LOCALES.every((l) => byLocale(expect, l) !== ''), `${gate}/${f}: an expectation, or one per locale`);
                        else
                            assert.ok(typeof expect === 'object' && divergent !== '' && LOCALES.every((l) => byLocale(expect.bash, l) !== '' && byLocale(expect.ts, l) !== ''), `${gate}/${f}: a divergent case names why and expects each side in every locale`);
                    }
                }
            });
        }
        for (const { gate, f, locale } of shardOf(cases, k, n)) {
            it(`${gate} / ${f} (LC_ALL=${locale})`, () => {
                const c = materialize(join(CORPUS_ROOT, gate, f), s, paths);
                const env = caseEnv(s, locale, c.env, c.cwd);
                const dbRel = relative(s, env.TRAJECTORY_DB_PATH ?? join(s, PROJECT_DB));
                const { tree: bashTree, ...bash } = goldenBash(gate, f, locale, goldenRoots({ '@SANDBOX@': s, '@BASE@': base }), () => {
                    restore();
                    const setup = snapshot(s);
                    return { ...quiet(run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c, env), 'bash'), tree: settledTree(setup, snapshot(s)) };
                });
                restore();
                const setup = snapshot(s);
                const node = quiet(run(process.execPath, [HOOKS_BUNDLE, gate], c, env), 'ts');
                const nodeTree = settledTree(setup, snapshot(s));
                assert.equal(node.code, 0, `node exit: ${node.stderr}`);
                if (c.divergent === undefined) {
                    assert.equal(bash.code, 0, `bash exit: ${bash.stderr}`);
                    assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
                    assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                    assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
                    assertExpect('bash', bash, bashTree, byLocale(c.expect, locale), dbRel);
                }
                else {
                    const expect = c.expect;
                    assert.ok(node.code !== bash.code || node.stdout + node.stderr !== bash.stdout + bash.stderr || !isDeepStrictEqual(nodeTree, bashTree), `divergent (${c.divergent}): the sides must differ`);
                    assertExpect('bash', bash, bashTree, byLocale(expect.bash, locale), dbRel);
                    assertExpect('ts', node, nodeTree, byLocale(expect.ts, locale), dbRel);
                }
            });
        }
    });
}
//# sourceMappingURL=hooks-agent-spawn-parity.suite.js.map