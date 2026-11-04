/**
 * substrate-preflight end to end (GH 1692), the SessionStart gate that emits a
 * TMB DEGRADED banner when jq, sqlite3, git or node is missing from PATH:
 *   1. a healthy host with a remote URL: exit 0, no output;
 *   2. one or more binaries missing: each named in one banner, the output one
 *      SessionStart JSON value with a string additionalContext, jq not needed;
 *   3. the offline note when the registered repo's remotes have no URL or it
 *      has no repo_remotes row, and none when a URL is configured;
 *   4. degraded and offline at once: both in the output.
 * Each case runs `node dist/hooks.js substrate-preflight` in a sandbox with its
 * own HOME, PATH linking only the named binaries where a case needs fewer.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { jsonValues, makeSandbox, runGate } from './hook-sandbox.js';
const GATE = 'substrate-preflight';
const REPOS_SCHEMA = `CREATE TABLE repos (
  name TEXT PRIMARY KEY, path TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  target_branch TEXT, branching_model TEXT, protected_branches TEXT
);
CREATE TABLE repo_remotes (
  repo TEXT NOT NULL REFERENCES repos(name) ON DELETE CASCADE ON UPDATE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github','gitlab','other')),
  url TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo, name)
);`;
describe('substrate-preflight: the DEGRADED banner and the offline note', () => {
    let sb;
    let dbNoRemote;
    let dbWithRemote;
    let dbZeroRows;
    let stubs = 0;
    function db(name, url) {
        const path = join(sb.dir, `${name}.db`);
        const d = new DatabaseSync(path);
        try {
            d.exec(REPOS_SCHEMA);
            d.prepare("INSERT INTO repos (name, path) VALUES ('repo', '/tmp/repo')").run();
            if (url !== undefined)
                d.prepare("INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES ('repo', 'origin', 'github', ?, 1)").run(url);
        }
        finally {
            d.close();
        }
        return path;
    }
    /** A dir linking only <bins>, each from where the host PATH has it. */
    function stubDirWith(...bins) {
        stubs += 1;
        const dir = join(sb.dir, `stub-${stubs}`);
        mkdirSync(dir);
        for (const bin of bins) {
            const real = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { env: sb.env, encoding: 'utf8' }).stdout.trim();
            if (real.startsWith('/'))
                symlinkSync(real, join(dir, bin));
        }
        return dir;
    }
    function run(opts = {}) {
        const env = { ...sb.env };
        if (opts.path !== undefined)
            env.PATH = opts.path;
        if (opts.db !== undefined)
            env.TRAJECTORY_DB_PATH = opts.db;
        const r = runGate(GATE, { cwd: sb.dir, env, input: '{}' });
        return { stdout: r.stdout, status: r.status };
    }
    function single(stdout) {
        assert.doesNotThrow(() => JSON.parse(stdout), stdout);
        const values = jsonValues(stdout);
        assert.equal(values.length, 1, stdout);
        return values[0];
    }
    before(() => {
        sb = makeSandbox(GATE);
        dbNoRemote = db('no-remote', '');
        dbWithRemote = db('with-remote', 'https://github.com/org/repo.git');
        dbZeroRows = db('zero-rows');
    });
    after(() => sb.remove());
    it('a healthy host with a remote URL: exit 0, no output', () => {
        const r = run({ db: dbWithRemote });
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '');
    });
    describe('missing binaries', () => {
        let noJq;
        before(() => {
            noJq = run({ path: stubDirWith('sqlite3', 'git', 'node') }).stdout;
        });
        it('jq missing: a non-empty TMB DEGRADED banner naming jq, produced without jq', () => {
            assert.notEqual(noJq, '');
            assert.ok(noJq.includes('TMB DEGRADED'), noJq);
            assert.ok(noJq.includes('jq'), noJq);
        });
        it('jq missing: one SessionStart JSON value with a string additionalContext', () => {
            const v = single(noJq);
            assert.equal(v.hookSpecificOutput?.hookEventName, 'SessionStart');
            assert.equal(typeof v.hookSpecificOutput?.additionalContext, 'string');
        });
        it('sqlite3 missing: a TMB DEGRADED banner naming sqlite3', () => {
            const out = run({ path: stubDirWith('jq', 'git', 'node') }).stdout;
            assert.ok(out.includes('TMB DEGRADED'), out);
            assert.ok(out.includes('sqlite3'), out);
        });
        it('jq and git missing: both named in one banner', () => {
            const out = run({ path: stubDirWith('sqlite3', 'node') }).stdout;
            assert.ok(out.includes('jq'), out);
            assert.ok(out.includes('git'), out);
        });
    });
    describe('the offline note', () => {
        it('remotes with no URL: the offline note, as one SessionStart JSON value', () => {
            const out = run({ db: dbNoRemote }).stdout;
            assert.ok(out.includes('operating locally'), out);
            assert.ok(out.includes('remote/push ops are skipped'), out);
            assert.equal(single(out).hookSpecificOutput?.hookEventName, 'SessionStart');
        });
        it('a remote URL configured: no output', () => {
            assert.equal(run({ db: dbWithRemote }).stdout, '');
        });
        it('a registered repo with no repo_remotes rows: the offline note', () => {
            const out = run({ db: dbZeroRows }).stdout;
            assert.ok(out.includes('operating locally'), out);
        });
        it('node missing and no remote URL: both the DEGRADED banner and the offline note', () => {
            const out = run({ path: stubDirWith('jq', 'sqlite3', 'git'), db: dbNoRemote }).stdout;
            assert.ok(out.includes('TMB DEGRADED'), out);
            assert.ok(out.includes('operating locally'), out);
        });
    });
});
//# sourceMappingURL=substrate-preflight.test.js.map