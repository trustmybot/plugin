/**
 * Parity of the TypeScript trajectory-gates chain members with their
 * scripts/hooks/<gate>.sh (GH 1692): agent-arg-matches-caller,
 * reviewer-identity-observe and cheatcode-install-approval, over
 * tests/fixtures/hook-corpus/<gate>/. The sandbox is rebuilt at the same path
 * before each side runs; both sides must exit alike, print the same stdout
 * and stderr byte for byte, and leave the sandbox alike, every DB compared by
 * its tasks and audit rows with timestamps masked.
 *
 * The sandbox holds a project DB (issue 7 with tasks 42 and 43, two
 * cheatcode_approved rows), a schema-only DB, a schema-old DB (no
 * tasks.prompt_bearing, no audit.repo), a corrupt DB and a bare dir. A
 * payload names the sandbox as @SANDBOX@ and the PATH without jq or without
 * the sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@; corpus_env (null unsets),
 * corpus_cwd, corpus_stdin and corpus_expect (`empty`, or a phrase of the
 * observed stdout and stderr, or an object of them by locale) are removed
 * before the run. A payload with corpus_divergent names a divergence decision
 * 703 allows: corpus_expect is then { bash, ts }, each a phrase or an object
 * of them by locale, and the two sides must differ in output or exit code.
 * The payload × locale (C, en_US.UTF-8) runs split across
 * hooks-trajectory-chain-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
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
const T1 = '2026-10-01T10:00:00.000Z';
const ISO_TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
export const TRAJECTORY_CHAIN_GATES = ['agent-arg-matches-caller', 'cheatcode-install-approval', 'reviewer-identity-observe'];
const UNSET = ['TRAJECTORY_DB_PATH', 'TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'TMB_HOOKS_SQLITE', 'TMB_DB_WRITE_RUN_BUDGET_MS', 'TMB_DB_WRITE_TIMEOUT_MS', 'LANG', 'LC_CTYPE'];
const OLD_SCHEMA = `
CREATE TABLE issues (id INTEGER PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id), branch_id TEXT, status TEXT);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES issues(id), branch_id TEXT,
  from_node TEXT NOT NULL, event_type TEXT NOT NULL, summary TEXT NOT NULL, content_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
INSERT INTO issues (id, objective) VALUES (-1, 'system'), (7, 'old');
INSERT INTO tasks (id, issue_id, branch_id, status) VALUES (42, 7, 'feat/old', 'running');
INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
  VALUES (7, 'bro', 'cheatcode_approved', 'approved', '{"source_url":"https://x.test/approved"}', '${T1}');
`;
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
/** The sandbox every case starts from, rebuilt at <s> before each side runs. */
export function buildSandbox(s) {
    rmSync(s, { recursive: true, force: true });
    mkdirSync(join(s, 'home'), { recursive: true });
    mkdirSync(join(s, 'bare'));
    trajectoryDb(join(s, 'project/.claude/tmb/trajectory.db'), (db) => {
        db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'trajectory chain gates', 'open', ?, ?)").run(T1, T1);
        const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, 7, ?, 'd', 'running', ?, ?)");
        task.run(42, 'feat/chain', T1, T1);
        task.run(43, 'feat/chain-two', T1, T1);
        const approved = db.prepare("INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (7, 'bro', 'cheatcode_approved', 'approved', ?, ?)");
        approved.run(JSON.stringify({ name: 'approved-skill', kind: 'skill', source_url: 'https://x.test/approved' }), T1);
        approved.run(JSON.stringify({ name: "o'brien", kind: 'skill', source_url: "https://x.test/o'brien" }), T1);
    });
    trajectoryDb(join(s, 'fresh/.claude/tmb/trajectory.db'), () => { });
    const old = join(s, 'old/.claude/tmb/trajectory.db');
    mkdirSync(dirname(old), { recursive: true });
    const db = new DatabaseSync(old);
    try {
        db.exec(OLD_SCHEMA);
    }
    finally {
        db.close();
    }
    mkdirSync(join(s, 'bad/.claude/tmb'), { recursive: true });
    writeFileSync(join(s, 'bad/.claude/tmb/trajectory.db'), 'this is not a sqlite database\n'.repeat(64));
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
function rows(db, sql) {
    try {
        return db.prepare(sql).all();
    }
    catch (e) {
        return `error: ${e.message}`;
    }
}
/** A DB as its tasks and audit rows, timestamps masked; a file that does not open as its sha256. */
function dumpDb(path) {
    let db;
    try {
        db = new DatabaseSync(path, { readOnly: true });
    }
    catch {
        return createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    try {
        const tasks = rows(db, 'SELECT id, issue_id, status FROM tasks ORDER BY id');
        const audit = rows(db, 'SELECT issue_id, branch_id, from_node, event_type, summary, hex(summary) AS summary_hex, content_json, created_at FROM audit ORDER BY id');
        if (typeof tasks === 'string' && typeof audit === 'string')
            return createHash('sha256').update(readFileSync(path)).digest('hex');
        return JSON.stringify({ tasks, audit }).replace(ISO_TIME, '<ts>');
    }
    finally {
        db.close();
    }
}
/** Every path under <root> but SQLite's side files; each DB as dumpDb reads it, any other file as its sha256. */
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
                out[rel] = name.endsWith('.db') ? dumpDb(path) : createHash('sha256').update(readFileSync(path)).digest('hex');
            }
        }
    };
    walk(root);
    return out;
}
function byLocale(expect, locale) {
    return typeof expect === 'string' ? expect : (expect[locale] ?? '');
}
export function materialize(file, s, paths) {
    const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', s).replaceAll('@NOJQ_PATH@', paths.noJq).replaceAll('@NOSQLITE_PATH@', paths.noSqlite);
    const { corpus_env: env = {}, corpus_cwd: cwd = 'project', corpus_stdin: stdin, corpus_expect: expect = '', corpus_divergent: divergent, ...payload } = JSON.parse(text);
    return { input: Buffer.from(stdin ?? JSON.stringify(payload)), env, cwd: join(s, cwd), expect, divergent };
}
function caseEnv(s, locale, extra, cwd) {
    const env = { ...process.env };
    for (const key of UNSET)
        delete env[key];
    Object.assign(env, {
        HOME: join(s, 'home'),
        CLAUDE_PROJECT_DIR: join(s, 'project'),
        TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
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
function run(cmd, args, c, env) {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-trajectory-chain-stdin-'));
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
function assertExpect(side, observed, expect) {
    if (expect === 'empty')
        assert.equal(observed, '', `${side}: no output`);
    else
        assert.ok(observed.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${observed.slice(0, 600)}`);
}
export function corpusFiles(gate) {
    const dir = join(CORPUS_ROOT, gate);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}
const cases = TRAJECTORY_CHAIN_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));
export function trajectoryChainParityShard(k, n) {
    describe(`trajectory-gates chain parity: bash vs node over a rebuilt sandbox (shard ${k} of ${n})`, { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' }, () => {
        let base;
        let s;
        let paths;
        before(() => {
            base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-trajectory-chain-parity-')));
            s = join(base, 'sandbox');
            const path = process.env.PATH ?? '';
            paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
        });
        after(() => {
            rmSync(base, { recursive: true, force: true });
        });
        if (k === 1) {
            it(`every trajectory-gates chain member has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
                for (const gate of TRAJECTORY_CHAIN_GATES) {
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
                buildSandbox(s);
                const bash = run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c, env);
                const bashTree = snapshot(s);
                buildSandbox(s);
                const node = run(process.execPath, [HOOKS_BUNDLE, gate], c, env);
                const nodeTree = snapshot(s);
                assert.equal(node.code, 0, `node exit: ${node.stderr}`);
                if (c.divergent === undefined) {
                    assert.equal(bash.code, node.code, `bash exit: ${bash.stderr}`);
                    assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
                    assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                    assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
                    assertExpect('bash', bash.stdout + bash.stderr, byLocale(c.expect, locale));
                }
                else {
                    const expect = c.expect;
                    assert.ok(node.code !== bash.code || node.stdout + node.stderr !== bash.stdout + bash.stderr || JSON.stringify(nodeTree) !== JSON.stringify(bashTree), `divergent (${c.divergent}): the sides must differ`);
                    assertExpect('bash', bash.stdout + bash.stderr, byLocale(expect.bash, locale));
                    assertExpect('ts', node.stdout + node.stderr, byLocale(expect.ts, locale));
                }
            });
        }
    });
}
//# sourceMappingURL=hooks-trajectory-chain-parity.suite.js.map