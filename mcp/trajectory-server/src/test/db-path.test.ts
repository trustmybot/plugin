import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveDbPath, resolvePluginName } from '../db.js';

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
    const got = resolveDbPath({ env: {}, cwd });
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
    const got = resolveDbPath({ env: { TRAJECTORY_DB_PATH: '' }, cwd });
    assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
  });

  it('treats whitespace-only TRAJECTORY_DB_PATH as unset', () => {
    const cwd = '/some/project';
    const got = resolveDbPath({ env: { TRAJECTORY_DB_PATH: '   ' }, cwd });
    assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
  });

  it('channel isolation: tmb plugin → .claude/tmb/trajectory.db (issue #87)', () => {
    const root = makeFakePluginRoot('tmb');
    try {
      const cwd = '/some/project';
      const got = resolveDbPath({ env: { CLAUDE_PLUGIN_ROOT: root }, cwd });
      assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('channel isolation: tmb-rc plugin → .claude/tmb-rc/trajectory.db (issue #87)', () => {
    const root = makeFakePluginRoot('tmb-rc');
    try {
      const cwd = '/some/project';
      const got = resolveDbPath({ env: { CLAUDE_PLUGIN_ROOT: root }, cwd });
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

  // #2872: workspace-pattern projects keep the live DB at the workspace root
  // above the inner repos. The hook (PWD = inner repo) and MCP server (PWD =
  // workspace root) used to disagree; resolveDbPath now walks up to find
  // whichever one is real.
  it('walks up from cwd to find an existing .claude/<plugin>/trajectory.db (#2872)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'walk-up-'));
    try {
      // Plant the DB at the workspace root.
      mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
      writeFileSync(join(ws, '.claude', 'tmb', 'trajectory.db'), '');
      // Make a deeper inner-repo cwd. resolveDbPath called from there should
      // find the workspace-rooted DB, not invent a new path.
      const inner = join(ws, 'plugin', 'subdir');
      mkdirSync(inner, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: inner });
      assert.equal(got, join(ws, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('falls back to <cwd>/.claude/tmb/trajectory.db when no DB exists upwards (#2872)', () => {
    // Use a tmpdir we own so no parent has a real DB to find. We can't
    // guarantee /tmp doesn't have one, so plant a sibling-workspace and
    // verify resolveDbPath does NOT escape its own subtree.
    const ws = mkdtempSync(join(tmpdir(), 'walk-up-fresh-'));
    try {
      const inner = join(ws, 'a', 'b');
      mkdirSync(inner, { recursive: true });
      const got = resolveDbPath({ env: {}, cwd: inner });
      // The walk-up returns the first hit; since no .claude/tmb/trajectory.db
      // exists anywhere in this freshly-created subtree, the fallback path
      // (cwd-relative) is used.
      assert.equal(got, join(inner, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // P0: walk-up resolution must NOT adopt a stale ~/.claude/<plugin>/trajectory.db
  // when the user launched from a real project below HOME. Project state belongs
  // to a project, not the user's profile. Repro: a prior buggy session (or a
  // test artifact) left a DB at ~/.claude/tmb/trajectory.db; every later launch
  // walked up past HOME and silently adopted that file as the live DB.
  it('does NOT walk into HOME from a descendant cwd, even if HOME has a stale DB (P0)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'fake-home-'));
    try {
      // Plant a stale DB at the fake HOME — the exact shape the bug needed.
      mkdirSync(join(fakeHome, '.claude', 'tmb'), { recursive: true });
      writeFileSync(join(fakeHome, '.claude', 'tmb', 'trajectory.db'), '');

      // cwd is a project below fake HOME. The user clearly wants project-local
      // state, not the HOME leftover.
      const project = join(fakeHome, 'work', 'my-project');
      mkdirSync(project, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: project, home: fakeHome });

      // Must NOT pick up the HOME-rooted stale DB.
      assert.notEqual(got, join(fakeHome, '.claude', 'tmb', 'trajectory.db'));
      // Must fall back to a project-rooted path.
      assert.equal(got, join(project, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // Sibling guarantee for the P0 fix: workspace-pattern walk-up still works
  // when the workspace sits BELOW home — e.g. ~/work/myws/{inner}/...
  // (the issue #2872 case, only now correctly bounded).
  it('still walks up to the workspace root when the workspace is below HOME (#2872, post-P0)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'fake-home-'));
    try {
      const ws = join(fakeHome, 'workspace');
      mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
      writeFileSync(join(ws, '.claude', 'tmb', 'trajectory.db'), '');

      const inner = join(ws, 'plugin', 'subdir');
      mkdirSync(inner, { recursive: true });

      const got = resolveDbPath({ env: {}, cwd: inner, home: fakeHome });

      assert.equal(got, join(ws, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // Degenerate case: cwd === HOME. The user explicitly chose HOME as their
  // workspace. Walk-up checks the starting dir but doesn't traverse above it.
  it('when cwd === HOME, uses HOME-rooted .claude/<plugin>/trajectory.db (degenerate but explicit)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'fake-home-'));
    try {
      mkdirSync(join(fakeHome, '.claude', 'tmb'), { recursive: true });
      writeFileSync(join(fakeHome, '.claude', 'tmb', 'trajectory.db'), '');

      const got = resolveDbPath({ env: {}, cwd: fakeHome, home: fakeHome });

      assert.equal(got, join(fakeHome, '.claude', 'tmb', 'trajectory.db'));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
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
