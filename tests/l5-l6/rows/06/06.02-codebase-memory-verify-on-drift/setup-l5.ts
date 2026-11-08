// Seed a stale world model + drift: README committed with v1 text,
// deep_scan_completed audit row written (proxy for "world model warm with
// v1 summary"), then README edited on disk without a commit.
// The pre-state mimics "world model from yesterday's README" — bro should
// detect the drift on the next scan.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { gitCommit, setupArgs, withDb, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
writeFile(project, 'src/foo.py', "def foo(): return 'v1'\n");
writeFile(project, 'README.md', "# project — v1\n\nReturns 'v1' from foo().\n");
gitCommit(project, ['.'], 'v1');
const seedHead = spawnSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const projectReal = realpathSync(project);

withDb(project, (db) => {
  db.prepare('INSERT OR REPLACE INTO repos (name, path) VALUES (?, ?)').run(basename(projectReal), projectReal);
  db.exec(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'setup: seeded stale world model', '{}', datetime('now'));`);
  db.prepare(`INSERT INTO plugin_config (key, value_json) VALUES ('last_verified_sha', ?)`).run(JSON.stringify(seedHead));
});

// Simulate drift: edit foo.py + README on disk, do not commit.
writeFile(project, 'src/foo.py', "def foo(): return 'v2-modified'\n");
writeFile(project, 'README.md', "# project — v2\n\nReturns 'v2-modified' from foo().\n");
