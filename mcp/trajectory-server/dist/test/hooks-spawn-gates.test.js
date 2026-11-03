/**
 * The TypeScript task-DB Agent-spawn gates (GH 1692): registry membership,
 * the effortDefaults port of tmb_effort_defaults, promptTaskId, and the
 * documented divergences from the .sh gates. With no jq or no sqlite3 CLI on
 * PATH the bash gates allow (require-spawn-effort denies "jq not found"); the
 * TS gates read the DB through node:sqlite and decide as usual.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { findGate, gateNames } from '../hooks/registry.js';
import { effortDefaults } from '../hooks/lib/effort.js';
import { GATE_READ_ERROR } from '../hooks/lib/db.js';
import { promptTaskId, requireTaskSpec } from '../hooks/require-task-spec.js';
import { requireSpawnEffort } from '../hooks/require-spawn-effort.js';
import { requireFeatureBranchActive } from '../hooks/require-feature-branch-active.js';
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const NOW = '2026-10-26T09:00:00.000Z';
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
};
let sandbox;
let seq = 0;
function git(dir, ...args) {
    const r = spawnSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}
function freshDb(setup = () => { }) {
    seq += 1;
    const path = join(sandbox, `case-${seq}`, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
        db.exec(SCHEMA);
        setup(db);
    }
    finally {
        db.close();
    }
    return path;
}
function config(db, key, valueJson) {
    db.prepare('INSERT INTO plugin_config (key, value_json) VALUES (?, ?)').run(key, valueJson);
}
function task(db, id, fields) {
    db.prepare("INSERT OR IGNORE INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', ?, ?)").run(id, NOW, NOW);
    db.prepare("INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, effort, repo, created_at, updated_at) VALUES (?, ?, ?, 'dev', 'd', ?, '## Spec\nDo it.', ?, ?, ?, ?)").run(id, id, fields.branch ?? `feat/${id}`, fields.status ?? 'running', fields.effort ?? 'medium', fields.repo ?? null, NOW, NOW);
}
const payload = (subagent, prompt, effort) => JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: subagent, prompt, ...(effort === undefined ? {} : { effort }) },
});
function denyReason(stdout) {
    assert.notEqual(stdout, '', 'expected a deny');
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
}
/** A PATH holding git and nothing else: no jq, no sqlite3. */
function gitOnlyPath() {
    const bin = join(sandbox, 'git-only-bin');
    mkdirSync(bin, { recursive: true });
    const which = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    if (!existsSync(join(bin, 'git')))
        symlinkSync(which, join(bin, 'git'));
    return bin;
}
function gateEnv(db, path) {
    return { PATH: path, HOME: join(sandbox, 'home'), TRAJECTORY_DB_PATH: db };
}
describe('task-DB Agent-spawn gates (TS)', () => {
    before(() => {
        sandbox = mkdtempSync(join(tmpdir(), 'tmb-spawn-gates-'));
    });
    after(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });
    it('registers all three, so the build lists them in dist/hooks-gates.txt', () => {
        assert.equal(findGate('require-task-spec'), requireTaskSpec);
        assert.equal(findGate('require-spawn-effort'), requireSpawnEffort);
        assert.equal(findGate('require-feature-branch-active'), requireFeatureBranchActive);
        for (const name of ['require-task-spec', 'require-spawn-effort', 'require-feature-branch-active']) {
            assert.ok(gateNames().includes(name), name);
        }
    });
    describe('effortDefaults', () => {
        it('reads medium|high with no plugin_config rows', () => {
            assert.equal(effortDefaults(freshDb(), {}), 'medium|high');
        });
        it('reads the configured swe_default_effort and reviewer_effort', () => {
            const db = freshDb((d) => {
                config(d, 'swe_default_effort', '"low"');
                config(d, 'reviewer_effort', '"medium"');
            });
            assert.equal(effortDefaults(db, {}), 'low|medium');
        });
        it('falls back per key on a value outside low|medium|high or invalid JSON', () => {
            const db = freshDb((d) => {
                config(d, 'swe_default_effort', '"extreme"');
                config(d, 'reviewer_effort', 'not json');
            });
            assert.equal(effortDefaults(db, {}), 'medium|high');
        });
        it('returns __ERR__ when the DB cannot be read', () => {
            const bad = join(sandbox, 'corrupt.db');
            writeFileSync(bad, 'this is not a sqlite database\n'.repeat(64));
            assert.equal(effortDefaults(bad, {}), GATE_READ_ERROR);
        });
    });
    it('promptTaskId takes the first task_id=<N> or task_id: <N>', () => {
        assert.equal(promptTaskId('task_id=12 then task_id=3'), '12');
        assert.equal(promptTaskId('task_id:  7 go'), '7');
        assert.equal(promptTaskId('no id here'), '');
    });
    describe('divergence: no jq and no sqlite3 CLI on PATH', () => {
        it('require-task-spec still denies a task id with no tasks row (bash allows)', async () => {
            const db = freshDb((d) => task(d, 1, {}));
            const env = gateEnv(db, gitOnlyPath());
            assert.deepEqual(await requireTaskSpec(payload('swe', 'task_id=1'), env), { stdout: '', code: 0 });
            assert.match(denyReason((await requireTaskSpec(payload('swe', 'task_id=99'), env)).stdout), /task_id=99 does not exist in the tasks table/);
        });
        it('require-spawn-effort still decides on tasks.effort (bash denies "jq not found", or allows with no sqlite3)', () => {
            const db = freshDb((d) => task(d, 2, { effort: 'high' }));
            const env = gateEnv(db, gitOnlyPath());
            assert.deepEqual(requireSpawnEffort(payload('swe', 'task_id=2', 'high'), env), { stdout: '', code: 0 });
            const reason = denyReason(requireSpawnEffort(payload('swe', 'task_id=2', 'medium'), env).stdout);
            assert.match(reason, /task_id=2 \(tasks\.effort\) runs at effort "high"/);
            assert.doesNotMatch(reason, /jq not found/);
        });
        it('require-feature-branch-active still denies a missing branch (bash allows)', async () => {
            const repo = join(sandbox, 'repo');
            mkdirSync(repo, { recursive: true });
            git(repo, 'init', '-q', '-b', 'dev');
            git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
            git(repo, 'branch', 'feat/present');
            const db = freshDb((d) => {
                d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('only', repo);
                task(d, 3, { branch: 'feat/present', status: 'pending' });
                task(d, 4, { branch: 'feat/absent', status: 'pending' });
            });
            const env = gateEnv(db, gitOnlyPath());
            assert.deepEqual(await requireFeatureBranchActive(payload('swe', 'task_id=3'), env), { stdout: '', code: 0 });
            assert.match(denyReason((await requireFeatureBranchActive(payload('swe', 'task_id=4'), env)).stdout), /needs branch feat\/absent to exist first .*branch feat\/absent dev/);
        });
    });
});
//# sourceMappingURL=hooks-spawn-gates.test.js.map