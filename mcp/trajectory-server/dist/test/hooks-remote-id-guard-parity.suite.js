/**
 * Byte-for-byte parity of the TypeScript remote-id-guard with
 * scripts/hooks/remote-id-guard.sh (GH 1692) over
 * tests/fixtures/hook-corpus/remote-id-guard/, against a sandbox trajectory DB
 * of local issues: 5 (gh 42, a title with a bar), 7 (gl 88), 9 (no remote
 * iid), 10 (gh 50, gl 60), 11 (gh 77, a title of printf escapes), 12 (gh 78, a
 * two-line title with a bar) and 42 (gh 42); beside it a DB with no issues
 * table and a corrupt DB. A payload names the sandbox as @SANDBOX@ and the
 * PATH without jq or without the sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@;
 * corpus_env overrides the env and corpus_expect is `allow` or a phrase of the
 * deny reason, both removed before the run. Both sides must exit alike and
 * print the same stdout byte for byte. A payload with corpus_divergent names a
 * divergence decision 703 allows (or the in-process deadline's test knob):
 * corpus_expect is then { bash, ts }, each `allow`, `error` (a nonzero exit)
 * or a deny phrase, and the two sides must differ. The payload × locale (C,
 * en_US.UTF-8) runs split across
 * hooks-remote-id-guard-parity.shard-<k>of<n>.test.ts, each shard with its
 * own sandbox; shard 1 also runs the whole-corpus check.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { noCmdPath } from './hooks-swe-run-parity.suite.js';
import { goldenBash, goldenRoots } from './golden.js';
import { shardOf } from './shard.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus/remote-id-guard');
const HOOK_SH = join(PLUGIN_ROOT, 'scripts/hooks/remote-id-guard.sh');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 10;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const UNSET = [
    'TMB_DISABLE_REMOTE_ID_GUARD',
    'TMB_REMOTE_ID_GUARD_DEADLINE_S',
    'TMB_REMOTE_ID_GUARD_TEST_OVERRUN',
    'TMB_HOOKS_SQLITE',
    'TMB_DB_WRITE_TIMEOUT_MS',
    'LANG',
    'LC_CTYPE',
];
export const LOCAL_ISSUES = [
    [5, 'Local five | pipe title', 42, null],
    [7, 'Local seven', null, 88],
    [9, 'Local nine', null, null],
    [10, 'Local ten', 50, 60],
    [11, 'back\\slash \\t tab \\x41 \\101 \\c cut', 77, null],
    [12, 'multi\nline|x', 78, null],
    [42, 'Local forty-two', 42, null],
];
/** A trajectory DB at <path> holding LOCAL_ISSUES. */
export function localIssuesDb(path) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
        db.exec(SCHEMA);
        const issue = db.prepare("INSERT INTO issues (id, objective, status, gh_iid, gl_iid, created_at, updated_at) VALUES (?, ?, 'open', ?, ?, datetime('now'), datetime('now'))");
        for (const [id, objective, gh, gl] of LOCAL_ISSUES)
            issue.run(id, objective, gh, gl);
    }
    finally {
        db.close();
    }
}
export function buildSandbox(s) {
    mkdirSync(join(s, 'project'), { recursive: true });
    localIssuesDb(join(s, 'db/trajectory.db'));
    const empty = new DatabaseSync(join(s, 'no-issues.db'));
    empty.exec('CREATE TABLE other (id INTEGER)');
    empty.close();
    writeFileSync(join(s, 'bad.db'), 'this is not a sqlite database\n'.repeat(64));
}
export function materialize(file, s, paths) {
    const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', s).replaceAll('@NOJQ_PATH@', paths.noJq).replaceAll('@NOSQLITE_PATH@', paths.noSqlite);
    const { corpus_env: env = {}, corpus_expect: expect = '', corpus_divergent: divergent, ...payload } = JSON.parse(text);
    return { input: JSON.stringify(payload), env, expect, divergent };
}
/** bash's `set -m` prints this, with a pid, when a background child beats its setpgid. */
const BASH_JOB_CONTROL_RACE = /^.*child setpgid .*\n/gm;
/** Stdin comes from a file, so a side that exits before reading it (the bypass) cannot fail the spawn with EPIPE. */
function run(cmd, args, input, env, cwd) {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-rig-stdin-'));
    const file = join(dir, 'stdin');
    writeFileSync(file, input);
    const fd = openSync(file, 'r');
    try {
        const r = spawnSync(cmd, args, { stdio: [fd, 'pipe', 'pipe'], env, cwd, encoding: 'utf8', timeout: 30_000 });
        if (r.error)
            throw r.error;
        return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    finally {
        closeSync(fd);
        rmSync(dir, { recursive: true, force: true });
    }
}
function assertExpect(side, r, expect) {
    if (expect === 'error') {
        assert.notEqual(r.code, 0, `${side}: a nonzero exit`);
        return;
    }
    assert.equal(r.code, 0, `${side} exit: ${r.stderr}`);
    if (expect === 'allow') {
        assert.equal(r.stdout, '', `${side}: allowed`);
        return;
    }
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', side);
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(expect), `${side}: ${out.hookSpecificOutput.permissionDecisionReason}`);
}
const corpus = readdirSync(CORPUS)
    .filter((f) => f.endsWith('.json'))
    .sort();
