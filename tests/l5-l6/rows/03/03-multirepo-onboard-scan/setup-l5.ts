// Multi-repo onboard+scan scenario. Seeds two git repos under the session dir
// with DISTINCT remotes (repo-a → GitHub, repo-b → GitLab) so scan_run (#979)
// captures per-repo remotes into repo_remotes, and asserts the four repo-scoped
// keys never reappear in plugin_config (#980 — repos is the sole source of truth).
//
// `git remote add` / `git remote get-url` are pure local config — no transport —
// so the stubbed git-remote-http(s) helpers are never invoked and no network is
// touched. The bare TMB_TEST_REMOTE push target is irrelevant here.
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { git, setupArgs, sql, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);

function seedRepo(dir: string, remoteUrl: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'l6@l6.test']);
  git(dir, ['config', 'user.name', 'L5 Test']);
  writeFile(dir, 'README.md', `# ${basename(dir)}\n`);
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-qm', 'init']);
  git(dir, ['remote', 'add', 'origin', remoteUrl]);
}

seedRepo(join(project, 'repo-a'), 'git@github.com:acme/repo-a.git');
seedRepo(join(project, 'repo-b'), 'git@gitlab.com:acme/repo-b.git');

// Pre-seed the repos rows with workspace-wide policy (target_branch +
// branching_model + protected_branches). onboard applies policy via AskUserQuestion,
// which the test harness suppresses, so the policy columns are seeded here to stand
// in for the post-AUQ apply. scan_run upserts these rows by name (ON CONFLICT(name))
// and fills repo_remotes WITHOUT touching the policy columns, so the distinct
// per-repo remotes land while the seeded policy survives.
sql(
  project,
  `INSERT INTO repos (name, path, file_count, target_branch, branching_model, protected_branches)
VALUES
  ('repo-a', ?, 1, 'main', 'github-flow', '["main"]'),
  ('repo-b', ?, 1, 'main', 'github-flow', '["main"]')
ON CONFLICT(name) DO UPDATE SET
  path = excluded.path,
  target_branch = excluded.target_branch,
  branching_model = excluded.branching_model,
  protected_branches = excluded.protected_branches;`,
  [join(project, 'repo-a'), join(project, 'repo-b')],
);
