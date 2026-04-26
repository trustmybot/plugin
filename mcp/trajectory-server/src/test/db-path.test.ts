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
