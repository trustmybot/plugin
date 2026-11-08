// L5 isolation setup for 17-audit-request: a todo CLI whose "list" silently
// drops every item past the tenth, plus a 12-item store written by "add".
// Running "list" against the store shows the loss before any code is read.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStandaloneProject, gitCommit, setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

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
PAGE = 10


def _load():
    return json.loads(STORE.read_text()) if STORE.exists() else []


def _save(items):
    STORE.write_text(json.dumps(items, indent=2) + "\\n")


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
`,
);

rmSync(join(project, 'todos.json'), { force: true });
for (const text of [
  'buy milk',
  'call mom',
  'file taxes',
  'fix bike',
  'book dentist',
  'renew passport',
  'water plants',
  'pay rent',
  'clean garage',
  'plan trip',
  'return library books',
  'update resume',
]) {
  execFileSync('python3', [join(project, 'src', 'cli.py'), 'add', text], { stdio: 'inherit' });
}

gitCommit(project, ['src/cli.py', 'todos.json'], 'feat: todo CLI with add and list, seeded store');
