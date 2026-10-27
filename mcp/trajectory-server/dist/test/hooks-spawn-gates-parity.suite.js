/**
 * Byte-for-byte parity of the TypeScript task-DB Agent-spawn gates with their
 * scripts/hooks/<gate>.sh (GH 1692): require-task-spec, require-spawn-effort
 * and require-feature-branch-active, over tests/fixtures/hook-corpus/<gate>/.
 * Both sides must give the same exit code, stdout and stderr.
 *
 * The sandbox holds a project repo with an origin, a linked worktree and an
 * unlinked branch, whose trajectory DB carries tasks in every state the gates
 * judge (live and orphaned swe runs, spec-shape contracts and a waiver,
 * efforts, repos by name, by relative path and unregistered); a repo whose
 * main checkout holds a task branch; a remoteless repo; a workspace DB with two
 * repos and no git, with a reviewer_effort; a DB from before tasks.effort; and
 * a corrupt DB. A payload names the sandbox as @SANDBOX@ and a PATH without
 * some commands as @PATH_WITHOUT:<cmd>[,<cmd>]@; its corpus_env (null unsets),
 * corpus_expect (`empty` or a phrase of the stdout) and corpus_expect_stderr
 * are removed before the run. corpus_divergence marks a payload where the .sh
 * degrades for lack of a command and the gate does not: the sides are not
 * compared, the .sh is held to its own bash_code/bash_expect and the gate to
 * the expectations. The payload × locale runs split across
 * hooks-spawn-gates-parity.shard-<k>of<n>.test.ts (GH 1947); shard 1 also
 * runs the whole-corpus check.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || '/bin/bash';
const NOW = '2026-10-17T12:00:00.000Z';
const LONG_AGO = '2020-01-01T00:00:00.000Z';
const NBSP = String.fromCodePoint(0xa0);
export const SPAWN_GATES = ['require-feature-branch-active', 'require-spawn-effort', 'require-task-spec'];
const UNSET = [
    'TRAJECTORY_DB_PATH',
    'TMB_TEST_RUN_ID',
    'TMB_FORBID_LIVE_SYNC',
    'TMB_HOOKS_SQLITE',
    'TMB_ALLOW_BRANCH_MISMATCH',
    'CLAUDE_CONFIG_DIR',
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
};
function git(dir, ...args) {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
}
function repo(dir) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), 'repo\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
}
function trajectoryDb(path, setup) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
        db.exec(SCHEMA);
        db.exec("PRAGMA foreign_keys = OFF;");
        db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'spawn gates', 'open', ?, ?)").run(NOW, NOW);
        setup(db);
    }
    finally {
        db.close();
    }
}
function insertTasks(db, rows) {
    const insert = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, files, repo, effort, created_at, updated_at) VALUES (?, ?, ?, ?, 'd', ?, ?, ?, ?, ?, ?, ?)");
    const issue = db.prepare("INSERT OR IGNORE INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'spawn gates', 'open', ?, ?)");
    for (const t of rows) {
        issue.run(t.id, NOW, NOW);
        insert.run(t.id, t.id, t.branch, t.parent ?? null, t.status, t.spec ?? '## Spec\nDo the thing.', t.files ?? '[]', t.repo ?? null, t.effort ?? 'medium', NOW, NOW);
    }
}
function buildSandbox(s) {
    const project = join(s, 'project');
    repo(project);
    git(s, 'init', '-q', '--bare', 'project.git');
    git(project, 'remote', 'add', 'origin', join(s, 'project.git'));
    git(project, 'branch', 'feat/unlinked');
    git(project, 'branch', 'feat/stale');
    git(project, 'worktree', 'add', '-q', '-b', 'feat/linked', join(project, '.claude/worktrees/linked'));
    const onMain = join(s, 'onmain');
    repo(onMain);
    git(onMain, 'checkout', '-q', '-b', 'feat/onmain');
    repo(join(s, 'remoteless'));
    mkdirSync(join(s, 'workspace'));
    writeFileSync(join(s, 'bad.db'), 'this is not a sqlite database\n'.repeat(64));
    const old = new DatabaseSync(join(s, 'old.db'));
    old.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO tasks VALUES (1, 'pending');");
    old.close();
    trajectoryDb(join(project, '.claude/tmb/trajectory.db'), (db) => {
        const repos = db.prepare('INSERT INTO repos (name, path) VALUES (?, ?)');
        repos.run('project', project);
        repos.run('onmain', onMain);
        repos.run('remoteless', join(s, 'remoteless'));
        repos.run('rel', '../onmain');
        insertTasks(db, [
            { id: 1, branch: 'feat/linked', status: 'pending', parent: 'dev' },
            { id: 2, branch: 'feat/unlinked', status: 'pending', parent: 'dev', effort: 'high' },
            { id: 3, branch: 'feat/missing', status: 'pending', parent: 'dev' },
            { id: 4, branch: 'feat/live', status: 'running' },
            { id: 5, branch: 'feat/stale', status: 'running', effort: 'low' },
            { id: 6, branch: 'feat/linked', status: 'closed' },
            { id: 7, branch: 'feat/linked', status: 'pending', spec: '' },
            { id: 8, branch: 'feat/linked', status: 'running', files: '["mcp/src/schema.sql","README.md"]' },
            { id: 9, branch: 'feat/linked', status: 'running', spec: `## Spec\nAdd a new${NBSP}column foo.\n\n## Success Criteria\nWriter: task_create` },
            { id: 10, branch: 'feat/linked', status: 'running', spec: 'Add  column bar.\n> **Nullable:** legacy rows predate it' },
            { id: 11, branch: 'feat/linked', status: 'running', files: '["src/hooks/lib/db.ts"]' },
            { id: 12, branch: 'feat/linked', status: 'running', spec: 'Ship a new_tool.\n1. `Writer:` the tool handler\n- *Populated:* `count > 0`' },
            { id: 13, branch: 'feat/linked', status: 'running', spec: 'A new\ttable.\nWriter: **\nPopulated: SELECT count(*)' },
            { id: 14, branch: 'feat/onmain', status: 'pending', repo: 'onmain' },
            { id: 15, branch: 'feat/ghost', status: 'pending', repo: 'ghost' },
            { id: 16, branch: 'feat/nope', status: 'pending', repo: 'remoteless' },
            { id: 17, branch: 'feat/linked', status: 'running', files: 'not json', spec: 'plain work' },
            { id: 18, branch: 'feat/linked', status: 'running', files: '["db/migrations/001.sql"]', spec: 'Migrate.\nWriter: x\nPopulated: y' },
            { id: 19, branch: 'feat/onmain', status: 'pending', repo: 'rel' },
        ]);
        const run = db.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, spawn_id) VALUES (?, ?, 'swe', ?, ?, ?)");
        run.run(4, 4, NOW, null, 'agent-live');
        run.run(5, 5, LONG_AGO, null, null);
        run.run(5, 5, LONG_AGO, null, 'tool_use:toolu_01');
        run.run(5, 5, NOW, NOW, 'agent-done');
        db.prepare("INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (11, 'feat/linked', 'bro', 'spec_shape_gate_waived', 'waive', ?, ?)").run('{"task_id":"11","gate":"spec_shape","reason":"db.ts only moves a helper"}', NOW);
        db.prepare("INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (8, 'feat/linked', 'swe', 'spec_shape_gate_waived', 'not bro', ?, ?)").run('{"task_id":8,"gate":"spec_shape","reason":"swe cannot waive this"}', NOW);
    });
    trajectoryDb(join(s, 'workspace/.claude/tmb/trajectory.db'), (db) => {
        const repos = db.prepare('INSERT INTO repos (name, path) VALUES (?, ?)');
        repos.run('a', join(s, 'remoteless'));
        repos.run('b', onMain);
        const config = db.prepare('INSERT INTO plugin_config (key, value_json) VALUES (?, ?)');
        config.run('reviewer_effort', '"low"');
        config.run('swe_default_effort', '"extreme"');
        insertTasks(db, [{ id: 1, branch: 'feat/x', status: 'pending', effort: 'high' }]);
    });
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
function materialize(file, s, pathWithout) {
    const text = readFileSync(file, 'utf8')
        .replaceAll('@SANDBOX@', s)
        .replace(/@PATH_WITHOUT:([a-z0-9,]+)@/g, (_m, cmds) => pathWithout(cmds));
    const { corpus_env: env = {}, corpus_expect: expect = '', corpus_expect_stderr: expectStderr, corpus_divergence: divergence, ...payload } = JSON.parse(text);
    return { input: JSON.stringify(payload), env, expect, expectStderr, divergence };
}
function caseEnv(s, locale, extra) {
    const env = { ...process.env, ...GIT_ENV };
    for (const key of UNSET)
        delete env[key];
    Object.assign(env, {
        HOME: join(s, 'home'),
        CLAUDE_PROJECT_DIR: join(s, 'project'),
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
        LC_ALL: locale,
        PWD: join(s, 'project'),
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
function run(cmd, args, input, env, cwd) {
    const r = spawnSync(cmd, args, { input, env, cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error)
        throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr.replace(XCRUN_CACHE_NOISE, '') };
}
function holds(text, expect, what) {
    if (expect === 'empty')
        assert.equal(text, '', `${what}: empty`);
    else
        assert.ok(text.includes(expect), `${what} holds ${JSON.stringify(expect)}: ${text.slice(0, 600)}`);
}
function corpusFiles(gate) {
    const dir = join(CORPUS_ROOT, gate);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}
const cases = SPAWN_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));
export function spawnGatesParityShard(k, n) {
    describe(`spawn gates parity: bash vs node over a git and DB sandbox (shard ${k} of ${n})`, { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ || !HAVE_GIT) && 'the .sh side needs the sqlite3 CLI, jq and git' }, () => {
        let base;
        let s;
        const paths = new Map();
        const pathWithout = (cmds) => {
            const known = paths.get(cmds);
            if (known !== undefined)
                return known;
            let path = process.env.PATH ?? '';
            for (const cmd of cmds.split(','))
                path = noCmdPath(join(base, 'paths', cmds, cmd), cmd, path);
            paths.set(cmds, path);
            return path;
        };
        before(() => {
            base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-spawn-gates-parity-')));
            s = join(base, 'sandbox');
            mkdirSync(s);
            buildSandbox(s);
        });
        after(() => {
            rmSync(base, { recursive: true, force: true });
        });
        if (k === 1) {
            it(`every spawn gate has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
                for (const gate of SPAWN_GATES) {
                    const files = corpusFiles(gate);
                    assert.ok(files.length >= MIN_CORPUS, `${gate}: ${files.length} payloads`);
                    for (const f of files) {
                        const c = materialize(join(CORPUS_ROOT, gate, f), '/s', () => '');
                        assert.ok(c.expect !== '', `${gate}/${f}: corpus_expect`);
                        if (c.divergence)
                            assert.ok(c.divergence.why !== '' && c.divergence.bash_expect, `${gate}/${f}: divergence`);
                    }
                }
            });
        }
        for (const { gate, f, locale } of shardOf(cases, k, n)) {
            it(`${gate} / ${f} (LC_ALL=${locale})`, () => {
                const c = materialize(join(CORPUS_ROOT, gate, f), s, pathWithout);
                const env = caseEnv(s, locale, c.env);
                const cwd = join(s, 'project');
                const bash = run(BASH, [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c.input, env, cwd);
                const node = run(process.execPath, [HOOKS_BUNDLE, gate], c.input, env, cwd);
                if (c.divergence) {
                    assert.equal(bash.code, c.divergence.bash_code ?? 0, `.sh exit code (${c.divergence.why})`);
                    holds(bash.stdout, c.divergence.bash_expect ?? '', '.sh stdout');
                }
                else {
                    assert.equal(node.code, bash.code, 'exit code');
                    assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                    assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
                }
                assert.equal(node.code, 0, `exit code: ${node.stderr}`);
                holds(node.stdout, c.expect, 'stdout');
                if (c.expectStderr !== undefined)
                    holds(node.stderr, c.expectStderr, 'stderr');
            });
        }
    });
}
//# sourceMappingURL=hooks-spawn-gates-parity.suite.js.map