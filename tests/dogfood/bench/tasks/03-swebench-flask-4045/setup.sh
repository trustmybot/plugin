#!/usr/bin/env bash
# Clone Flask at the broken base commit + apply the test patch from
# the SWE-bench Lite entry `pallets__flask-4045`. The agent then has to
# edit src/flask/blueprints.py to make the new tests pass.
#
# Requires internet (clone). Fails loud if offline.
set -uo pipefail

PROJECT="${1:?project dir required}"
# shellcheck disable=SC2034
TASK_DIR="${2:-}"

REPO_URL="https://github.com/pallets/flask"
BASE_COMMIT="d8c37f43724cd9fb0cdda61c7ca6d92e8b1a3e98"

# Clone shallowly to keep the download small + fast. --branch by SHA needs
# a fetch step; clone main then fetch+checkout the specific commit.
if ! git clone --depth=1 "$REPO_URL" "$PROJECT/flask-src" 2>"$PROJECT/.setup.err"; then
  printf "❌ setup failed — could not clone %s. Check internet/proxy.\n" "$REPO_URL" >&2
  cat "$PROJECT/.setup.err" >&2 || true
  exit 1
fi

(
  cd "$PROJECT/flask-src" || exit 1
  git fetch --depth=1 origin "$BASE_COMMIT" 2>&1
  git checkout -q "$BASE_COMMIT"
) || {
  printf "❌ setup failed — could not check out base commit %s\n" "$BASE_COMMIT" >&2
  exit 1
}

# Vendor the test patch from SWE-bench: append two new tests to
# tests/test_blueprints.py that describe the contract the agent must
# enforce.
cat >> "$PROJECT/flask-src/tests/test_blueprints.py" <<'PY'


def test_dotted_name_not_allowed():
    """SWE-bench pallets__flask-4045: Blueprint names containing dots
    collide with the internal nested-blueprint naming scheme and must
    be rejected at construction time."""
    import pytest
    from flask import Blueprint
    with pytest.raises(ValueError):
        Blueprint("parent.child", __name__)


def test_empty_name_not_allowed():
    """SWE-bench pallets__flask-4045: An empty blueprint name is
    meaningless and must be rejected at construction time."""
    import pytest
    from flask import Blueprint
    with pytest.raises(ValueError):
        Blueprint("", __name__)
PY

# Move flask-src into the project root so the agent sees src/flask/
# at the standard location.
mv "$PROJECT/flask-src/"* "$PROJECT/flask-src/".* "$PROJECT/" 2>/dev/null || true
rmdir "$PROJECT/flask-src" 2>/dev/null || true

(
  cd "$PROJECT" || exit 1
  # Reinit git on the project (the clone's .git was inside flask-src).
  rm -rf .git
  git init -q -b main
  git config user.email bench@bench.test
  git config user.name "TMB Bench"
  git add -A
  git commit -qm "test: seed Flask SWE-bench pallets__flask-4045 (base + test patch)"
) >/dev/null
