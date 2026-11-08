// Pre-seed prior chain context: by step 10 the TODO CLI exists with JSON
// storage (matches what step 04/05 SWE would produce in L6 chain). Bro is
// asked an architecture question about scaling the CLI's storage; bro must
// classify as a tech-strategy ask, invoke /tmb:agent-create cto via the
// consultant-spawn-required hook routing, and spawn cto for analysis.
import { gitCommit, setupArgs, sql, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);

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


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("text"); a.set_defaults(func=add)
    args = p.parse_args()
    args.func(args)
`,
);

gitCommit(project, ['src/cli.py'], 'feat: todo CLI with JSON storage');

sql(
  project,
  `INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Evaluate TODO CLI storage scale-out',
        'Team usage is rising; JSON-file storage is single-user. Open question on SQLite vs small backend service.',
        'open', datetime('now'), datetime('now'));`,
);
