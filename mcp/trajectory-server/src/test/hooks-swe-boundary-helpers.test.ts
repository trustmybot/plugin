/**
 * The swe-boundary helpers (GH 1692), each judged on the answers its shell
 * original gave on the same input, recorded once and frozen here:
 * ghMutation, isPromptSurfacePath, worktreeRootForTarget, sqlLikeEscape,
 * resolveTaskIdForTarget, pathDigest and writeShapes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ghMutation, isPromptSurfacePath, writeShapes } from '../hooks/cmd-analysis/index.js';
import { sqlLikeEscape } from '../hooks/lib/db.js';
import { pathDigest, resolveTaskIdForTarget, worktreeRootForTarget } from '../hooks/lib/target-task.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW = '2026-10-11T10:00:00.000Z';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

describe('swe-boundary helpers: the frozen shell answers agree', () => {
  it('ghMutation gives the frozen shell answers', () => {
    const cases: [string, string][] = [
      ['gh pr create --title x', 'pr create'],
      ['gh pr view 1', ''],
      ['gh pr list', ''],
      ['gh issue close 4', 'issue close'],
      ['gh issue comment 4 --body b', 'issue comment'],
      ['gh api repos/o/r', ''],
      ['gh api -X POST repos/o/r/issues', 'POST'],
      ['gh api --method=PATCH repos/o/r', 'PATCH'],
      ['gh api -XDELETE repos/o/r', 'DELETE'],
      ['glab mr merge 3', 'mr merge'],
      ['glab mr view 3', ''],
      ['GH_TOKEN=x gh release create v1', 'release create'],
      ['/usr/local/bin/gh repo delete o/r', 'repo delete'],
      ['gh pr merge_1', ''],
      ['echo gh pr create', ''],
      ['gh', ''],
      ['gh auth status', ''],
      ['gh workflow run ci.yml', ''],
      ['gh label create bug', 'label create'],
      ['gh pr review 3 --approve', 'pr review'],
    ];
    assert.equal(cases.length, 20);
    for (const [stmt, expected] of cases) assert.equal(ghMutation(stmt), expected, stmt);
  });

  it('writeShapes gives the frozen shell answer', () => {
    const shapes = [
      '>',
      '>>',
      '>|',
      '&>',
      'exec N>',
      'heredoc into a redirect',
      'tee',
      'tee -a',
      'sed -i',
      'perl -i',
      'dd of=',
      'truncate',
      'cp',
      'mv',
      'install',
      'rsync',
      'git mv',
      'ln',
      'mkdir',
      'rm',
      'touch',
      'tar -C / make -C / env -C / npm --prefix',
      'git commit / reset / checkout / stash / clean / bisect / submodule update / … in its -C dir or own dir',
      'git init <dir> / format-patch -o / archive -o / checkout-index --prefix',
      'python -c / node -e / perl -e / ruby -e with a write mode',
      'a program fed to python / node / perl / ruby / sh through a heredoc',
      'find -exec / -execdir / -ok / -delete / -fprint',
      'fd -x / -X',
      'xargs fed by find or fd',
    ];
    assert.equal(shapes.length, 29);
    assert.equal(writeShapes(), shapes.join(', '));
  });

  it('worktreeRootForTarget gives the frozen shell answers', () => {
    const cases: [string, string][] = [
      ['/a/.claude/worktrees/x/y/z', '/a/.claude/worktrees/x'],
      ['/a/.claude/worktrees/x', '/a/.claude/worktrees/x'],
      ['/a/.claude/worktrees/', '/a/.claude/worktrees/'],
      ['/a/b', ''],
      ['rel/.claude/worktrees/s/t', 'rel/.claude/worktrees/s'],
      ['/a/.claude/worktrees/x/.claude/worktrees/y/z', '/a/.claude/worktrees/x/.claude/worktrees/y'],
      ['', ''],
    ];
    assert.equal(cases.length, 7);
    for (const [p, expected] of cases) assert.equal(worktreeRootForTarget(p), expected, p);
  });

  it('sqlLikeEscape gives the frozen shell answers', () => {
    const cases: [string, string][] = [
      ['plain', 'plain'],
      ['a_b%c', 'a\\_b\\%c'],
      ["it's", "it''s"],
      ['back\\slash', 'back\\\\slash'],
    ];
    assert.equal(cases.length, 4);
    for (const [v, expected] of cases) assert.equal(sqlLikeEscape(v), expected, v);
  });

  it('lib/db.ts is the one module defining taskBySlug and sqlLikeEscape (F203-2)', () => {
    const libDir = join(PLUGIN_ROOT, 'mcp/trajectory-server/src/hooks/lib');
    const definers = readdirSync(libDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /^export function (taskBySlug|sqlLikeEscape)\b/m.test(readFileSync(join(libDir, f), 'utf8')));
    assert.deepEqual(definers, ['db.ts']);
  });

  describe('over a sandbox repo', () => {
    let dir: string;
    let db: string;
    let env: NodeJS.ProcessEnv;
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
      } finally {
        d.close();
      }
      mkdirSync(join(dir, 'tr'));
      writeFileSync(join(dir, 'tr/spawn.jsonl'), '{"message":{"content":[{"type":"text","text":"task_id=9"}]}}\n');
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('isPromptSurfacePath gives the frozen shell answers, with and without a root', async () => {
      const repo = join(dir, 'repo');
      const wt = join(repo, '.claude/worktrees/by-branch');
      const cases: [string, string, boolean][] = [
        ['agents/a.md', '', true],
        ['./agents/a.md', '', true],
        ['agents/a.txt', '', false],
        ['skills/s/SKILL.md', '', true],
        ['templates/x/y.md', '', true],
        ['rules/r.md', '', true],
        ['.claude/rules/r.md', '', true],
        ['.claude/templates/r.md', '', false],
        ['src/agents/a.md', '', false],
        ['docs/CLAUDE.md', '', true],
        ['GEMINI.md', '', false],
        [`${repo}/agents/a.md`, '', true],
        [`${repo}/src/a.ts`, '', false],
        [`${repo}/src/agents/a.md`, '', false],
        [`${repo}/docs/CLAUDE.md`, '', true],
        [`${wt}/agents/a.md`, '', true],
        [`${wt}/agents/a.md`, wt, true],
        [`${dir}/agents-link/a.md`, '', true],
        [`${dir}/elsewhere/agents/a.md`, '', true],
        ['/nonexistent/x/agents/a.md', '', true],
        ['agents/a.md', wt, true],
      ];
      assert.equal(cases.length, 21);
      for (const [p, root, expected] of cases) assert.equal(await isPromptSurfacePath(p, root, env), expected, `${p} root=${root}`);
    });

    it('pathDigest gives the shell recipe: sha256 of the canonical path, through a symlink too', () => {
      const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
      const cases: [string, string][] = [
        [`${dir}/repo/agents/a.md`, sha256(realpathSync(`${dir}/repo/agents/a.md`))],
        [`${dir}/agents-link/a.md`, sha256(realpathSync(`${dir}/repo/agents/a.md`))],
        [`${dir}/repo/new/file`, sha256(join(realpathSync(`${dir}/repo`), 'new/file'))],
        ['/', '8a5edab282632443219e051e4ade2d1d5bbc671c781051bf1437897cbdfea0f1'],
      ];
      assert.equal(cases.length, 4);
      for (const [p, expected] of cases) assert.equal(pathDigest(p), expected, p);
      assert.equal(pathDigest(`${dir}/agents-link/a.md`), pathDigest(`${dir}/repo/agents/a.md`));
    });

    it('resolveTaskIdForTarget gives the frozen shell answers: branch, slug, then transcript', async () => {
      const wts = join(dir, 'repo/.claude/worktrees');
      const withTranscript = JSON.stringify({ agent_transcript_path: join(dir, 'tr/spawn.jsonl') });
      const cases: [string, string, string][] = [
        [`${wts}/by-branch/agents/a.md`, '{}', '4'],
        [`${wts}/by-slug/agents/a.md`, '{}', '6'],
        [`${wts}/nowhere/a.md`, withTranscript, '9'],
        [`${dir}/repo/src/a.ts`, withTranscript, '9'],
        [`${dir}/repo/src/a.ts`, '{}', ''],
      ];
      assert.equal(cases.length, 5);
      for (const [target, input, expected] of cases) assert.equal(await resolveTaskIdForTarget(target, input, db, env), expected, target);
      assert.equal(await resolveTaskIdForTarget(`${wts}/by-branch/x`, '{}', db, env), '4');
      assert.equal(await resolveTaskIdForTarget(`${wts}/by-slug/x`, '{}', db, env), '6');
      assert.equal(await resolveTaskIdForTarget(`${dir}/repo/src/a.ts`, withTranscript, db, env), '9');
    });
  });
});
