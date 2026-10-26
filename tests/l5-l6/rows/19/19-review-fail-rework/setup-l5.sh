#!/usr/bin/env bash
# L5 isolation setup for 19-review-fail-rework: a closed "count subcommand"
# task whose commit code-reviewer failed (count prints the store's character
# count, not its item count), with its branch, its linked worktree, the swe
# run that worked there and the FAIL validation row. Bro reopens the task,
# swe reworks it in the same worktree, code-reviewer reviews it again.
set -euo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
DB="$PROJECT/.claude/tmb/trajectory.db"
BRANCH="feat/add-count-subcommand"
WT="$PROJECT/.claude/worktrees/add-count-subcommand"

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


def _load():
    return json.loads(STORE.read_text()) if STORE.exists() else []


def _save(items):
    STORE.write_text(json.dumps(items, indent=2) + "\n")


def add(args):
    items = _load()
    items.append({"id": len(items) + 1, "text": args.text, "done": False})
    _save(items)


def list_items(args):
    for item in _load():
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
for text in "buy milk" "call mom" "file taxes"; do
  python3 "$PROJECT/src/cli.py" add "$text"
done
git -C "$PROJECT" add src/cli.py todos.json
git -C "$PROJECT" commit -qm 'feat: todo CLI with add and list'

# The swe's first attempt, committed in the task worktree: count reads the
# raw file length instead of the number of items.
git -C "$PROJECT" worktree add -q -b "$BRANCH" "$WT"
python3 - "$WT/src/cli.py" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
src = path.read_text()
src = src.replace(
    "\n\ndef main():",
    "\n\ndef count(args):\n    print(len(STORE.read_text()))\n\n\ndef main():",
)
src = src.replace(
    '    sub.add_parser("list").set_defaults(func=list_items)\n',
    '    sub.add_parser("list").set_defaults(func=list_items)\n'
    '    sub.add_parser("count").set_defaults(func=count)\n',
)
path.write_text(src)
PY
git -C "$WT" add src/cli.py
git -C "$WT" commit -qm 'feat: add count subcommand'
SEED_SHA=$(git -C "$WT" rev-parse HEAD)

REPO_NAME="$(basename "$PROJECT")"
VERIFY_CMD='python3 src/cli.py count'
sqlite3 "$DB" <<SQL
INSERT OR IGNORE INTO repos (name, path, target_branch, branching_model, protected_branches)
VALUES ('$REPO_NAME', '$PROJECT', 'main', 'github-flow', '["main"]');

INSERT INTO issues (objective, description, status, repo, created_at, updated_at)
VALUES ('Add count subcommand to todo CLI',
        'Count subcommand; first attempt failed review.', 'open', '$REPO_NAME',
        datetime('now'), datetime('now'));

INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, status, commit_sha, repo, files, verification,
                   effort, created_at, updated_at, completed_at)
SELECT id, '$BRANCH', 'main', 'Add count subcommand',
       '## Description
Add a count subcommand to src/cli.py that prints the number of todo items in the JSON store.

## Success Criteria
- python3 src/cli.py count prints the number of items in todos.json
- An empty or missing store prints 0
', 'See spec.', 'closed', '$SEED_SHA', '$REPO_NAME',
       '["src/cli.py"]', '["$VERIFY_CMD"]', 'medium',
       datetime('now'), datetime('now'), datetime('now')
FROM issues
WHERE objective = 'Add count subcommand to todo CLI'
ORDER BY id DESC LIMIT 1;

INSERT INTO agent_runs (task_id, issue_id, agent_type, tool_uses, duration_ms,
                        started_at, completed_at, repo, spawn_id, usage_source,
                        root_dir, model, host, exit_reason, effort)
SELECT id, issue_id, 'swe', 12, 60000, datetime('now'), datetime('now'),
       '$REPO_NAME', 'tool_use:l5-seed-swe', 'unmeasured',
       '$WT', 'claude-sonnet-4-5', 'claude', 'completed', 'medium'
FROM tasks
WHERE branch_id = '$BRANCH'
ORDER BY id DESC LIMIT 1;

INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback,
                                 mcp_available, repo, created_at)
SELECT id, 1, 'code-reviewer', 'fail',
       'FAIL: count prints len(STORE.read_text()), the character count of todos.json, not the number of items. It also raises FileNotFoundError when todos.json does not exist; the spec wants 0. Fix: print len(_load()).',
       1, '$REPO_NAME', datetime('now')
FROM tasks
WHERE branch_id = '$BRANCH'
ORDER BY id DESC LIMIT 1;
SQL
