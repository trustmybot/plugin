import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { onboardTools } from '../tools/onboard.js';
import { tempDB } from './helpers.js';

// No onboard test may reach the real ~/.claude (see onboard.test.ts).
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'onboard-sync-keep-home-'));
process.env['HOME'] = ISOLATED_HOME;
delete process.env['CLAUDE_PLUGIN_ROOT'];
delete process.env['CLAUDE_CONFIG_DIR'];

const GIT_ISOLATED_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tempDirs: string[] = [ISOLATED_HOME];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function dbWithGithubRepo(): TrajectoryDB {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-sync-keep-repo-'));
  tempDirs.push(dir);
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/acme/widget.git']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ISOLATED_ENV, timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
  }
  const db = tempDB();
  db.run(`INSERT INTO repos (path, name) VALUES (?, 'widget')`, [dir]);
  return db;
}

async function applyRemote(db: TrajectoryDB, extra: Record<string, unknown> = {}): Promise<unknown> {
  const tools = onboardTools(db);
  const result = (await tools.handlers['onboard_apply']({
    agent: 'bro',
    shape: 'remote',
    branching_model: 'github-flow',
    pr_target: 'main',
    remote: ['github'],
    ...extra,
  })) as { content: Array<{ text: string }> };
  const data = JSON.parse(result.content[0].text) as { ok: boolean; applied: { issue_sync: unknown } };
  assert.equal(data.ok, true);
  return data.applied.issue_sync;
}

function storedIssueSync(db: TrajectoryDB): unknown {
  const row = db.get<{ value_json: string }>("SELECT value_json FROM plugin_config WHERE key='issue_sync'");
  return row ? JSON.parse(row.value_json) : undefined;
}

describe('onboard_apply issue_sync omitted (GH 3326)', () => {
  it('re-onboard on shape=remote without issue_sync keeps a stored auto', async () => {
    const db = dbWithGithubRepo();
    db.run(`UPDATE plugin_config SET value_json = '"auto"' WHERE key = 'issue_sync'`);
    assert.equal(await applyRemote(db), 'auto');
    assert.equal(storedIssueSync(db), 'auto');
    db.close();
  });

  it('first onboard without issue_sync writes off over the schema seed', async () => {
    const db = dbWithGithubRepo();
    assert.equal(storedIssueSync(db), 'off');
    assert.equal(await applyRemote(db), 'off');
    assert.equal(storedIssueSync(db), 'off');
    db.close();
  });

  it('first onboard without issue_sync writes off when the key is unset', async () => {
    const db = dbWithGithubRepo();
    db.run(`DELETE FROM plugin_config WHERE key = 'issue_sync'`);
    assert.equal(await applyRemote(db), 'off');
    assert.equal(storedIssueSync(db), 'off');
    db.close();
  });

  it('an explicit off still overrides a stored auto', async () => {
    const db = dbWithGithubRepo();
    db.run(`UPDATE plugin_config SET value_json = '"auto"' WHERE key = 'issue_sync'`);
    assert.equal(await applyRemote(db, { issue_sync: 'off' }), 'off');
    assert.equal(storedIssueSync(db), 'off');
    db.close();
  });
});
