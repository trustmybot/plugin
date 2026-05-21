#!/usr/bin/env bash
# Pre-seed prior chain context: by step 10 the TODO CLI exists (matches
# what step 05 SWE would produce in L6 chain). Seed the CLI + an open
# storage-scaling issue so the consultant has concrete code + a tracking
# issue to reference.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/cli.py" <<'PY'
"""TODO CLI — stdlib argparse + JSON storage at ~/.todo-cli/todos.json."""
import argparse
import json
import os
from pathlib import Path

STORE = Path(os.path.expanduser("~/.todo-cli/todos.json"))


def _load():
    if not STORE.exists():
        return []
    return json.loads(STORE.read_text())


def _save(items):
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2))
    tmp.replace(STORE)


def add(args):
    items = _load()
    items.append({"id": len(items) + 1, "text": args.text, "done": False})
    _save(items)


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("text"); a.set_defaults(func=add)
    args = p.parse_args()
    args.func(args)
PY

(
  cd "$PROJECT" || exit 1
  git add src/cli.py
  git commit -qm 'feat: todo CLI with JSON storage'
) >/dev/null

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Evaluate TODO CLI storage scale-out',
        'Team usage is rising; JSON-file storage is single-user. Open question on SQLite or small server.',
        'open', datetime('now'), datetime('now'));
SQL
