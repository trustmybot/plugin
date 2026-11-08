// Seeds a failed task + failure discussion. Triggers task_retry composite
// + tmb_planning §Step 5 retry.
import { setupArgs, sql } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
sql(
  project,
  `INSERT INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (1, 'Seed todo CLI', 'pre-seed for swe-retry flow', 'open',
        datetime('now'), datetime('now'));
INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, description,
                   status, created_at, updated_at)
VALUES (1, 1, 'feat/seed-todo', 'main', 'Seed todo CLI',
        'Implement todo.py CLI', 'failed',
        datetime('now'), datetime('now'));
INSERT INTO discussions (issue_id, author, kind, body, created_at)
VALUES (1, 'bro', 'note',
        'verification failed: tests crashed on import — module path is wrong',
        datetime('now'));`,
);
