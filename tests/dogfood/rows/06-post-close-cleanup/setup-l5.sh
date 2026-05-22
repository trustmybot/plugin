#!/usr/bin/env bash
# Pre-seed src/cli.py and a file_registry row with a NULL summary so bro
# has something to Read and a registry row to update.
#
# The file content matches what step 05 SWE would commit in L6 chain
# (a working stdlib TODO CLI with add/list/done/remove subcommands on
# JSON storage). L5 isolation seeds the same shape so the same bro
# prompt works in both modes against the same substrate.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/cli.py" <<'PY'
"""TODO CLI — stdlib argparse + JSON storage at ~/.todo-cli/todos.json."""
import argparse
import json
import os
import sys
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


def list_(_args):
    for it in _load():
        mark = "x" if it["done"] else " "
        print(f"[{mark}] {it['id']}: {it['text']}")


def done(args):
    items = _load()
    for it in items:
        if it["id"] == args.id:
            it["done"] = True
    _save(items)


def remove(args):
    items = [it for it in _load() if it["id"] != args.id]
    _save(items)


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("text"); a.set_defaults(func=add)
    sub.add_parser("list").set_defaults(func=list_)
    d = sub.add_parser("done"); d.add_argument("id", type=int); d.set_defaults(func=done)
    r = sub.add_parser("remove"); r.add_argument("id", type=int); r.set_defaults(func=remove)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
PY

# Do NOT commit src/cli.py here — the hooks this row tests
# (post-task-close-rescan + post-read-summary-hint) only need the file
# to EXIST on disk + have a file_registry row. Committing would pollute
# `main` and could leak into row 7's branch via implicit base.

# Compute md5 of the file content the same way file_registry_upsert would.
content_md5=$(md5 -q "$PROJECT/src/cli.py" 2>/dev/null || md5sum "$PROJECT/src/cli.py" | cut -d' ' -f1)

# Seed `repos` AND `file_registry` consistently. The post-read-summary-hint
# hook walks `repos` to convert the Read tool's absolute path back to a
# repo-relative path. Use the *physical* (symlink-resolved) project path
# because Read resolves symlinks: on macOS, mktemp returns
# /var/folders/.../tmb-l5-X but Read sees /private/var/folders/.../tmb-l5-X.
# The hook's prefix match needs the same canonical form.
PROJECT_REAL=$(cd "$PROJECT" && pwd -P)

# Reuse the existing repos row's name if any. In the L6 chain, row 4's
# scan_run auto-creates a repos row with a name derived from the scratch
# dir basename. Forcing a second row at the same path would make the
# hook's repo-walk non-deterministic and the file_registry lookup would
# miss when the hook picked the unseeded name.
EXISTING_REPO=$(sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "SELECT name FROM repos WHERE path = '$PROJECT_REAL' ORDER BY length(name) DESC LIMIT 1;" 2>/dev/null)
REPO_NAME="${EXISTING_REPO:-todo-cli}"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT OR REPLACE INTO repos (name, path)
VALUES ('$REPO_NAME', '$PROJECT_REAL');

INSERT OR REPLACE INTO file_registry (repo, path, type, content_md5, summary, summary_updated_at)
VALUES ('$REPO_NAME', 'src/cli.py', 'source', '$content_md5', NULL, NULL);
SQL
