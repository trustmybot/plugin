#!/usr/bin/env bash
# L5 isolation setup for 18-spec-shape-gate: a todo CLI backed by a SQLite
# store whose schema lives in src/schema.sql, plus a registered repo. A task
# that touches src/schema.sql trips the require-task-spec Writer:/Populated:
# contract at swe spawn.
set -euo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
DB="$PROJECT/.claude/tmb/trajectory.db"

# Outside the runner, build the scratch project it would have: its own git
# repo (never an enclosing one) and a schema-only trajectory DB.
if [ "$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null)" != "$(cd "$PROJECT" && pwd -P)" ]; then
  git -C "$PROJECT" init -q -b main
  git -C "$PROJECT" config user.email l6@l6.test
  git -C "$PROJECT" config user.name "L5 Test"
  printf '.claude/\n' > "$PROJECT/.gitignore"
  git -C "$PROJECT" add .gitignore
  git -C "$PROJECT" commit -qm init
fi
if [ ! -f "$DB" ]; then
  mkdir -p "$(dirname "$DB")"
  sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
fi

mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/schema.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS todos (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    text  TEXT    NOT NULL,
    done  INTEGER NOT NULL DEFAULT 0
);
SQL
cat > "$PROJECT/src/cli.py" <<'PY'
"""TODO CLI: stdlib argparse + SQLite store in todos.db at the project root."""
import argparse
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "todos.db"
SCHEMA = Path(__file__).resolve().parent / "schema.sql"


def _connect():
    conn = sqlite3.connect(STORE)
    conn.executescript(SCHEMA.read_text())
    return conn


def add(args):
    with _connect() as conn:
        conn.execute("INSERT INTO todos (text) VALUES (?)", (args.text,))


def list_items(args):
    with _connect() as conn:
        for id_, text, done in conn.execute("SELECT id, text, done FROM todos ORDER BY id"):
            print(f"{id_}. [{'x' if done else ' '}] {text}")


def main():
    p = argparse.ArgumentParser(prog="todo")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("text")
    a.set_defaults(func=add)
    sub.add_parser("list").set_defaults(func=list_items)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
PY
printf 'todos.db\n' >> "$PROJECT/.gitignore"
git -C "$PROJECT" add .gitignore src/schema.sql src/cli.py
git -C "$PROJECT" commit -qm 'feat: todo CLI with a SQLite store'

REPO_NAME="$(basename "$PROJECT")"
sqlite3 "$DB" <<SQL
INSERT OR IGNORE INTO repos (name, path, target_branch, branching_model, protected_branches)
VALUES ('$REPO_NAME', '$PROJECT', 'main', 'github-flow', '["main"]');
SQL
