/**
 * Parity of the TypeScript post-atomic-close-readme gate with
 * scripts/hooks/post-atomic-close-readme.sh (GH 1692), over
 * tests/fixtures/hook-corpus/post-atomic-close-readme/. Both sides must exit
 * alike, print the same stdout and stderr byte for byte and leave the same
 * audit rows, timestamps masked.
 *
 * The sandbox is a workspace whose trajectory DB registers one repo, `project`.
 * Its main checkout is on main, a linear history committed at a fixed date,
 * every README.md in it backdated to 2000 so the .sh's mtime test is
 * deterministic; a feat/gh-2044 branch it has not checked out adds and edits
 * READMEs and a dist/ file. Tasks 1-11 close on those commits, on bad or
 * unknown SHAs and under other repo names. The DB is copied from a template
 * before each side runs. A payload names the sandbox as @SANDBOX@ and the PATH
 * without jq or without the sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@;
 * corpus_env (null unsets) and corpus_expect (`empty`, or a phrase of stdout
 * and stderr) are removed before the run. A payload with corpus_divergent
 * names a divergence decision 703 allows: corpus_expect is then { bash, ts }
 * and the two sides must differ. The payload × locale (C, en_US.UTF-8) runs
 * split across hooks-readme-staleness-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
const HAVE_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const GATE = 'post-atomic-close-readme';
const T1 = '2026-10-01T10:00:00.000Z';
const COMMIT_DATE = '2026-01-01T00:00:00Z';
const README_MTIME = new Date('2000-01-01T00:00:00Z');
const ISO_TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const UNSET = ['TRAJECTORY_DB_PATH', 'TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'TMB_HOOKS_SQLITE', 'TMB_DB_WRITE_RUN_BUDGET_MS', 'TMB_DB_WRITE_TIMEOUT_MS', 'LANG', 'LC_CTYPE', 'LC_COLLATE'];
export const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: COMMIT_DATE,
    GIT_COMMITTER_DATE: COMMIT_DATE,
};
function git(dir, ...args) {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
    return r.stdout.trim();
}
function put(root, files) {
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
}
/** Writes <files> under <repo> and commits them; returns the commit's SHA. */
export function commit(repo, message, files) {
    put(repo, files);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', message);
    return git(repo, 'rev-parse', 'HEAD');
}
export function initRepo(repo) {
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
}
/** Backdates every README.md under <dir> (outside .git) to 2000. */
export function backdateReadmes(dir) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name);
        if (name.isDirectory() && name.name !== '.git')
            backdateReadmes(path);
        else if (name.isFile() && name.name === 'README.md')
            utimesSync(path, README_MTIME, README_MTIME);
    }
}
/** The project repo: main checked out, feat/gh-2044 not. */
export function buildProject(repo) {
    initRepo(repo);
    const base = commit(repo, 'init', {
        'README.md': '# project\n',
        'notes.txt': 'v1\n',
        'src/lib/README.md': '# src/lib\n',
        'src/lib/x.ts': 'export const x = 1;\n',
        'dashboard/README.md': '# dashboard\n',
        'dashboard/app.ts': 'export const app = 1;\n',
    });
    const root = commit(repo, 'root change', { 'notes.txt': 'v2\n' });
    const nested = commit(repo, 'nested change', { 'src/lib/x.ts': 'export const x = 2;\n' });
    const missing = commit(repo, 'docs without a README', { 'docs/page.txt': 'page\n' });
    const gh1792 = commit(repo, 'dashboard and its README', { 'dashboard/README.md': '# dashboard, revised\n', 'dashboard/app.ts': 'export const app = 2;\n' });
    const mixed = commit(repo, 'many dirs', {
        'notes.txt': 'v3\n',
        'src/lib/x.ts': 'export const x = 3;\n',
        'tools/run.sh': 'echo run\n',
        'Zeta/z.txt': 'z\n',
    });
    const dist = commit(repo, 'web and its build', { 'web/index.ts': 'export {};\n', 'web/dist/app.js': 'built\n' });
    git(repo, 'checkout', '-q', '-b', 'feat/gh-2044', base);
    commit(repo, 'a with a README', { 'a/README.md': '# a\n', 'a/f.txt': 'f\n' });
    const gh2044 = commit(repo, 'a/b README, a README edit, x/dist build', {
        'a/README.md': '# a, revised\n',
        'a/b/README.md': '# a/b\n',
        'a/b/g.txt': 'g\n',
        'x/dist/bundle.js': 'bundle\n',
    });
    git(repo, 'checkout', '-q', 'main');
    backdateReadmes(repo);
    return { root, nested, missing, gh1792, mixed, dist, gh2044 };
}
export function trajectoryDb(path, rows) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
        db.exec(SCHEMA);
        db.exec('PRAGMA foreign_keys = OFF;');
        rows(db);
    }
    finally {
        db.close();
    }
}
/** The workspace sandbox at <s>: ws/project, ws/.claude/tmb/trajectory.db (as template.db) and a DB-less dir. */
export function buildSandbox(s) {
    mkdirSync(join(s, 'home'), { recursive: true });
    mkdirSync(join(s, 'nodb'), { recursive: true });
    const project = join(s, 'ws/project');
    const c = buildProject(project);
    trajectoryDb(join(s, 'template.db'), (db) => {
        db.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
        db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'readme staleness', 'open', ?, ?)").run(T1, T1);
        const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, commit_sha, created_at, updated_at) VALUES (?, 7, ?, 'd', 'closed', ?, ?, ?, ?)");
        const rows = [
            [1, 'feat/root', 'project', c.root],
            [2, 'feat/nested', 'project', c.nested],
            [3, 'feat/missing', 'project', c.missing],
            [4, 'feat/gh-1792', 'project', c.gh1792],
            [5, 'feat/gh-2044', 'project', c.gh2044],
            [6, 'feat/mixed', 'project', c.mixed],
            [7, 'feat/bad-sha', 'project', 'not-a-sha'],
            [8, 'feat/no-sha', 'project', null],
            [9, 'feat/unknown-sha', 'project', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
            [10, 'feat/no-repo', null, c.root],
            [11, 'feat/ghost', 'ghost', c.root],
            [12, 'feat/dist', 'project', c.dist],
        ];
        for (const [id, branch, repo, sha] of rows)
            task.run(id, branch, repo, sha, T1, T1);
    });
}
export function resetDb(s) {
    const db = join(s, 'ws/.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    for (const side of ['', '-wal', '-shm', '-journal'])
        rmSync(`${db}${side}`, { force: true });
    copyFileSync(join(s, 'template.db'), db);
    return db;
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
function auditDump(db) {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
        const rows = d.prepare('SELECT issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at FROM audit ORDER BY id').all();
        return JSON.stringify(rows).replace(ISO_TIME, '<ts>');
    }
    finally {
        d.close();
    }
}
export function materialize(file, s, paths) {
    const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', s).replaceAll('@NOJQ_PATH@', paths.noJq).replaceAll('@NOSQLITE_PATH@', paths.noSqlite);
    const { corpus_env: env = {}, corpus_expect: expect = '', corpus_divergent: divergent, ...payload } = JSON.parse(text);
    return { input: JSON.stringify(payload), env, expect, divergent };
}
export function caseEnv(s, locale, extra) {
    const env = { ...process.env, ...GIT_ENV };
    for (const key of UNSET)
        delete env[key];
    Object.assign(env, {
        HOME: join(s, 'home'),
        CLAUDE_PROJECT_DIR: join(s, 'ws'),
        TRAJECTORY_DB_PATH: join(s, 'ws/.claude/tmb/trajectory.db'),
        LC_ALL: locale,
        PWD: join(s, 'ws'),
    });
    for (const [key, value] of Object.entries(extra)) {
        if (value === null)
            delete env[key];
        else
            env[key] = value;
    }
    return env;
}
/** macOS's git shim warns once per run under a sandbox that denies its per-user temp dir; the name is random. */
const XCRUN_CACHE_NOISE = /^git: error: couldn't create cache file '[^']*xcrun_db-[^']*' \(errno=Operation not permitted\)\n/gm;
function run(cmd, args, c, env, cwd) {
    const r = spawnSync(cmd, args, { input: c.input, env, cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error)
        throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr.replace(XCRUN_CACHE_NOISE, '') };
}
function assertExpect(side, observed, expect) {
    if (expect === 'empty')
        assert.equal(observed, '', `${side}: no output`);
    else
        assert.ok(observed.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${observed.slice(0, 900)}`);
}
export function corpusFiles() {
    const dir = join(CORPUS_ROOT, GATE);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}
const cases = corpusFiles().flatMap((f) => LOCALES.map((locale) => ({ f, locale })));
export function readmeStalenessParityShard(k, n) {
    describe(`post-atomic-close-readme parity: bash vs node over a git and DB sandbox (shard ${k} of ${n})`, { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ || !HAVE_GIT) && 'the .sh side needs the sqlite3 CLI, jq and git' }, () => {
        let base;
        let s;
        let paths;
        before(() => {
            base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-readme-staleness-parity-')));
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
                const files = corpusFiles();
                assert.ok(files.length >= MIN_CORPUS, `${GATE}: ${files.length} payloads`);
                for (const f of files) {
                    const { expect, divergent } = materialize(join(CORPUS_ROOT, GATE, f), '/s', { noJq: '', noSqlite: '' });
                    if (divergent === undefined)
                        assert.ok(typeof expect === 'string' && expect !== '', `${f}: an expectation`);
                    else
                        assert.ok(typeof expect === 'object' && divergent !== '' && expect.bash !== '' && expect.ts !== '', `${f}: a divergent case names why and expects each side`);
                }
            });
        }
        for (const { f, locale } of shardOf(cases, k, n)) {
            it(`${f} (LC_ALL=${locale})`, () => {
                const c = materialize(join(CORPUS_ROOT, GATE, f), s, paths);
                const env = caseEnv(s, locale, c.env);
                const cwd = join(s, 'ws');
                const db = resetDb(s);
                const bash = run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${GATE}.sh`)], c, env, cwd);
                const bashAudit = auditDump(db);
                resetDb(s);
                const node = run(process.execPath, [HOOKS_BUNDLE, GATE], c, env, cwd);
                const nodeAudit = auditDump(db);
                assert.equal(node.code, 0, `node exit: ${node.stderr}`);
                if (c.divergent === undefined) {
                    assert.equal(bash.code, node.code, `bash exit: ${bash.stderr}`);
                    assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                    assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
                    assert.equal(nodeAudit, bashAudit, 'the audit rows after the run');
                    assertExpect('bash', bash.stdout + bash.stderr, c.expect);
                }
                else {
                    const expect = c.expect;
                    assert.ok(node.stdout + node.stderr !== bash.stdout + bash.stderr || nodeAudit !== bashAudit, `divergent (${c.divergent}): the sides must differ`);
                    assertExpect('bash', bash.stdout + bash.stderr, expect.bash);
                    assertExpect('ts', node.stdout + node.stderr, expect.ts);
                }
            });
        }
    });
}
//# sourceMappingURL=hooks-readme-staleness-parity.suite.js.map