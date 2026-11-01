/**
 * Parity of the TypeScript swe-run gates with their scripts/hooks/<gate>.sh
 * (GH 1692): swe-brief-gate, swe-spawn-bind, swe-spawn-rollback and
 * post-task-create-spawn-hint, over tests/fixtures/hook-corpus/<gate>/. The
 * sandbox is rebuilt at the same path before each side runs; both sides must
 * exit 0, print the same stdout and stderr byte for byte, and leave the
 * sandbox alike, each DB compared as its tasks, agent_runs and audit rows with
 * every timestamp the run wrote masked as <now> and a duration_ms equal to its
 * run's window as "window".
 *
 * The project DB holds repos plugin (absolute path), docs (a path relative to
 * the project) and ghost (no path), and tasks briefed (10), unbriefed with an
 * open tool_use run (11), resumed with its keyed run closed (12), live with
 * its keyed run open (13), two open tool_use runs (14), an open run with no
 * spawn_id (15), an open keyed run beside a tool_use one (16), in docs (17),
 * in ghost (18), a measured tool_use run (19) and no repo (20). Beside it: a
 * schema-only DB, a corrupt DB, a bare dir and the spawn transcripts of task
 * 11. A payload names the sandbox as @SANDBOX@ and the PATH without jq or
 * without the sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@; corpus_env (null
 * unsets), corpus_cwd, corpus_stdin and corpus_expect (`empty` for no output,
 * or a phrase of the observed stdout, stderr and project DB rows, or an object
 * of them by locale) are removed before the run. A payload with
 * corpus_divergent names a divergence decision 703 allows: corpus_expect is
 * then { bash, ts }, each an expectation or an object of them by locale, and
 * the two sides must differ in output or in the sandbox. The payload × locale
 * (C, en_US.UTF-8) runs split across hooks-swe-run-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { goldenBash, goldenRoots, sandboxSha, settledTree } from './golden.js';
import { shardOf } from './shard.js';
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
const SEEDED = new Set([T1, T2]);
const TS_RE = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g;
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
export const SWE_RUN_GATES = ['post-task-create-spawn-hint', 'swe-brief-gate', 'swe-spawn-bind', 'swe-spawn-rollback'];
const UNSET = [
    'TRAJECTORY_DB_PATH',
    'TMB_TEST_RUN_ID',
    'TMB_FORBID_LIVE_SYNC',
    'TMB_HOOKS_SQLITE',
    'TMB_DISABLE_SPAWN_HINT',
    'TMB_DB_WRITE_TIMEOUT_MS',
    'LANG',
    'LC_CTYPE',
];
function trajectoryDb(path, rows) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
        db.exec(SCHEMA);
        rows(db);
    }
    finally {
        db.close();
    }
}
function transcript(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
}
/** The sandbox every case starts from, rebuilt at <s> before each side runs. */
export function buildSandbox(s) {
    rmSync(s, { recursive: true, force: true });
    mkdirSync(join(s, 'home'), { recursive: true });
    mkdirSync(join(s, 'bare'));
    mkdirSync(join(s, 'project/checkout'), { recursive: true });
    mkdirSync(join(s, 'project/docs-checkout'), { recursive: true });
    trajectoryDb(join(s, PROJECT_DB), (db) => {
        const repo = db.prepare('INSERT INTO repos (name, path, last_scanned_at) VALUES (?, ?, ?)');
        repo.run('plugin', join(s, 'project/checkout'), T1);
        repo.run('docs', 'docs-checkout', T1);
        repo.run('ghost', '', T1);
        db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'swe run gates', 'open', ?, ?)").run(T1, T1);
        const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, created_at, updated_at) VALUES (?, 1, ?, 'd', ?, ?, ?, ?)");
        task.run(10, 'feat/briefed', 'running', 'plugin', T1, T1);
        task.run(11, 'feat/unbriefed', 'running', 'plugin', T1, T1);
        task.run(12, 'feat/resumed', 'running', 'plugin', T1, T1);
        task.run(13, 'feat/live', 'running', 'plugin', T1, T1);
        task.run(14, 'fix/two-runs', 'running', 'plugin', T1, T1);
        task.run(15, 'feat/null-spawn', 'running', 'plugin', T1, T1);
        task.run(16, 'feat/bound', 'running', 'plugin', T1, T1);
        task.run(17, 'docs/readme', 'pending', 'docs', T1, T1);
        task.run(18, 'feat/ghost', 'pending', 'ghost', T1, T1);
        task.run(19, 'feat/measured', 'running', 'plugin', T1, T1);
        task.run(20, 'feat/no-repo', 'pending', null, T1, T1);
        const run = db.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, spawn_id, started_at, completed_at, exit_reason, duration_ms, tokens_in) VALUES (?, 1, 'swe', ?, ?, ?, ?, ?, ?)");
        run.run(10, 'agent-briefed', T1, null, null, 0, null);
        run.run(11, 'tool_use:toolu_11', T1, null, null, 0, null);
        run.run(12, 'agent-resumed', T1, T2, 'completed', 0, null);
        run.run(13, 'agent-live', T1, null, null, 0, null);
        run.run(14, 'tool_use:toolu_14a', T1, null, null, 0, null);
        run.run(14, 'tool_use:toolu_14b', T1, null, null, 1234, null);
        run.run(15, null, T1, null, null, 0, null);
        run.run(16, 'agent-bound', T1, null, null, 0, null);
        run.run(16, 'tool_use:toolu_16', T1, null, null, 0, null);
        run.run(19, 'tool_use:toolu_19', T1, null, null, 0, 50);
        db.prepare("INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (1, 'feat/briefed', 'swe', 'swe_brief_fetched', 'brief', '{\"task_id\":10}', ?)").run(T1);
    });
    trajectoryDb(join(s, 'fresh/.claude/tmb/trajectory.db'), () => { });
    mkdirSync(join(s, 'bad/.claude/tmb'), { recursive: true });
    writeFileSync(join(s, 'bad/.claude/tmb/trajectory.db'), 'this is not a sqlite database\n'.repeat(64));
    transcript(join(s, 'transcripts/session/subagents/agent-agent-tx.jsonl'), `task_id=11 worktree=${join(s, 'project/checkout/.claude/worktrees/unbriefed')}`);
    writeFileSync(join(s, 'transcripts/session.jsonl'), '');
    transcript(join(s, 'transcripts/spawn-12.jsonl'), 'task_id=12 worktree=/w');
}
/** PATH with <cmd> gone: each dir holding it replaced by a dir of links to everything else. */
export function noCmdPath(dir, cmd, path) {
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
function masked(value) {
    return typeof value === 'string' ? value.replace(TS_RE, (ts) => (SEEDED.has(ts) ? ts : '<now>')) : value;
}
function maskRows(rows) {
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, masked(v)])));
}
/** A DB as its tasks, agent_runs and audit rows, timestamps the run wrote masked; any other file as its sha256. */
function dumpDb(path) {
    const sha = () => createHash('sha256').update(readFileSync(path)).digest('hex');
    let db;
    try {
        db = new DatabaseSync(path, { readOnly: true });
    }
    catch {
        return sha();
    }
    try {
        const tasks = db.prepare('SELECT id, status, updated_at FROM tasks ORDER BY id').all();
        const runs = db
            .prepare(`SELECT id, task_id, spawn_id, exit_reason, usage_source, completed_at,
                CASE WHEN completed_at IS NOT NULL AND completed_at <> started_at AND duration_ms > 0
                          AND duration_ms = CAST(ROUND((julianday(completed_at) - julianday(started_at)) * 86400000) AS INTEGER)
                     THEN 'window' ELSE duration_ms END AS duration_ms
           FROM agent_runs ORDER BY id`)
            .all();
        const audit = db.prepare('SELECT * FROM audit ORDER BY id').all();
        return JSON.stringify({ tasks: maskRows(tasks), agent_runs: maskRows(runs), audit: maskRows(audit) });
    }
    catch {
        return sha();
    }
    finally {
        db.close();
    }
}
/** Every path under <root> but SQLite's side files; each DB as dumpDb, any other file as its sha256. */
export function snapshot(root) {
    const out = {};
    const walk = (dir) => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name);
            if (/-(wal|shm|journal)$/.test(name))
                continue;
            const rel = relative(root, path);
            if (statSync(path).isDirectory()) {
                out[`${rel}/`] = null;
                walk(path);
            }
            else {
                out[rel] = name.endsWith('.db') ? dumpDb(path) : sandboxSha(path, root);
            }
        }
    };
    walk(root);
    return out;
}
export function byLocale(expect, locale) {
    return typeof expect === 'string' ? expect : (expect[locale] ?? '');
}
export function materialize(file, s, paths) {
    const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', s).replaceAll('@NOJQ_PATH@', paths.noJq).replaceAll('@NOSQLITE_PATH@', paths.noSqlite);
    const { corpus_env: env = {}, corpus_cwd: cwd = 'project', corpus_stdin: stdin, corpus_expect: expect = '', corpus_divergent: divergent, ...payload } = JSON.parse(text);
    return { input: Buffer.from(stdin ?? JSON.stringify(payload)), env, cwd: join(s, cwd), expect, divergent };
}
export function caseEnv(s, locale, extra, cwd) {
    const env = { ...process.env };
    for (const key of UNSET)
        delete env[key];
    Object.assign(env, {
        HOME: join(s, 'home'),
        CLAUDE_PROJECT_DIR: join(s, 'project'),
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
export function run(cmd, args, c, env) {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-swe-run-stdin-'));
    const file = join(dir, 'stdin');
    writeFileSync(file, c.input);
    const fd = openSync(file, 'r');
    try {
        const r = spawnSync(cmd, args, { stdio: [fd, 'pipe', 'pipe'], env, cwd: c.cwd, encoding: 'utf8', timeout: 30_000 });
        if (r.error)
            throw r.error;
        return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    finally {
        closeSync(fd);
        rmSync(dir, { recursive: true, force: true });
    }
}
/** `empty`: no stdout or stderr; anything else: a phrase of the output or of the project DB rows. */
export function assertExpect(side, r, tree, expect) {
    const output = r.stdout + r.stderr;
    if (expect === 'empty') {
        assert.equal(output, '', `${side}: no output`);
        return;
    }
    const observed = `${output}\n${tree[PROJECT_DB] ?? ''}`;
    assert.ok(observed.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${observed.slice(0, 1200)}`);
}
export function corpusFiles(gate) {
    const dir = join(CORPUS_ROOT, gate);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}
const cases = SWE_RUN_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));
export function sweRunParityShard(k, n) {
    describe(`swe-run gates parity: bash vs node over a rebuilt sandbox (shard ${k} of ${n})`, { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' }, () => {
        let base;
        let s;
        let paths;
        before(() => {
            base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-swe-run-parity-')));
            s = join(base, 'sandbox');
            const path = process.env.PATH ?? '';
            paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
        });
        after(() => {
            rmSync(base, { recursive: true, force: true });
        });
        if (k === 1) {
            it(`every swe-run gate has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
                for (const gate of SWE_RUN_GATES) {
                    const files = corpusFiles(gate);
                    assert.ok(files.length >= MIN_CORPUS, `${gate}: ${files.length} payloads`);
                    for (const f of files) {
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
                const { tree: bashTree, ...bash } = goldenBash(gate, f, locale, goldenRoots({ '@SANDBOX@': s, '@BASE@': base }), () => {
                    buildSandbox(s);
                    const setup = snapshot(s);
                    return { ...run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c, env), tree: settledTree(setup, snapshot(s)) };
                });
                buildSandbox(s);
                const setup = snapshot(s);
                const node = run(process.execPath, [HOOKS_BUNDLE, gate], c, env);
                const nodeTree = settledTree(setup, snapshot(s));
                assert.equal(bash.code, 0, `bash exit: ${bash.stderr}`);
                assert.equal(node.code, 0, `node exit: ${node.stderr}`);
                if (c.divergent === undefined) {
                    assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
                    assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                    assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
                    assertExpect('bash', bash, bashTree, byLocale(c.expect, locale));
                }
                else {
                    const expect = c.expect;
                    assert.ok(node.stdout + node.stderr !== bash.stdout + bash.stderr || !isDeepStrictEqual(nodeTree, bashTree), `divergent (${c.divergent}): the sides must differ`);
                    assertExpect('bash', bash, bashTree, byLocale(expect.bash, locale));
                    assertExpect('ts', node, nodeTree, byLocale(expect.ts, locale));
                }
            });
        }
    });
}
//# sourceMappingURL=hooks-swe-run-parity.suite.js.map