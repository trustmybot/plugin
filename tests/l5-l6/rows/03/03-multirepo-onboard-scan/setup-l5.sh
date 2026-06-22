#!/usr/bin/env bash
# Multi-repo onboard+scan scenario. Seeds two git repos under the session dir
# with DISTINCT remotes (repo-a → GitHub, repo-b → GitLab) so scan_run (#979)
# captures per-repo remotes into repos.remotes, and asserts the four repo-scoped
# keys never reappear in plugin_config (#980 — repos is the sole source of truth).
#
# `git remote add` / `git remote get-url` are pure local config — no transport —
# so the stubbed git-remote-http(s) helpers are never invoked and no network is
# touched. The bare TMB_TEST_REMOTE push target is irrelevant here.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use.
SCENARIO_DIR="$2"

GH_URL="git@github.com:acme/repo-a.git"
GL_URL="git@gitlab.com:acme/repo-b.git"

seed_repo() {
  local dir="$1" remote_url="$2"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email l6@l6.test
  git -C "$dir" config user.name "L5 Test"
  echo "# $(basename "$dir")" > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -qm init
  git -C "$dir" remote add origin "$remote_url"
}

seed_repo "$PROJECT/repo-a" "$GH_URL"
seed_repo "$PROJECT/repo-b" "$GL_URL"

# Pre-seed the repos rows with workspace-wide policy (target_branch +
# branching_model + protected_branches). onboard applies policy via AskUserQuestion,
# which the test harness suppresses, so the policy columns are seeded here to stand
# in for the post-AUQ apply. scan_run upserts these rows by name (ON CONFLICT(name))
# and fills repos.remotes WITHOUT touching the policy columns, so the distinct
# per-repo remotes land while the seeded policy survives.
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT INTO repos (name, path, file_count, target_branch, branching_model, protected_branches, remotes)
VALUES
  ('repo-a', '$PROJECT/repo-a', 1, 'main', 'github-flow', '["main"]', NULL),
  ('repo-b', '$PROJECT/repo-b', 1, 'main', 'github-flow', '["main"]', NULL)
ON CONFLICT(name) DO UPDATE SET
  path = excluded.path,
  target_branch = excluded.target_branch,
  branching_model = excluded.branching_model,
  protected_branches = excluded.protected_branches;
SQL
