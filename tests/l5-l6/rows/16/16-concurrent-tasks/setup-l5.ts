// L5 isolation setup for 16-concurrent-tasks: a todo CLI with "add" and "list"
// committed on main plus a registered repo, so bro can provision the two
// independent tasks (count subcommand, list --json) and spawn both swes.
import { basename } from 'node:path';
import { ensureStandaloneProject, gitCommit, setupArgs, sql, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);

ensureStandaloneProject(project);

writeFile(
  project,
  'src/cli.py',
  `"""TODO CLI: stdlib argparse + JSON storage in todos.json at the project root."""
import argparse
import json
from pathlib import Path

STORE = Path(__file__).resolve().parent.parent / "todos.json"


def _load():
    return json.loads(STORE.read_text()) if STORE.exists() else []


def _save(items):
    STORE.write_text(json.dumps(items, indent=2) + "\\n")


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
`,
);
gitCommit(project, ['src/cli.py'], 'feat: todo CLI with add and list');

sql(
  project,
  `INSERT OR IGNORE INTO repos (name, path, target_branch, branching_model, protected_branches)
VALUES (?, ?, 'main', 'github-flow', '["main"]')`,
  [basename(project), project],
);
