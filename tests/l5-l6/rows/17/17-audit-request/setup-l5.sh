#!/usr/bin/env bash
# L5 isolation setup for 17-audit-request: a todo CLI whose "list" silently
# drops every item past the tenth, plus a 12-item store written by "add".
# Running "list" against the store shows the loss before any code is read.
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
cat > "$PROJECT/src/cli.py" <<'PY'
"""TODO CLI: stdlib argparse + JSON storage in todos.json at the project root."""
import argparse
import json
from pathlib import Path

STORE = Path(__file__).resolve().parent.parent / "todos.json"
PAGE = 10


def _load():
    return json.loads(STORE.read_text()) if STORE.exists() else []


def _save(items):
    STORE.write_text(json.dumps(items, indent=2) + "\n")


def add(args):
    items = _load()
    items.append({"id": len(items) + 1, "text": args.text, "done": False})
    _save(items)


def list_items(args):
    for item in _load()[:PAGE]:
        print(f"{item['id']}. [{'x' if item['done'] else ' '}] {item['text']}")


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

rm -f "$PROJECT/todos.json"
for text in "buy milk" "call mom" "file taxes" "fix bike" "book dentist" \
            "renew passport" "water plants" "pay rent" "clean garage" \
            "plan trip" "return library books" "update resume"; do
  python3 "$PROJECT/src/cli.py" add "$text"
done

git -C "$PROJECT" add src/cli.py todos.json
git -C "$PROJECT" commit -qm 'feat: todo CLI with add and list, seeded store'
