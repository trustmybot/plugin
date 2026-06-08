#!/usr/bin/env bash
# Sandbox library for L5/L6 dogfood tests.
#
# Provides two functions:
#   tmb_test_sandbox_init <scratch_dir>
#   tmb_test_sandbox_teardown
#
# Init: prepends stubs/ to PATH (blocking gh, glab, git-remote-https/http),
#       redirects HOME to an isolated scratch dir, unsets all credential env vars,
#       creates a bare repo at $TMB_TEST_REMOTE for git push targets,
#       and points HTTP(S)_PROXY at a closed loopback port so stray HTTP falls over fast.
#
# Teardown: restores PATH and HOME from saved env vars. The scratch dir itself
#           is left for the caller (l5_cleanup_project) to remove.

tmb_test_sandbox_init() {
  local scratch="$1"
  local stubs_dir
  stubs_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/stubs" && pwd)"

  export TMB_SANDBOX_ORIG_PATH="$PATH"
  export PATH="$stubs_dir:$PATH"

  unset GH_TOKEN GITHUB_TOKEN GH_HOST GH_ENTERPRISE_TOKEN GH_ENTERPRISE_HOSTS 2>/dev/null || true
  unset GITLAB_TOKEN GL_TOKEN 2>/dev/null || true
  unset SSH_AUTH_SOCK SSH_AGENT_PID 2>/dev/null || true
  unset NPM_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY 2>/dev/null || true

  export TMB_SANDBOX_ORIG_HOME="$HOME"
  export HOME="$scratch/_home"
  mkdir -p "$HOME"
  cat > "$HOME/.gitconfig" <<'GITCFG'
[user]
  name = TMB Test
  email = test@tmb.invalid
[init]
  defaultBranch = main
GITCFG
  mkdir -p "$HOME/.ssh"

  export TMB_TEST_REMOTE="$scratch/_remote.git"
  git init --bare "$TMB_TEST_REMOTE" >/dev/null 2>&1

  # Cleaner failure for any git HTTPS push attempt: don't hang asking for a
  # credential prompt — exit immediately. The git-remote-https stub already
  # blocks the transport; this prevents the credential-prompt fallback noise
  # when stubs don't fire (e.g., older git binaries that resolve helpers earlier).
  export GIT_TERMINAL_PROMPT=0

  # Pin the trajectory DB path so hooks don't walk up and land on a different
  # DB when HOME is remapped. Every TMB hook honors TRAJECTORY_DB_PATH first
  # before falling back to walk-up; setting it here removes the ambiguity.
  export TRAJECTORY_DB_PATH="$scratch/.claude/tmb/trajectory.db"
}

tmb_test_sandbox_teardown() {
  export PATH="${TMB_SANDBOX_ORIG_PATH:-$PATH}"
  export HOME="${TMB_SANDBOX_ORIG_HOME:-$HOME}"
  unset TMB_SANDBOX_ORIG_PATH TMB_SANDBOX_ORIG_HOME TMB_TEST_REMOTE GIT_TERMINAL_PROMPT TRAJECTORY_DB_PATH 2>/dev/null || true
}
