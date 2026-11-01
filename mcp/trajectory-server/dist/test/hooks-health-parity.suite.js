/**
 * Byte-for-byte parity of the TypeScript health and drift hooks with their
 * scripts/hooks/<gate>.sh (GH 1692): mcp-health-check,
 * deferred-tools-drift-warn, substrate-preflight, ensure-gitignore and
 * bro-turn-usage, over tests/fixtures/hook-corpus/<gate>/. The sandbox is
 * restored from one template at the same path before each side runs, and
 * both sides must leave it alike (timestamps masked) besides giving the same
 * exit code and stdout, and for ensure-gitignore the same stderr.
 *
 * The sandbox holds a plugin root, install caches with installed_plugins.json
 * variants and settings files, git projects (one with a non-ASCII name) whose
 * trajectory DBs register repos and remotes, a DB away from any project, a
 * corrupt DB, a 1 MiB health log, tool dirs with fixed mtimes, bro transcripts
 * and pgrep/ps stubs (PGREP_OUT lists the pids pgrep prints; ps reads the
 * ps-table). A payload names the sandbox as @SANDBOX@ and a PATH without
 * some commands as @PATH_WITHOUT:<cmd>[,<cmd>]@; its corpus_env (null unsets),
 * corpus_cwd, corpus_stdin (raw stdin in place of the payload), corpus_code
 * (default 0), corpus_expect (`empty` or a phrase of the stdout),
 * corpus_expect_stderr and corpus_expect_tree (phrases of the sandbox after
 * the run, `!` for absent) are removed before the run. corpus_divergence
 * marks a payload where the .sh degrades for lack of a command and the gate
 * does not: the sides are not compared, the .sh is held to its own
 * bash_code/bash_expect/bash_expect_tree and the gate to the expectations.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { goldenBash, goldenRoots } from './golden.js';
import { shardOf } from './shard.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 6;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const HAVE_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || '/bin/bash';
const OLD = new Date('2020-01-01T00:00:00Z');
const NEW = new Date('2090-01-01T00:00:00Z');
const DAY_MS = 86_400_000;
export const HEALTH_GATES = [
    'bro-turn-usage',
    'deferred-tools-drift-warn',
    'ensure-gitignore',
    'mcp-health-check',
    'substrate-preflight',
];
const STDERR_GATES = new Set(['ensure-gitignore']);
const UNSET = [
    'TRAJECTORY_DB_PATH',
    'TMB_TEST_RUN_ID',
    'TMB_FORBID_LIVE_SYNC',
    'TMB_HOOKS_SQLITE',
    'TMB_INSTALLED_JSON',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_SESSION_ID',
    'TMB_MCP_PID_OVERRIDE',
    'TMB_MCP_START_OVERRIDE',
    'TMB_TOOL_DIR_OVERRIDE',
    'TMB_DRIFT_SELF_PID',
    'TMB_MCP_HEALTH_SAMPLES',
    'TMB_DISABLE_BRO_TURN_USAGE_HOOK',
    'LANG',
    'LC_CTYPE',
];
function write(path, content, mode) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode !== undefined)
        chmodSync(path, mode);
}
function stamp(path, when) {
    utimesSync(path, when, when);
}
function gitInit(dir) {
    mkdirSync(dir, { recursive: true });
    const r = spawnSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    assert.equal(r.status, 0, `git init ${dir}`);
}
function trajectoryDb(path, rows = () => { }) {
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
function repo(db, name, path, url) {
    db.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run(name, path);
    if (url !== undefined) {
        db.prepare("INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES (?, 'origin', 'github', ?, 1)").run(name, url);
    }
}
function installs(s) {
    const user = { scope: 'user', installPath: join(s, 'cache/main/1.0.0'), installedAt: '2026-01-01T00:00:00.000Z', version: '1.0.0' };
    const project = {
        scope: 'project',
        projectPath: join(s, 'project'),
        installPath: join(s, 'cache/dev/1.1.0'),
        installedAt: '2026-02-01T00:00:00.000Z',
    };
    const elsewhere = { ...project, projectPath: join(s, 'bare'), installedAt: '2026-03-01T00:00:00.000Z' };
    return {
        'user-only': { version: 2, plugins: { 'tmb@main': [user], 'acme@main': [{ ...user, version: '9.9.9' }] } },
        'user-and-project': { version: 2, plugins: { 'tmb@main': [user], 'tmb@dev': [project, elsewhere] } },
        dup: {
            version: 2,
            plugins: {
                'tmb@main': [user],
                'tmb@dev': [{ ...user, installPath: join(s, 'cache/dev/1.1.0'), version: '1.1.0' }, { ...project, version: '1.1.0' }],
                'tmb@zzz': [{ ...user, version: '3.0.0' }],
            },
        },
        'project-only': { version: 2, plugins: { 'tmb@dev': [project] } },
    };
}
const ASSISTANT = (id, ts, model, usage, content = [], extra = {}) => JSON.stringify({ isSidechain: false, timestamp: ts, ...extra, message: { id, model, role: 'assistant', usage, content } });
function transcripts(t) {
    const main = [
        JSON.stringify({ type: 'user', isSidechain: false, timestamp: '2026-10-01T10:00:00.5Z', message: { role: 'user', content: 'hi' } }),
        ASSISTANT('msg_1', '2026-10-01T10:00:01.123456Z', 'claude-opus-5-5', {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
        }, [{ type: 'text', text: 'ok' }]),
        ASSISTANT('msg_1', '2026-10-01T10:00:02Z', 'claude-opus-5-5', {
            input_tokens: 10,
            output_tokens: 7,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
        }, [{ type: 'tool_use', name: 'Read' }]),
        JSON.stringify({ isSidechain: true, timestamp: '2026-10-01T11:00:00Z', message: { id: 'side', model: 'x', usage: { output_tokens: 999 } } }),
        ASSISTANT('msg_2', '2026-10-01T10:05:00Z', 'claude-sonnet-5 (beta)', {
            input_tokens: 1,
            output_tokens: 3.7,
            cache_read_input_tokens: -5,
            cache_creation_input_tokens: 'many',
        }, [{ type: 'tool_use' }, { type: 'tool_use' }, { type: 'text' }]),
        ASSISTANT('msg_3', '2026-10-01T10:06:00Z', '<synthetic>', { output_tokens: 50 }),
        ASSISTANT('msg_4', 'yesterday', 'claude-opus-5-5', { output_tokens: 1000 }),
        '"a bare string line"',
    ].join('\n');
    write(join(t, 'main.jsonl'), `${main}\n`);
    write(join(t, 'synthetic-only.jsonl'), `${ASSISTANT('m', '2026-10-01T10:00:00Z', '<synthetic>', { output_tokens: 9 })}\n`);
    write(join(t, 'zero-out.jsonl'), `${ASSISTANT('m', '2026-10-01T10:00:00Z', 'claude-opus-5-5', { input_tokens: 9, output_tokens: 0 })}\n`);
    write(join(t, 'broken.jsonl'), `${ASSISTANT('m', '2026-10-01T10:00:00Z', 'm', { output_tokens: 1 })}\n{"half": \n`);
    write(join(t, 'tie.jsonl'), [
        ASSISTANT('a', '2026-10-02T00:00:00.1Z', 'b-model', { input_tokens: 2, output_tokens: 2 }),
        ASSISTANT('b', '2026-10-02T00:00:00.2Z', 'a-model', { input_tokens: 1, output_tokens: 3 }),
        ASSISTANT('c', '2026-10-02T00:00:00.3Z', 'Z-model', { input_tokens: 1, output_tokens: 3 }),
    ].join('\n'));
    write(join(t, 'über session.jsonl'), `${ASSISTANT('ü', '2026-10-03T08:00:00.000Z', 'claude-opus-5-5[1m]', { input_tokens: 4, output_tokens: 6 }, [], { uuid: 'u-1' })}\n`);
    write(join(t, 'no-ids.jsonl'), [
        JSON.stringify({ timestamp: '2026-10-04T00:00:00Z', uuid: 'u-a', message: { model: 'm1', usage: { output_tokens: 4 } } }),
        JSON.stringify({ timestamp: '2026-10-04T00:00:01Z', message: { model: 'm1', usage: { output_tokens: 4 } } }),
        JSON.stringify({ timestamp: '2026-10-04T00:00:02Z', message: { model: 'm1', usage: { output_tokens: 4 } } }),
    ].join('\n'));
}
const PS_TABLE = [
    ['500', '400', '', '', 'bash /x/hook.sh'],
    ['400', '1', '', '', '/usr/local/bin/claude --resume'],
    ['600', '400', '3600', '01:00:00', 'node /p/mcp/trajectory-server/dist/index.js'],
    ['610', '400', '', '01-02:03:04', 'node /p/mcp/trajectory-server/dist/index.js'],
    ['620', '400', '', '08:09', 'node /p/mcp/trajectory-server/dist/index.js'],
    ['630', '400', '08', '', 'node /p/mcp/trajectory-server/dist/index.js'],
    ['640', '400', '', '', 'node /p/mcp/trajectory-server/dist/index.js'],
    ['700', '800', '3600', '01:00:00', 'node /q/mcp/trajectory-server/dist/index.js'],
    ['800', '1', '', '', 'claude'],
    ['900', '1', '', '', '-zsh'],
]
    .map((r) => `${r.join('\t')}\n`)
    .join('');
const PS_STUB = `#!/bin/sh
field="$2"; pid="$4"
awk -F'\\t' -v p="$pid" -v f="$field" '$1 == p { found = 1
  if (f == "ppid=") print $2; else if (f == "etimes=") print $3; else if (f == "etime=") print $4; else if (f == "command=") print $5 }
  END { exit !found }' "\${PS_TABLE:?}"
`;
const PGREP_STUB = `#!/bin/sh
[ -n "\${PGREP_OUT:-}" ] || exit 1
for p in $PGREP_OUT; do echo "$p"; done
`;
/** The sandbox every case starts from, built once at <s>. */
export function buildSandbox(s) {
    rmSync(s, { recursive: true, force: true });
    mkdirSync(s, { recursive: true });
    write(join(s, 'plugin/.claude-plugin/plugin.json'), '{\n  "name": "tmb",\n  "version": "1.1.0"\n}\n');
    write(join(s, 'bin/pgrep'), PGREP_STUB, 0o755);
    write(join(s, 'bin/ps'), PS_STUB, 0o755);
    write(join(s, 'ps-table'), PS_TABLE);
    mkdirSync(join(s, 'home/.claude'), { recursive: true });
    mkdirSync(join(s, 'bare'));
    mkdirSync(join(s, 'notgit'));
    for (const dir of ['cache/main/1.0.0', 'cache/dev/1.1.0'])
        mkdirSync(join(s, dir), { recursive: true });
    for (const [name, body] of Object.entries(installs(s)))
        write(join(s, 'installs', `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
    write(join(s, 'installs/bad.json'), '{"plugins": {"tmb@main": [1, "two"]}}\n{ not json\n');
    write(join(s, 'home/.claude/settings.json'), '{"enabledPlugins": {"tmb@main": true, "tmb@zzz": true}}\n');
    const project = join(s, 'project');
    gitInit(project);
    gitInit(join(project, 'repos/données'));
    gitInit(join(s, 'repos-abs/plain'));
    write(join(s, 'repos-abs/plain/.gitignore'), 'dist/\n.claude\n');
    trajectoryDb(join(project, '.claude/tmb/trajectory.db'), (db) => {
        repo(db, 'project', project, '');
        repo(db, 'données', 'repos/données');
        repo(db, 'plain', join(s, 'repos-abs/plain'), 'https://example.test/plain.git');
        repo(db, 'gone', join(s, 'missing'));
        repo(db, 'notgit', join(s, 'notgit'));
    });
    write(join(project, '.claude/settings.json'), '{"enabledPlugins": {"tmb@dev": true}}\n');
    write(join(project, '.claude/settings.local.json'), '{"enabledPlugins": {"tmb@zzz": false}}\n');
    const sessions = join(project, '.claude/tmb/sessions');
    write(join(sessions, 'seen-session.install-notice'), '');
    write(join(sessions, 'old-session.install-notice'), '');
    stamp(join(sessions, 'old-session.install-notice'), new Date(Date.now() - 2 * DAY_MS));
    write(join(sessions, 'keep.persona'), '');
    stamp(join(sessions, 'keep.persona'), new Date(Date.now() - 2 * DAY_MS));
    const accented = join(s, 'projé');
    gitInit(accented);
    write(join(accented, '.gitignore'), 'café/\n');
    trajectoryDb(join(accented, '.claude/tmb/trajectory.db'), (db) => repo(db, 'projé', accented));
    const remote = join(s, 'remote');
    gitInit(remote);
    write(join(remote, '.gitignore'), '.claude/*\n');
    trajectoryDb(join(remote, '.claude/tmb/trajectory.db'), (db) => repo(db, 'remote', remote, 'git@example.test:org/remote.git'));
    gitInit(join(s, 'proj-append'));
    write(join(s, 'proj-append/.gitignore'), 'node_modules');
    gitInit(join(s, 'proj-ignored'));
    write(join(s, 'proj-ignored/.gitignore'), '# keep\n.claude/*\n');
    gitInit(join(s, 'proj-crlf'));
    write(join(s, 'proj-crlf/.gitignore'), '.claude/\r\n');
    const biglog = join(s, 'biglog');
    trajectoryDb(join(biglog, '.claude/tmb/trajectory.db'));
    write(join(biglog, '.claude/tmb/logs/mcp-health.log'), Buffer.alloc(1_048_577, 0x61));
    trajectoryDb(join(s, 'elsewhere/a/b/runs.db'), (db) => {
        db.prepare("INSERT INTO agent_runs (agent_type, session_id, tokens_in, tokens_out, root_dir, exit_reason) VALUES ('bro', 'existing-session', 1, 1, 'kept-root', 'failed')").run();
        db.prepare("INSERT INTO agent_runs (agent_type, session_id, tokens_in) VALUES ('swe', 'existing-session', 77)").run();
    });
    write(join(s, 'corrupt.db'), 'this is not a sqlite database\n'.repeat(64));
    transcripts(join(s, 'transcripts'));
    for (const dir of ['tools-new', 'tools-old', 'tools-ü'])
        mkdirSync(join(s, dir));
    const tool = (rel, when) => {
        write(join(s, rel), 'export {};\n');
        stamp(join(s, rel), when);
    };
    tool('tools-new/a.js', OLD);
    tool('tools-new/b.js', NEW);
    tool('tools-new/sub dir/c.js', NEW);
    tool('tools-new/d.txt', NEW);
    tool('tools-new/e.js.map', NEW);
    tool('tools-old/a.js', OLD);
    tool('tools-old/b.js', OLD);
    tool('tools-ü/naïve.js', NEW);
    tool('tools-ü/old.js', OLD);
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
const MASKS = [[/"ts":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"/g, '"ts":"<TS>"']];
function mask(text) {
    return MASKS.reduce((t, [re, to]) => t.replace(re, to), text);
}
function dumpDb(path) {
    let db;
    try {
        db = new DatabaseSync(path, { readOnly: true });
    }
    catch {
        return `sha256 ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
    try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
        const counts = tables.map(({ name }) => `${name}=${db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n}`);
        const runs = db.prepare('SELECT * FROM agent_runs ORDER BY id').all();
        return JSON.stringify({ counts: counts.join(','), agent_runs: runs });
    }
    catch {
        return `sha256 ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
    finally {
        db.close();
    }
}
/** Every path under <root> but bin/ and SQLite's side files, with file contents (DBs as their row counts and agent_runs), masked. */
export function snapshot(root) {
    const out = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name);
            const rel = relative(root, path);
            if (rel === 'bin' || name === '.git' || /-(wal|shm|journal)$/.test(name))
                continue;
            const st = lstatSync(path);
            if (st.isSymbolicLink())
                out.push(`${rel} -> ${readlinkSync(path)}`);
            else if (st.isDirectory()) {
                out.push(`${rel}/`);
                walk(path);
            }
            else if (name.endsWith('.db')) {
                out.push(`${rel}: ${dumpDb(path)}`);
            }
            else if (st.size > 65_536) {
                out.push(`${rel}: ${st.size} bytes sha256 ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
            }
            else {
                out.push(`${rel}: ${mask(readFileSync(path, 'utf8'))}`);
            }
        }
    };
    walk(root);
    return out;
}
export function materialize(file, s, pathWithout) {
    const text = readFileSync(file, 'utf8')
        .replaceAll('@SANDBOX@', s)
        .replace(/@PATH_WITHOUT:([a-z0-9,]+)@/g, (_m, cmds) => pathWithout(cmds));
    const { corpus_env: env = {}, corpus_cwd: cwd = 'project', corpus_stdin: stdin, corpus_code: code = 0, corpus_expect: expect = '', corpus_expect_stderr: expectStderr, corpus_expect_tree: expectTree = [], corpus_divergence: divergence, ...payload } = JSON.parse(text);
    return {
        input: Buffer.from(stdin ?? JSON.stringify(payload)),
        env,
        cwd: join(s, cwd),
        code,
        expect,
        expectStderr,
        expectTree,
        divergence,
    };
}
export function caseEnv(s, tmp, locale, extra, cwd) {
    const env = { ...process.env };
    for (const key of UNSET)
        delete env[key];
    Object.assign(env, {
        HOME: join(s, 'home'),
        CLAUDE_PROJECT_DIR: join(s, 'project'),
        CLAUDE_PLUGIN_ROOT: join(s, 'plugin'),
        PATH: `${join(s, 'bin')}:${process.env.PATH ?? ''}`,
        PGREP_OUT: '4242',
        PS_TABLE: join(s, 'ps-table'),
        TMB_INSTALLED_JSON: join(s, 'installs/none.json'),
        TMB_MCP_HEALTH_SAMPLES: '1',
        TMB_MCP_HEALTH_INTERVAL_S: '0',
        TMPDIR: tmp,
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
    const dir = mkdtempSync(join(tmpdir(), 'tmb-health-stdin-'));
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
function holds(text, expect, what) {
    if (expect === 'empty')
        assert.equal(text, '', `${what}: empty`);
    else
        assert.ok(text.includes(expect), `${what} holds ${JSON.stringify(expect)}: ${text.slice(0, 600)}`);
}
function treeHolds(tree, phrases, what) {
    const all = tree.join('\n');
    for (const p of phrases) {
        if (p.startsWith('!'))
            assert.ok(!all.includes(p.slice(1)), `${what}: no ${JSON.stringify(p.slice(1))}`);
        else
            assert.ok(all.includes(p), `${what}: has ${JSON.stringify(p)}`);
    }
}
export function corpusFiles(gate) {
    const dir = join(CORPUS_ROOT, gate);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}
const cases = HEALTH_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));
export function healthHooksParityShard(k, n) {
    describe(`health hooks parity: bash vs node over a restored sandbox (shard ${k} of ${n})`, { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ || !HAVE_GIT) && 'the .sh side needs the sqlite3 CLI, jq and git' }, () => {
        let base;
        let s;
        let template;
        let tmp;
        const paths = new Map();
        const pathWithout = (cmds) => {
            const known = paths.get(cmds);
            if (known !== undefined)
                return known;
            let path = `${join(s, 'bin')}:${process.env.PATH ?? ''}`;
            for (const cmd of cmds.split(','))
                path = noCmdPath(join(base, 'paths', cmds, cmd), cmd, path);
            paths.set(cmds, path);
            return path;
        };
        const restore = () => {
            rmSync(s, { recursive: true, force: true });
            cpSync(template, s, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        };
        before(() => {
            base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-health-parity-')));
            s = join(base, 'sandbox');
            template = join(base, 'template');
            tmp = join(base, 'tmp');
            mkdirSync(tmp);
            buildSandbox(s);
            cpSync(s, template, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        });
        after(() => {
            rmSync(base, { recursive: true, force: true });
        });
        if (k === 1) {
            it(`every health gate has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
                for (const gate of HEALTH_GATES) {
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
                const env = caseEnv(s, tmp, locale, c.env, c.cwd);
                const { tree: bashTree, ...bash } = goldenBash(gate, f, locale, goldenRoots({ '@SANDBOX@': s, '@BASE@': base }), () => {
                    restore();
                    return { ...run(BASH, [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c, env), tree: snapshot(s) };
                });
                restore();
                const node = run(process.execPath, [HOOKS_BUNDLE, gate], c, env);
                const nodeTree = snapshot(s);
                if (c.divergence) {
                    assert.equal(bash.code, c.divergence.bash_code ?? 0, `.sh exit code (${c.divergence.why})`);
                    holds(bash.stdout, c.divergence.bash_expect ?? '', '.sh stdout');
                    treeHolds(bashTree, c.divergence.bash_expect_tree ?? [], '.sh sandbox');
                }
                else {
                    assert.equal(node.code, bash.code, 'exit code');
                    assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                    assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
                    if (STDERR_GATES.has(gate))
                        assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
                }
                assert.equal(node.code, c.code, `exit code: ${node.stderr}`);
                holds(node.stdout, c.expect, 'stdout');
                if (c.expectStderr !== undefined)
                    holds(node.stderr, c.expectStderr, 'stderr');
                treeHolds(nodeTree, c.expectTree, 'sandbox');
            });
        }
    });
}
//# sourceMappingURL=hooks-health-parity.suite.js.map