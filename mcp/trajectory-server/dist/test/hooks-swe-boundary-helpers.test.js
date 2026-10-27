/**
 * The helpers swe-boundary.ts ports from scripts/hooks/lib (GH 1692),
 * each checked against its bash original on the same input:
 * tmb_gh_mutation, tmb_is_prompt_surface_path, tmb_worktree_root_for_target,
 * tmb_resolve_task_id_for_target, tmb_path_digest and tmb_cmd_write_shapes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ghMutation, isPromptSurfacePath, writeShapes } from '../hooks/cmd-analysis/index.js';
import { sqlLikeEscape } from '../hooks/lib/db.js';
import { pathDigest, resolveTaskIdForTarget, worktreeRootForTarget } from '../hooks/lib/target-task.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIB = join(PLUGIN_ROOT, 'scripts/hooks/lib');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW = '2026-10-11T10:00:00.000Z';
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
};
/** `<fn> "$@"` after sourcing the libs swe-boundary.sh sources: its stdout as `$(...)` captures it, and its exit code. */
function bashLib(fn, args, env = process.env) {
    const script = `. "${LIB}/query-task.sh"; . "${LIB}/cmd-analysis.sh"; ${fn} "$@"`;
    const r = spawnSync('bash', ['-c', script, 'lib', ...args], { encoding: 'utf8', env });
    return { stdout: r.stdout.replace(/\n+$/, ''), code: r.status };
}
describe('swe-boundary helpers: the bash originals agree', () => {
    it('ghMutation matches tmb_gh_mutation', () => {
        const stmts = [
            'gh pr create --title x',
            'gh pr view 1',
            'gh pr list',
            'gh issue close 4',
            'gh issue comment 4 --body b',
            'gh api repos/o/r',
            'gh api -X POST repos/o/r/issues',
            'gh api --method=PATCH repos/o/r',
            'gh api -XDELETE repos/o/r',
            'glab mr merge 3',
            'glab mr view 3',
            'GH_TOKEN=x gh release create v1',
            '/usr/local/bin/gh repo delete o/r',
            'gh pr merge_1',
            'echo gh pr create',
            'gh',
            'gh auth status',
            'gh workflow run ci.yml',
            'gh label create bug',
            'gh pr review 3 --approve',
        ];
        for (const stmt of stmts)
            assert.equal(ghMutation(stmt), bashLib('tmb_gh_mutation', [stmt]).stdout, stmt);
    });
    it('writeShapes matches tmb_cmd_write_shapes', () => {
        assert.equal(writeShapes(), bashLib('tmb_cmd_write_shapes', []).stdout);
    });
    it('worktreeRootForTarget matches tmb_worktree_root_for_target', () => {
        for (const p of ['/a/.claude/worktrees/x/y/z', '/a/.claude/worktrees/x', '/a/.claude/worktrees/', '/a/b', 'rel/.claude/worktrees/s/t', '/a/.claude/worktrees/x/.claude/worktrees/y/z', '']) {
            assert.equal(worktreeRootForTarget(p), bashLib('tmb_worktree_root_for_target', [p]).stdout, p);
        }
    });
    it('sqlLikeEscape matches tmb_sql_like_escape', () => {
        for (const v of ['plain', 'a_b%c', "it's", 'back\\slash'])
            assert.equal(sqlLikeEscape(v), bashLib('tmb_sql_like_escape', [v]).stdout, v);
    });
    it('lib/db.ts is the one module defining taskBySlug and sqlLikeEscape (F203-2)', () => {
        const libDir = join(PLUGIN_ROOT, 'mcp/trajectory-server/src/hooks/lib');
        const definers = readdirSync(libDir)
            .filter((f) => f.endsWith('.ts'))
            .filter((f) => /^export function (taskBySlug|sqlLikeEscape)\b/m.test(readFileSync(join(libDir, f), 'utf8')));
        assert.deepEqual(definers, ['db.ts']);
    });
    describe('over a sandbox repo', () => {
        let dir;
        let db;
        let env;
        before(() => {
            dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-sb-helpers-')));
            db = join(dir, 'db/trajectory.db');
            env = { ...process.env, TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: join(dir, 'repo') };
            const repo = join(dir, 'repo');
            for (const rel of ['agents/a.md', 'skills/s/SKILL.md', 'src/a.ts', '.claude/rules/r.md', 'docs/CLAUDE.md']) {
                mkdirSync(dirname(join(repo, rel)), { recursive: true });
                writeFileSync(join(repo, rel), 'x\n');
            }
            spawnSync('git', ['init', '-q', '-b', 'main', repo], { env: GIT_ENV });
            for (const [slug, branch] of [
                ['by-branch', 'feat/by-branch'],
                ['by-slug', 'other/name'],
            ]) {
                const wt = join(repo, '.claude/worktrees', slug);
                mkdirSync(join(wt, 'agents'), { recursive: true });
                spawnSync('git', ['init', '-q', '-b', branch, wt], { env: GIT_ENV });
                writeFileSync(join(wt, 'agents/a.md'), 'x\n');
                spawnSync('git', ['-C', wt, 'add', '-A'], { env: GIT_ENV });
                spawnSync('git', ['-C', wt, 'commit', '-qm', 'init'], { env: GIT_ENV });
            }
            symlinkSync(join(repo, 'agents'), join(dir, 'agents-link'));
            mkdirSync(dirname(db));
            const d = new DatabaseSync(db);
            try {
                d.exec(SCHEMA);
                d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', ?, ?)").run(NOW, NOW);
                const task = d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, created_at, updated_at) VALUES (?, 1, ?, 'd', ?, ?)");
                task.run(4, 'feat/by-branch', NOW, NOW);
                task.run(5, 'feat/by-slug', NOW, NOW);
                task.run(6, 'fix/by-slug', NOW, NOW);
            }
            finally {
                d.close();
            }
            mkdirSync(join(dir, 'tr'));
            writeFileSync(join(dir, 'tr/spawn.jsonl'), '{"message":{"content":[{"type":"text","text":"task_id=9"}]}}\n');
        });
        after(() => {
            rmSync(dir, { recursive: true, force: true });
        });
        it('isPromptSurfacePath matches tmb_is_prompt_surface_path, with and without a root', () => {
            const repo = join(dir, 'repo');
            const wt = join(repo, '.claude/worktrees/by-branch');
            const cases = [
                ['agents/a.md', ''],
                ['./agents/a.md', ''],
                ['agents/a.txt', ''],
                ['skills/s/SKILL.md', ''],
                ['templates/x/y.md', ''],
                ['rules/r.md', ''],
                ['.claude/rules/r.md', ''],
                ['.claude/templates/r.md', ''],
                ['src/agents/a.md', ''],
                ['docs/CLAUDE.md', ''],
                ['GEMINI.md', ''],
                [`${repo}/agents/a.md`, ''],
                [`${repo}/src/a.ts`, ''],
                [`${repo}/src/agents/a.md`, ''],
                [`${repo}/docs/CLAUDE.md`, ''],
                [`${wt}/agents/a.md`, ''],
                [`${wt}/agents/a.md`, wt],
                [`${dir}/agents-link/a.md`, ''],
                [`${dir}/elsewhere/agents/a.md`, ''],
                ['/nonexistent/x/agents/a.md', ''],
                ['agents/a.md', wt],
            ];
            for (const [p, root] of cases) {
                const expected = bashLib('tmb_is_prompt_surface_path', [p, root], env).code === 0;
                assert.equal(isPromptSurfacePath(p, root, env), expected, `${p} root=${root}`);
            }
        });
        it('pathDigest matches tmb_path_digest, through a symlink too', () => {
            for (const p of [`${dir}/repo/agents/a.md`, `${dir}/agents-link/a.md`, `${dir}/repo/new/file`, '/']) {
                assert.equal(pathDigest(p), bashLib('tmb_path_digest', [p]).stdout, p);
            }
        });
        it('resolveTaskIdForTarget matches tmb_resolve_task_id_for_target: branch, slug, then transcript', { skip: !HAVE_SQLITE_CLI && 'the .sh needs the sqlite3 CLI' }, () => {
            const wts = join(dir, 'repo/.claude/worktrees');
            const withTranscript = JSON.stringify({ agent_transcript_path: join(dir, 'tr/spawn.jsonl') });
            const cases = [
                [`${wts}/by-branch/agents/a.md`, '{}'],
                [`${wts}/by-slug/agents/a.md`, '{}'],
                [`${wts}/nowhere/a.md`, withTranscript],
                [`${dir}/repo/src/a.ts`, withTranscript],
                [`${dir}/repo/src/a.ts`, '{}'],
            ];
            for (const [target, input] of cases) {
                const sh = bashLib('tmb_resolve_task_id_for_target', [target, input, db], env).stdout;
                assert.equal(resolveTaskIdForTarget(target, input, db, env), sh, target);
            }
            assert.equal(resolveTaskIdForTarget(`${wts}/by-branch/x`, '{}', db, env), '4');
            assert.equal(resolveTaskIdForTarget(`${wts}/by-slug/x`, '{}', db, env), '6');
            assert.equal(resolveTaskIdForTarget(`${dir}/repo/src/a.ts`, withTranscript, db, env), '9');
        });
    });
});
//# sourceMappingURL=hooks-swe-boundary-helpers.test.js.map