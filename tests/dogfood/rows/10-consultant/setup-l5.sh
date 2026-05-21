#!/usr/bin/env bash
# Pre-seed prior chain context: by step 10 the TODO CLI exists + the project
# has been onboarded with an auth service discussion (from step 8). Bro is
# asked whether to break the auth service out of the monolith — so we seed
# a minimal auth module and a scaling-bottleneck discussion that gives the
# consultant context.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/auth.py" <<'PY'
"""Session-token authentication co-located in the monolith."""
import secrets, os

_SECRET = os.environ.get("AUTH_SECRET", "dev-secret").encode()

def issue_token(user_id: str) -> str:
    return secrets.token_urlsafe(32)

def verify_token(token: str) -> str:
    return token  # stub
PY

(
  cd "$PROJECT" || exit 1
  git add src/auth.py
  git commit -qm 'feat: add auth module'
) >/dev/null

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Evaluate auth microservice extraction',
        'Traffic scaling is straining the monolith; auth is the hot path.',
        'open', datetime('now'), datetime('now'));
SQL
