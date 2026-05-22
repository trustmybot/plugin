#!/usr/bin/env bash
# L5 isolation setup for 05-swe-atomic-close: simulates the chain state
# step 04 leaves behind — the todo CLI already exists on disk + commit,
# plus tests/test_cli.py. Bro is asked to add a small feature
# (--priority flag); SWE dispatches + atomic-closes for that feature.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src" "$PROJECT/tests"
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

cat > "$PROJECT/tests/test_cli.py" <<'PY'
"""Tests for the todo CLI core."""
import os
import tempfile
from pathlib import Path
from unittest import mock
import src.cli as cli


def test_add_and_list(tmp_path, capsys):
    with mock.patch.object(cli, "STORE", tmp_path / "todos.json"):
        cli.add(type("A", (), {"text": "buy milk"})())
        cli.list_(None)
    out = capsys.readouterr().out
    assert "buy milk" in out
PY

(
  cd "$PROJECT" || exit 1
  git add src/cli.py tests/test_cli.py
  git commit -qm 'feat: todo CLI with add/list/done/remove + tests'
) >/dev/null

# Simulate step 04's "scan ran + repo registered" state so the gate
# doesn't re-fire for this row.
PROJECT_REAL=$(cd "$PROJECT" && pwd -P)
REPO_NAME="${EXISTING_REPO:-todo-cli}"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT OR REPLACE INTO repos (name, path) VALUES ('$REPO_NAME', '$PROJECT_REAL');

INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'Scan completed at step 04.', '{"source":"step04"}', datetime('now'));
SQL
