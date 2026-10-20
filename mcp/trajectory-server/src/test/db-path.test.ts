import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { resolveDbPath, resolvePluginName } from '../db.js';

const emptyHome = mkdtempSync(join(tmpdir(), 'empty-home-'));

function plantDb(root: string): void {
  mkdirSync(join(root, '.claude', 'tmb'), { recursive: true });
  const db = new DatabaseSync(join(root, '.claude', 'tmb', 'trajectory.db'));
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER)');
  db.close();
}

function makeFakePluginRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'fake-plugin-'));
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.0.0' }),
  );
  return root;
}

describe('resolveDbPath', () => {
  it('defaults to <cwd>/.claude/tmb/trajectory.db when no env override', () => {
    const cwd = '/some/project';
    const got = resolveDbPath({ env: {}, cwd, home: emptyHome });
    assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
  });

  it('honors TRAJECTORY_DB_PATH env override verbatim', () => {
    const got = resolveDbPath({
      env: { TRAJECTORY_DB_PATH: '/tmp/explicit/test.db' },
      cwd: '/some/project',
    });
    assert.equal(got, '/tmp/explicit/test.db');
  });

  it('honors :memory: as a sentinel via the env override', () => {
    const got = resolveDbPath({
      env: { TRAJECTORY_DB_PATH: ':memory:' },
      cwd: '/some/project',
    });
    assert.equal(got, ':memory:');
  });

  it('treats empty TRAJECTORY_DB_PATH as unset (falls back to default)', () => {
    const cwd = '/some/project';
    const got = resolveDbPath({ env: { TRAJECTORY_DB_PATH: '' }, cwd, home: emptyHome });
    assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
  });

  it('treats whitespace-only TRAJECTORY_DB_PATH as unset', () => {
    const cwd = '/some/project';
    const got = resolveDbPath({ env: { TRAJECTORY_DB_PATH: '   ' }, cwd, home: emptyHome });
    assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
  });

  it('channel isolation: tmb plugin → .claude/tmb/trajectory.db (issue #87)', () => {
    const root = makeFakePluginRoot('tmb');
    try {
      const cwd = '/some/project';
      const got = resolveDbPath({ env: { CLAUDE_PLUGIN_ROOT: root }, cwd, home: emptyHome });
      assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('channel isolation: tmb-rc plugin → .claude/tmb-rc/trajectory.db (issue #87)', () => {
    const root = makeFakePluginRoot('tmb-rc');
    try {
      const cwd = '/some/project';
      const got = resolveDbPath({ env: { CLAUDE_PLUGIN_ROOT: root }, cwd, home: emptyHome });
      assert.equal(got, join(cwd, '.claude', 'tmb-rc', 'trajectory.db'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('TRAJECTORY_DB_PATH override beats CLAUDE_PLUGIN_ROOT-derived name', () => {
    const root = makeFakePluginRoot('tmb-rc');
    try {
      const got = resolveDbPath({
        env: {
          CLAUDE_PLUGIN_ROOT: root,
          TRAJECTORY_DB_PATH: '/explicit/wins.db',
        },
        cwd: '/some/project',
      });
      assert.equal(got, '/explicit/wins.db');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The walk (no CLAUDE_PROJECT_DIR) finds the workspace-root DB from inside a
  // nested repo: the hook and the server must agree on it.
  it('walks up from cwd to find an existing .claude/<plugin>/trajectory.db', () => {
    const ws = mkdtempSync(join(tmpdir(), 'walk-up-'));
    try {
      plantDb(ws);
      const inner = join(ws, 'plugin', 'subdir');
      mkdirSync(inner, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: inner, home: emptyHome });
      assert.equal(got, join(ws, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('falls back to <cwd>/.claude/tmb/trajectory.db when no DB exists upwards', () => {
    const ws = mkdtempSync(join(tmpdir(), 'walk-up-fresh-'));
    try {
      const inner = join(ws, 'a', 'b');
      mkdirSync(inner, { recursive: true });
      const got = resolveDbPath({ env: {}, cwd: inner, home: emptyHome });
      assert.equal(got, join(inner, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('walks up from CLAUDE_PROJECT_DIR to the workspace DB above it (GH 1553)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'project-root-walk-'));
    try {
      plantDb(ws);
      const project = join(ws, 'a', 'b');
      mkdirSync(project, { recursive: true });
      const got = resolveDbPath({
        env: { CLAUDE_PROJECT_DIR: project },
        cwd: '/',
        home: emptyHome,
      });
      assert.equal(got, join(ws, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a standalone DB under CLAUDE_PROJECT_DIR beats the workspace DB above it (GH 1553)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'project-root-standalone-'));
    try {
      plantDb(ws);
      const project = join(ws, 'a', 'b');
      plantDb(project);
      writeFileSync(join(project, '.claude', 'tmb', 'standalone'), '');
      const got = resolveDbPath({
        env: { CLAUDE_PROJECT_DIR: join(project, 'src') },
        cwd: '/',
        home: emptyHome,
      });
      assert.equal(got, join(project, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('falls back to <CLAUDE_PROJECT_DIR>/.claude/tmb/trajectory.db when no DB exists upwards', () => {
    const ws = mkdtempSync(join(tmpdir(), 'project-root-fresh-'));
    try {
      const project = join(ws, 'project');
      mkdirSync(project, { recursive: true });
      const got = resolveDbPath({
        env: { CLAUDE_PROJECT_DIR: project },
        cwd: '/',
        home: emptyHome,
      });
      assert.equal(got, join(project, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // P0: the walk must NOT adopt a stale ~/.claude/<plugin>/trajectory.db when
  // the user launched from a real project below HOME.
  it('does NOT walk into HOME from a descendant cwd, even if HOME has a DB (P0)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'fake-home-'));
    try {
      plantDb(fakeHome);
      const project = join(fakeHome, 'work', 'my-project');
      mkdirSync(project, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: project, home: fakeHome });

      assert.notEqual(got, join(fakeHome, '.claude', 'tmb', 'trajectory.db'));
      assert.equal(got, join(project, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('still walks up to the workspace root when the workspace is below HOME', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'fake-home-'));
    try {
      const ws = join(fakeHome, 'workspace');
      plantDb(ws);
      const inner = join(ws, 'plugin', 'subdir');
      mkdirSync(inner, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: inner, home: fakeHome });

      assert.equal(got, join(ws, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // No .git stop: the TMB workspace layout keeps the DB above the repo's .git.
  it('walks past a .git boundary to the workspace DB above a nested repo', () => {
    const ws = mkdtempSync(join(tmpdir(), 'git-ws-'));
    try {
      plantDb(ws);
      const repo = join(ws, 'plugin');
      mkdirSync(join(repo, '.git'), { recursive: true });
      const inner = join(repo, 'src');
      mkdirSync(inner, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: inner, home: emptyHome });
      assert.equal(got, join(ws, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('the outermost DB wins over a nested repo DB', () => {
    const ws = mkdtempSync(join(tmpdir(), 'outermost-'));
    try {
      plantDb(ws);
      const repo = join(ws, 'plugin');
      mkdirSync(join(repo, '.git'), { recursive: true });
      plantDb(repo);
      const inner = join(repo, 'src');
      mkdirSync(inner, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: inner, home: emptyHome });
      assert.equal(got, join(ws, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('resolves a worktree-root DB from within the worktree (.git FILE)', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'worktree-'));
    try {
      writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n');
      plantDb(worktree);
      const inner = join(worktree, 'src', 'deep');
      mkdirSync(inner, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: inner, home: emptyHome });
      assert.equal(got, join(worktree, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('when cwd === HOME, uses HOME-rooted .claude/<plugin>/trajectory.db (degenerate but explicit)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'fake-home-'));
    try {
      plantDb(fakeHome);

      const got = resolveDbPath({ env: {}, cwd: fakeHome, home: fakeHome });

      assert.equal(got, join(fakeHome, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('walks more than 8 levels (no level cap)', () => {
    const top = mkdtempSync(join(tmpdir(), 'deep-top-'));
    try {
      plantDb(top);
      const inner = join(top, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
      mkdirSync(inner, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: inner, home: emptyHome });
      assert.equal(got, join(top, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });
});

describe('resolvePluginName', () => {
  it('reads name from CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json', () => {
    const root = makeFakePluginRoot('my-custom-plugin');
    try {
      assert.equal(resolvePluginName({ CLAUDE_PLUGIN_ROOT: root }), 'my-custom-plugin');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns "tmb" fallback when CLAUDE_PLUGIN_ROOT is unset', () => {
    assert.equal(resolvePluginName({}), 'tmb');
  });

  it('returns "tmb" fallback when manifest is missing/unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'fake-plugin-no-manifest-'));
    try {
      assert.equal(resolvePluginName({ CLAUDE_PLUGIN_ROOT: root }), 'tmb');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns "tmb" fallback when manifest has no name field', () => {
    const root = mkdtempSync(join(tmpdir(), 'fake-plugin-no-name-'));
    mkdirSync(join(root, '.claude-plugin'));
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1' }));
    try {
      assert.equal(resolvePluginName({ CLAUDE_PLUGIN_ROOT: root }), 'tmb');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns "tmb" fallback when manifest is malformed JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'fake-plugin-bad-json-'));
    mkdirSync(join(root, '.claude-plugin'));
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), 'not json');
    try {
      assert.equal(resolvePluginName({ CLAUDE_PLUGIN_ROOT: root }), 'tmb');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