const cases = corpus.flatMap((f) => LOCALES.map((locale) => ({ f, locale })));
export function remoteIdGuardParityShard(k, n) {
    describe(`remote-id-guard parity: bash vs node over a DB of local issues (shard ${k} of ${n})`, { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' }, () => {
        let base;
        let s;
        let paths;
        before(() => {
            base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-rig-parity-')));
            s = join(base, 'sandbox');
            buildSandbox(s);
            const path = process.env.PATH ?? '';
            paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
        });
        after(() => {
            rmSync(base, { recursive: true, force: true });
        });
        if (k === 1) {
            it(`the corpus holds at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
                assert.ok(corpus.length >= MIN_CORPUS, `${corpus.length} payloads`);
                for (const f of corpus) {
                    const { expect, divergent } = materialize(join(CORPUS, f), '/s', { noJq: '', noSqlite: '' });
                    if (divergent === undefined)
                        assert.ok(typeof expect === 'string' && expect !== '', `${f}: an expectation`);
                    else
                        assert.ok(typeof expect === 'object' && divergent !== '' && expect.bash !== '' && expect.ts !== '', `${f}: a divergent case names why and expects each side`);
                }
            });
        }
        for (const { f, locale } of shardOf(cases, k, n)) {
            it(`${f} (LC_ALL=${locale})`, () => {
                const c = materialize(join(CORPUS, f), s, paths);
                const env = { ...process.env };
                for (const key of UNSET)
                    delete env[key];
                Object.assign(env, {
                    CLAUDE_PROJECT_DIR: join(s, 'project'),
                    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
                    TRAJECTORY_DB_PATH: join(s, 'db/trajectory.db'),
                    LC_ALL: locale,
                    ...c.env,
                });
                const cwd = join(s, 'project');
                const bash = goldenBash('remote-id-guard', f, locale, goldenRoots({ '@SANDBOX@': s, '@BASE@': base }), () => {
                    const r = run('bash', [HOOK_SH], c.input, env, cwd);
                    return { ...r, stderr: r.stderr.replace(BASH_JOB_CONTROL_RACE, '') };
                });
                const node = run(process.execPath, [HOOKS_BUNDLE, 'remote-id-guard'], c.input, env, cwd);
                if (c.divergent === undefined) {
                    assert.equal(node.code, bash.code, 'exit code');
                    assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                    assertExpect('bash', bash, c.expect);
                }
                else {
                    const expect = c.expect;
                    assert.ok(node.code !== bash.code || node.stdout !== bash.stdout, `divergent (${c.divergent}): the sides must differ`);
                    assertExpect('bash', bash, expect.bash);
                    assertExpect('ts', node, expect.ts);
                }
            });
        }
    });
}
//# sourceMappingURL=hooks-remote-id-guard-parity.suite.js.map