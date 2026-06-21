#!/usr/bin/env bash
# L5 isolation setup for 14-issue-resume. Simulates step 04's chain output:
# a "count subcommand" task pre-planned in pending status (the prerequisite
# step 04's prompt asks bro to leave queued for later). Step 12 bro picks
# this up via the "@bro pick up the count subcommand task." prompt and
# dispatches SWE without re-planning.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

# Scaffold src/cli.py so SWE has the existing CLI to extend with the count
# subcommand (matches what step 04 chain output would have committed).
mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/cli.py" <<'PY'
"""TODO CLI — stdlib argparse + JSON storage at ~/.todo-cli/todos.json."""
import argparse, json, os
from pathlib import Path

STORE = Path(os.path.expanduser("~/.todo-cli/todos.json"))

def _load():
    return json.loads(STORE.read_text()) if STORE.exists() else []

def add(args):
    items = _load()
    items.append({"id": len(items)+1, "text": args.text, "done": False})
    STORE.parent.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(items, indent=2))

def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("text"); a.set_defaults(func=add)
    args = p.parse_args()
    args.func(args)
PY

(
  cd "$PROJECT" || exit 1
  git checkout -q -b feat/add-count-subcommand
  git checkout -q main
  git add src/cli.py
  git commit -qm 'feat: todo CLI core (step 04 substrate)'
) >/dev/null

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
-- AUTOINCREMENT so this works in L5 (clean DB) AND L6 chain (cumulative DB).
INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Add count subcommand to todo CLI',
        'Queued by step 04 as the follow-on task. Planned but not dispatched.',
        'open', datetime('now'), datetime('now'));

INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, status, created_at, updated_at)
SELECT id, 'feat/add-count-subcommand', 'dev', 'Add count subcommand',
       '## Description
Add a `count` subcommand to src/cli.py that prints the number of todo items in the JSON store.

## Success Criteria
- `python -m src.cli count` prints an integer
- All existing tests still pass
', 'See spec.', 'pending',
       datetime('now'), datetime('now')
FROM issues
WHERE objective = 'Add count subcommand to todo CLI'
ORDER BY id DESC LIMIT 1;

INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary,
                   content_json, created_at)
SELECT id, 'feat/add-count-subcommand', 'bro', 'planning_complete',
       'Pre-seeded planning_complete from step 04 follow-on planning.',
       '{}', datetime('now')
FROM issues
WHERE objective = 'Add count subcommand to todo CLI'
ORDER BY id DESC LIMIT 1;
SQL
