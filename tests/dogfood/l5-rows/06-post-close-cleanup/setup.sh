#!/usr/bin/env bash
# Pre-seed src/auth.py and a file_registry row with a NULL summary so bro
# has something to Read and a registry row to update.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/auth.py" <<'PY'
"""Tiny session-token utility used by the API layer.

issue_token() returns a 32-byte URL-safe token bound to the user_id.
verify_token() parses and validates the same token, raising on tamper.
"""
import secrets, hmac, hashlib, base64, os

_SECRET = os.environ.get("AUTH_SECRET", "dev-secret-change-me").encode()

def issue_token(user_id: str) -> str:
    nonce = secrets.token_bytes(16)
    payload = f"{user_id}:".encode() + nonce
    sig = hmac.new(_SECRET, payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + sig).decode().rstrip("=")

def verify_token(token: str) -> str:
    raw = base64.urlsafe_b64decode(token + "==")
    payload, sig = raw[:-32], raw[-32:]
    expect = hmac.new(_SECRET, payload, hashlib.sha256).digest()
    if not hmac.compare_digest(expect, sig):
        raise ValueError("bad token signature")
    return payload.split(b":", 1)[0].decode()
PY

(
  cd "$PROJECT" || exit 1
  git add src/auth.py
  git commit -qm 'feat: add session-token utility'
) >/dev/null

# Compute md5 of the file content the same way file_registry_upsert would.
content_md5=$(md5 -q "$PROJECT/src/auth.py" 2>/dev/null || md5sum "$PROJECT/src/auth.py" | cut -d' ' -f1)

# Seed `repos` AND `file_registry` consistently. The post-read-summary-hint
# hook walks `repos` to convert the Read tool's absolute path back to a
# repo-relative path. Use the *physical* (symlink-resolved) project path
# because Read resolves symlinks: on macOS, mktemp returns
# /var/folders/.../tmb-l5-X but Read sees /private/var/folders/.../tmb-l5-X.
# The hook's prefix match needs the same canonical form.
PROJECT_REAL=$(cd "$PROJECT" && pwd -P)

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT OR REPLACE INTO repos (name, path, default_branch)
VALUES ('todo-cli', '$PROJECT_REAL', 'main');

INSERT INTO file_registry (repo, path, type, content_md5, summary, summary_updated_at)
VALUES ('todo-cli', 'src/auth.py', 'source', '$content_md5', NULL, NULL);
SQL
