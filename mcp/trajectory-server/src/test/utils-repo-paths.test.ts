import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { resolveDefaultRepoPath } from '../utils/repo-paths.js';

describe('resolveDefaultRepoPath', () => {
  it('workspace pattern: resolves dbPath to project root via tmb_default_repo', () => {
    const db = tempDB();
    db.run(
      `INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"plugin"')`,
    );
    const result = resolveDefaultRepoPath(db, '/foo/bar/baz/.claude/tmb/trajectory.db');
    assert.equal(result, '/foo/bar/baz/plugin');
    db.close();
  });

  it('single-repo fallback: no tmb_default_repo config returns undefined', () => {
    const db = tempDB();
    const result = resolveDefaultRepoPath(db, '/foo/bar/baz/.claude/tmb/trajectory.db');
    assert.equal(result, undefined);
    db.close();
  });

  it('empty dbPath returns undefined', () => {
    const db = tempDB();
    db.run(
      `INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"plugin"')`,
    );
    const result = resolveDefaultRepoPath(db, '');
    assert.equal(result, undefined);
    db.close();
  });

  it('malformed value_json returns undefined (catches JSON parse error)', () => {
    const db = tempDB();
    db.run(
      `INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', 'plugin')`,
    );
    const result = resolveDefaultRepoPath(db, '/foo/bar/baz/.claude/tmb/trajectory.db');
    assert.equal(result, undefined);
    db.close();
  });

  it('single-repo: returns repos.path verbatim when the row exists', () => {
    const db = tempDB();
    db.run(
      `INSERT INTO repos (name, path) VALUES ('my-repo', '/abs/path/to/my-repo')`,
    );
    db.run(
      `INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"my-repo"')`,
    );
    const result = resolveDefaultRepoPath(db, '/elsewhere/.claude/tmb/trajectory.db');
    // repos.path wins over the workspace synthesis — this is the bug fix.
    assert.equal(result, '/abs/path/to/my-repo');
    db.close();
  });
});
