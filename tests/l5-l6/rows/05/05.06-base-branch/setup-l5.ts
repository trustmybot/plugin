// 05.06-base-branch L5 isolation: seeds repos.target_branch='dev' and creates the dev branch.
import { basename } from 'node:path';
import { git, setupArgs, sql } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
sql(
  project,
  `INSERT INTO repos (name, path, file_count, target_branch, branching_model, protected_branches)
VALUES (?, ?, 0, 'dev', 'gitflow', '["main","dev"]')
ON CONFLICT(name) DO UPDATE SET
  path = excluded.path,
  target_branch = excluded.target_branch,
  branching_model = excluded.branching_model,
  protected_branches = excluded.protected_branches;`,
  [basename(project), project],
);

if (git(project, ['rev-parse', '-q', '--verify', 'HEAD'], { quiet: true })) {
  git(project, ['checkout', '-q', '-b', 'dev']);
  if (!git(project, ['checkout', '-q', 'main'])) process.exit(1);
}
