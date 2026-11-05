/**
 * The ensure-swe-worktree l3 bash suite in node:test (GH 1692): the gate runs
 * as `node dist/hooks.js ensure-swe-worktree` from inside a fresh temp repo,
 * CLAUDE_PROJECT_DIR pinned to the sandbox and PWD set, with a schema.sql DB.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate } from './hook-sandbox.js';
import { DENY, gateEnv, git, hasNot, sql } from './git-push-guard-l3.js';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NO_DB = '/nonexistent.db';
describe('ensure-swe-worktree l3', () => {
    let sb;
    let repo;
    function newRepo(dir, feature) {
        mkdirSync(dir, { recursive: true });
        git(sb.env, dir, 'init', '-q', '-b', 'dev');
        writeFileSync(join(dir, 'README.md'), 'init\n');
        git(sb.env, dir, 'add', 'README.md');
        git(sb.env, dir, 'commit', '-qm', 'init');
        git(sb.env, dir, 'branch', feature);
        return dir;
    }
    function schemaDb(db) {
        mkdirSync(dirname(db), { recursive: true });
        const d = new DatabaseSync(db);
        try {
            d.exec(SCHEMA);
        }
        finally {
            d.close();
        }
        return db;
    }
    function insertTask(db, id, branch, taskRepo = null) {
        sql(db, "INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'))");
        sql(db, `INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, repo, created_at, updated_at)
         VALUES (?, 1, ?, ?, 'd', 'pending', '## body', ?, datetime('now'), datetime('now'))`, id, branch, `task ${id}`, taskRepo);
    }
    /** <repo> with its DB and task <id> on <branch>. */
    function setup(feature, id) {
        repo = newRepo(join(sb.dir, 'repo'), feature);
        const db = schemaDb(join(repo, '.claude/tmb/trajectory.db'));
        insertTask(db, id, feature);
        return db;
    }
    /** The gate's stdout + stderr for a spawn of <agent> with <prompt>, run from <repo>. */
    function runHook(agent, prompt, db = NO_DB, extra = {}) {
        const r = runGate('ensure-swe-worktree', {
            cwd: repo,
            input: JSON.stringify({ tool_input: { subagent_type: agent, prompt } }),
            env: { ...gateEnv(sb, repo), TRAJECTORY_DB_PATH: db, ...extra },
        });
        return r.stdout + r.stderr;
    }
    /** The `worktree` lines of <root>'s porcelain list ending in .claude/worktrees/<slug>. */
    function registered(root, slug) {
        return git(sb.env, root, 'worktree', 'list', '--porcelain')
            .split('\n')
            .filter((l) => l.startsWith('worktree ') && l.endsWith(`/.claude/worktrees/${slug}`)).length;
    }
    beforeEach(() => {
        sb = makeSandbox('ensure-wt');
    });
    afterEach(() => sb.remove());
    it('swe + task → worktree created at canonical slug', () => {
        const db = setup('fix/1-foo-bar', 1);
        const out = runHook('swe', 'task_id=1 You are SWE.', db);
        hasNot(out, DENY, 'prepare step must never deny');
        assert.equal(existsSync(join(repo, '.claude/worktrees/1-foo-bar')), true, 'canonical-slug worktree dir must exist');
        assert.equal(registered(repo, '1-foo-bar'), 1, 'worktree must be registered with git');
    });
    it('prefixed subagent_type (tmb:swe) is normalized and acts', () => {
        const db = setup('fix/2-baz', 2);
        runHook('tmb:swe', 'task_id=2 You are SWE.', db);
        assert.equal(existsSync(join(repo, '.claude/worktrees/2-baz')), true, 'tmb:swe must normalize to swe and create the worktree');
    });
    it('idempotent: re-run with the worktree present is a no-op (no error, still allowed)', () => {
        const db = setup('fix/1-foo-bar', 1);
        runHook('swe', 'task_id=1 You are SWE.', db);
        const out = runHook('swe', 'task_id=1 You are SWE.', db);
        hasNot(out, DENY, 'idempotent re-run must not deny');
        assert.ok(registered(repo, '1-foo-bar') >= 1, 'worktree must remain registered after re-run');
        assert.equal(registered(repo, '1-foo-bar'), 1, 'no duplicate worktree after idempotent re-run');
    });
    it('non-swe spawn → no-op (no worktree created, never denies)', () => {
        const db = setup('fix/1-foo-bar', 1);
        const out = runHook('code-reviewer', 'task_id=1 You are code-reviewer.', db);
        hasNot(out, DENY, 'non-swe must never deny');
        assert.equal(existsSync(join(repo, '.claude/worktrees/1-foo-bar')), false, 'non-swe spawn must not create a worktree');
    });
    it('no task_id in prompt → no-op + allow', () => {
        const db = setup('fix/1-foo-bar', 1);
        const out = runHook('swe', 'You are SWE but no task id here.', db);
        hasNot(out, DENY, 'missing task_id must never deny');
        assert.equal(existsSync(join(repo, '.claude/worktrees/1-foo-bar')), false, 'missing task_id must not create a worktree');
    });
    it('git worktree add fails (branch missing) → allow (fail-open)', () => {
        const db = setup('fix/1-foo-bar', 1);
        git(sb.env, repo, 'branch', '-D', 'fix/1-foo-bar');
        const out = runHook('swe', 'task_id=1 You are SWE.', db);
        hasNot(out, DENY, 'git-add failure must fail open (no deny)');
        assert.equal(existsSync(join(repo, '.claude/worktrees/1-foo-bar')), false, 'failed add must not leave a registered worktree');
    });
    it('bypass TMB_DISABLE_ENSURE_SWE_WORKTREE=1 → no-op', () => {
        const db = setup('fix/1-foo-bar', 1);
        const out = runHook('swe', 'task_id=1 You are SWE.', db, { TMB_DISABLE_ENSURE_SWE_WORKTREE: '1' });
        hasNot(out, DENY, 'bypass must never deny');
        assert.equal(existsSync(join(repo, '.claude/worktrees/1-foo-bar')), false, 'bypass must skip worktree creation');
    });
    it('TMB workspace shape: tasks.repo names a registered repo → worktree at that repo root', () => {
        const workspace = join(sb.dir, 'ws');
        repo = newRepo(join(workspace, 'plugin'), 'fix/3-widget');
        const innerRoot = git(sb.env, repo, 'rev-parse', '--show-toplevel');
        const db = schemaDb(join(workspace, '.claude/tmb/trajectory.db'));
        sql(db, "INSERT INTO repos (name, path) VALUES ('plugin', ?)", innerRoot);
        insertTask(db, 3, 'fix/3-widget', 'plugin');
        const out = runHook('swe', 'task_id=3 You are SWE.', db);
        hasNot(out, DENY, 'workspace-shape spawn must never deny');
        assert.equal(existsSync(join(innerRoot, '.claude/worktrees/3-widget')), true, 'worktree must be created under the named repo root');
        assert.equal(registered(innerRoot, '3-widget'), 1, 'worktree must be registered with git');
    });
    it('no DB → no-op + allow (not a TMB project)', () => {
        repo = newRepo(join(sb.dir, 'repo'), 'fix/1-foo-bar');
        const out = runHook('swe', 'task_id=1 You are SWE.', '/nonexistent/trajectory.db');
        hasNot(out, DENY, 'missing DB must never deny');
        assert.equal(existsSync(join(repo, '.claude/worktrees/1-foo-bar')), false, 'missing DB must not create a worktree');
    });
});
//# sourceMappingURL=ensure-swe-worktree-l3.test.js.map