#!/usr/bin/env bash
# L5 isolation setup for 10-consultant (two-phase scenario).
# Phase 1: /tmb:agent-create cto triggers Branch B template-copy.
# Phase 2: cto evaluates src/auth.py — SQLite vs Postgres for the auth service.
#
# Ensures .claude/agents/cto.md is absent so Branch B runs.
# Seeds src/auth.py (matches what step 05 SWE produces in L6 chain context;
# in L5 isolation this is the substitute for chain progression).
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

# Remove cto.md if a prior chain step left it (L5 isolation = fresh slate)
rm -f "$PROJECT/.claude/agents/cto.md"

mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/auth.py" <<'PY'
#!/usr/bin/env python3
"""SQLite-backed session store for an auth service."""
import sqlite3
import threading
from pathlib import Path

DB = Path("auth.db")
_lock = threading.Lock()


def init():
    with sqlite3.connect(DB) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions "
            "(id INTEGER PRIMARY KEY, user_id TEXT, token TEXT, created_at TEXT)"
        )


def create_session(user_id: str, token: str) -> int:
    with _lock, sqlite3.connect(DB) as conn:
        cur = conn.execute(
            "INSERT INTO sessions (user_id, token, created_at) VALUES (?, ?, datetime('now'))",
            (user_id, token),
        )
        return cur.lastrowid


def verify_session(token: str) -> str | None:
    with sqlite3.connect(DB) as conn:
        row = conn.execute(
            "SELECT user_id FROM sessions WHERE token=?", (token,)
        ).fetchone()
        return row[0] if row else None


def revoke_session(token: str):
    with _lock, sqlite3.connect(DB) as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))


if __name__ == "__main__":
    init()
    print("auth db ready")
PY

(
  cd "$PROJECT" || exit 1
  git add src/auth.py
  git commit -qm "feat: add SQLite auth service substrate"
) >/dev/null

# Pre-seed an open issue (L5 isolation only; in L6 chain, plenty of open
# issues exist by step 10 from earlier chain steps). The Phase 2 prompt
# tells bro to use the most recent open issue's id.
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Auth service storage choice', 'SQLite vs Postgres for the embedded auth service', 'open', datetime('now'), datetime('now'));
SQL
