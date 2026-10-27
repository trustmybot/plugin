/**
 * Byte-for-byte parity of the TypeScript swe-boundary with
 * scripts/hooks/swe-boundary.sh (GH 1692) over
 * tests/fixtures/hook-corpus/swe-boundary/, in a sandbox project with three
 * worktrees and a trajectory DB: task 10 (files[] with mixed-case entries,
 * prompt_bearing 0, a git checkout on its branch), task 11 (prompt_bearing 1),
 * task 12 (a repo with no repos row) and task 13 (empty files[]), their spawn
 * transcripts, a corrupt DB and this session's scratchpad under
 * <canonical /tmp>/claude-<euid>. Each payload's `@SANDBOX@` is the sandbox
 * dir and `@SCRATCH@` the scratchpad; `corpus_env` overrides the env,
 * `corpus_record` is a Bash deny record dispatch.sh would have written for
 * rule (h), and `corpus_expect` is `allow`, `context:<phrase>` or a phrase of
 * the deny reason; all three are removed before the run. Both sides start
 * from the same state (no scope-note markers, the record rewritten), and must
 * write the same audit rows.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { shardOf } from './shard.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus/swe-boundary');
const HOOK_SH = join(PLUGIN_ROOT, 'scripts/hooks/swe-boundary.sh');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 40;
const SCRATCH_SESSION = 'sb-parity-scratch-session';
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const NOW = '2026-10-11T10:00:00.000Z';
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
function write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}
export function buildSandbox(dir) {
    const project = join(dir, 'project');
    const wts = join(project, '.claude/worktrees');
    for (const rel of ['src/a.ts', 'src/b.ts', 'agents/swe.md', 'docs/guide.md', 'CLAUDE.md'])
        write(join(wts, 'sb-task', rel), 'a\n');
    git(join(wts, 'sb-task'), 'init', '-q', '-b', 'feat/sb-task');
    git(join(wts, 'sb-task'), 'add', '-A');
    git(join(wts, 'sb-task'), 'commit', '-qm', 'init');
    for (const rel of ['agents/swe.md', 'docs/CLAUDE.md', 'CLAUDE.md'])
        write(join(wts, 'sb-prompt', rel), 'a\n');
    mkdirSync(join(wts, 'sb-empty'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'bad.db'), 'this is not a sqlite database\n'.repeat(64));
    for (const n of [10, 11, 12, 13]) {
        write(join(dir, 'tr', `task-${n}.jsonl`), `{"message":{"content":[{"type":"text","text":"Implement task_id=${n} now."}]}}\n`);
    }
    write(join(dir, 'tr', 'task-none.jsonl'), '{"message":{"content":[{"type":"text","text":"no task named here"}]}}\n');
    write(join(dir, 'tr', 'main.jsonl'), '');
    const db = join(dir, 'db/trajectory.db');
    mkdirSync(dirname(db));
    const d = new DatabaseSync(db);
    try {
        d.exec(SCHEMA);
        d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
        d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (3, 'boundary', 'open', ?, ?)").run(NOW, NOW);
        const task = d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo, prompt_bearing, files) VALUES (?, 3, ?, 'd', 'running', ?, ?, ?, ?, ?)");
        task.run(10, 'feat/sb-task', NOW, NOW, 'project', 0, JSON.stringify(['src', 'docs/guide.md', 'tests/l3/', 'README.md', '_gen', 'Zeta']));
        task.run(11, 'feat/sb-prompt', NOW, NOW, 'project', 1, JSON.stringify(['agents']));
        d.exec('PRAGMA foreign_keys = OFF');
        task.run(12, 'feat/sb-orphan', NOW, NOW, 'ghost', 0, '[]');
        task.run(13, 'feat/sb-empty', NOW, NOW, 'project', 0, '[]');
    }
    finally {
        d.close();
    }
    const uid = process.geteuid?.() ?? 0;
    const scratchProject = join(realpathSync('/tmp'), `claude-${uid}`, `tmb-sb-parity-${basename(dir)}`);
    const scratch = join(scratchProject, SCRATCH_SESSION, 'scratchpad');
    mkdirSync(scratch, { recursive: true });
    return { dir, db, scratch, scratchProject };
}
export function materialize(file, sb) {
    const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', sb.dir).replaceAll('@SCRATCH@', sb.scratch);
    const { corpus_env: env = {}, corpus_record: record = null, corpus_expect: expect = '', ...payload } = JSON.parse(text);
    return { input: JSON.stringify(payload), env, record, expect };
}
/** The state a run starts from: no scope-note markers or deny records, then <record> as dispatch.sh writes it. */
export function resetState(sb, record, now) {
    rmSync(join(dirname(sb.db), 'locks'), { recursive: true, force: true });
    if (record === null)
        return;
    const at = record.at === 'now' ? String(now) : record.at;
    const digest = createHash('sha256').update(record.path, 'utf8').digest('hex');
    write(join(dirname(sb.db), 'locks/boundary-denies', record.session, digest), `${record.gate}\n${at}\n`);
}
function auditMark(db) {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
        return Number(d.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit').get().n);
    }
    finally {
        d.close();
    }
}
function auditRowsAfter(db, mark) {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
        return d
            .prepare('SELECT issue_id, branch_id, from_node, event_type, summary, content_json FROM audit WHERE id > ? ORDER BY id')
            .all(mark)
            .map((row) => ({ ...row }));
    }
    finally {
        d.close();
    }
}
function run(cmd, args, input, env, cwd) {
    const r = spawnSync(cmd, args, { input, env, cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error)
        throw r.error;
    return { code: r.status, stdout: r.stdout };
}
function checkExpectation(stdout, expect) {
    if (expect === 'allow') {
        assert.equal(stdout, '', 'allowed with no output');
        return;
    }
    const out = JSON.parse(stdout).hookSpecificOutput;
    if (expect.startsWith('context:')) {
        assert.equal(out.permissionDecision, undefined, 'a note, not a decision');
        assert.ok(out.additionalContext?.includes(expect.slice('context:'.length)), out.additionalContext);
        return;
    }
    assert.equal(out.permissionDecision, 'deny');
    assert.ok(out.permissionDecisionReason?.includes(expect), out.permissionDecisionReason);
}
const corpus = readdirSync(CORPUS)
    .filter((f) => f.endsWith('.json'))
    .sort();
const cases = corpus.flatMap((f) => LOCALES.map((locale) => ({ f, locale })));
export function sweBoundaryParityShard(k, n) {
    describe(`swe-boundary parity: bash vs node over a worktree and DB sandbox (shard ${k} of ${n})`, { skip: !HAVE_SQLITE_CLI && 'the .sh needs the sqlite3 CLI' }, () => {
        let sb;
        before(() => {
            sb = buildSandbox(realpathSync(mkdtempSync(join(tmpdir(), 'tmb-sb-parity-'))));
        });
        after(() => {
            rmSync(sb.dir, { recursive: true, force: true });
            rmSync(sb.scratchProject, { recursive: true, force: true });
        });
        if (k === 1) {
            it(`the corpus holds at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
                assert.ok(corpus.length >= MIN_CORPUS, `${corpus.length} payloads`);
                for (const f of corpus)
                    assert.notEqual(materialize(join(CORPUS, f), { dir: '/s', scratch: '/x' }).expect, '', f);
            });
        }
        for (const { f, locale } of shardOf(cases, k, n)) {
            it(`${f} (LC_ALL=${locale})`, () => {
                const { input, env: extra, record, expect } = materialize(join(CORPUS, f), sb);
                const env = {
                    ...process.env,
                    CLAUDE_PROJECT_DIR: join(sb.dir, 'project'),
                    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
                    TRAJECTORY_DB_PATH: sb.db,
                    LC_ALL: locale,
                    ...extra,
                };
                delete env.TMB_HOOKS_SQLITE;
                delete env.NODE_OPTIONS;
                const cwd = join(sb.dir, 'project');
                const now = Math.floor(Date.now() / 1000);
                resetState(sb, record, now);
                const start = auditMark(sb.db);
                const bash = run('bash', [HOOK_SH], input, env, cwd);
                const middle = auditMark(sb.db);
                resetState(sb, record, now);
                const node = run(process.execPath, [HOOKS_BUNDLE, 'swe-boundary'], input, env, cwd);
                assert.equal(node.code, bash.code, 'exit code');
                assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
                assert.deepEqual(auditRowsAfter(sb.db, middle), auditRowsAfter(sb.db, start).slice(0, middle - start), 'audit rows');
                assert.equal(bash.code, 0);
                checkExpectation(bash.stdout, expect);
            });
        }
    });
}
//# sourceMappingURL=hooks-swe-boundary-parity.suite.js.map