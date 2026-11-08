// Pre-seed an unsigned task in needs_validation status with a real commit
// on a feature branch — the substrate the push gate operates against.
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { git, gitCommit, setupArgs, withDb, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);

git(project, ['checkout', '-q', '-b', 'feat/seed-todo']);
writeFile(project, 'todo.py', 'print("todo")\n');
gitCommit(project, ['todo.py'], 'feat: seed todo CLI (#1)');
git(project, ['checkout', '-q', 'main']);

const seedSha = spawnSync('git', ['-C', project, 'rev-parse', 'feat/seed-todo'], { encoding: 'utf8' }).stdout.trim();
const repo = basename(project);
const verifyCmd = 'python3 todo.py | grep -x todo >/dev/null';

// Use AUTOINCREMENT (omit explicit id) so this scenario works both as an
// L5 unit (clean DB) and as an L6 chain step where IDs are already taken
// by prior rows. Substantive assertions key off branch_id, not numeric id.
withDb(project, (db) => {
  db.prepare(
    `INSERT OR IGNORE INTO repos (name, path, target_branch, branching_model, protected_branches)
VALUES (?, ?, 'main', 'github-flow', '["main"]')`,
  ).run(repo, project);

  db.exec(`INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Seed todo CLI (push-gate)', 'pre-seed for push-gate scenario', 'open',
        datetime('now'), datetime('now'));`);

  db.prepare(
    `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, status, commit_sha, repo, files, verification,
                   created_at, updated_at)
SELECT id, 'feat/seed-todo', 'main', 'Seed todo CLI',
       '## Success Criteria
- todo CLI prints todo
', '', 'needs_validation', ?1, ?2,
       ?3, ?4,
       datetime('now'), datetime('now')
FROM issues
WHERE objective = 'Seed todo CLI (push-gate)'
ORDER BY id DESC LIMIT 1`,
  ).run(seedSha, repo, JSON.stringify(['todo.py']), JSON.stringify([verifyCmd]));

  db.prepare(
    `INSERT INTO verification_runs (task_id, commit_sha, source, started_at,
                               finished_at, exit_code, budget_s, timed_out)
SELECT id, ?, 'gate', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 900, 0
FROM tasks
WHERE branch_id = 'feat/seed-todo'
ORDER BY id DESC LIMIT 1`,
  ).run(seedSha);

  db.prepare(
    `INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code,
                                       elapsed_s, output_tail)
VALUES (last_insert_rowid(), 0, ?, 0, 0.05, '')`,
  ).run(verifyCmd);
});
