// Pre-seed src/cli.py + a top-level README so the world model has something
// to summarize. The scenario under test is: after a task close, the world
// model (wm_ tables) stays warm and the project map stays current.
//
// In L6 chain mode rows 04+05 already pre-warmed the world model (row 04
// ran /scan; row 05 closed a task). In L5
// standalone mode this setup seeds a deep_scan_completed audit row (the
// SQLite-side proxy for "world model warm") so the row's bro turn starts
// with a pre-warmed state.
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { setupArgs, withDb, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);

writeFile(
  project,
  'README.md',
  `# todo-cli

Stdlib argparse + JSON storage. Subcommands: add / list / done / remove.
The CLI module lives at src/cli.py.
`,
);

writeFile(
  project,
  'src/cli.py',
  `"""TODO CLI — stdlib argparse + JSON storage at ~/.todo-cli/todos.json."""
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
`,
);

// Pre-warm the world model for L5 standalone runs. The wm_ tables are
// populated by scan_run at runtime; here we seed the proxy
// (deep_scan_completed audit row + repos row) so bro starts with a warm
// world model rather than hitting the world-model-cold gate.
const projectReal = realpathSync(project);

withDb(project, (db) => {
  db.prepare('INSERT OR REPLACE INTO repos (name, path) VALUES (?, ?)').run(basename(projectReal), projectReal);
  db.exec(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'setup-l5: world model pre-warmed for row 06', '{}', datetime('now'));`);
});
