// L5 isolation setup for 21-move-milestone. Seeds the project's repo row,
// three open milestones (v0.1.0 < v0.2.0 < v0.3.0) and the count-subcommand
// issue on v0.1.0 at medium priority. "The next milestone" is v0.2.0.
import { basename } from 'node:path';
import { ensureSchema, setupArgs, withDb } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
const repo = basename(project);

// run-l5.ts seeds the DB before this script; a bare project gets the schema.
ensureSchema(project);

withDb(project, (db) => {
  db.exec('PRAGMA foreign_keys = ON;');
  db.prepare('INSERT OR IGNORE INTO repos (name, path) VALUES (?, ?)').run(repo, project);
  db.prepare(
    `INSERT OR IGNORE INTO milestones (name, repo, state) VALUES
  ('v0.1.0', ?1, 'open'),
  ('v0.2.0', ?1, 'open'),
  ('v0.3.0', ?1, 'open')`,
  ).run(repo);
  db.prepare(
    `INSERT INTO issues (objective, description, status, created_at, updated_at,
                    repo, milestone, labels)
VALUES ('Add count subcommand to todo CLI',
        'Add a count subcommand that prints the number of todo items.',
        'open', datetime('now'), datetime('now'),
        ?, 'v0.1.0', ?)`,
  ).run(repo, JSON.stringify(['Feature', 'Priority: Medium']));
});
