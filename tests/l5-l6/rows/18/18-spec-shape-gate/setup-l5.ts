// L5 isolation setup for 18-spec-shape-gate: a todo CLI backed by a SQLite
// store whose schema lives in src/schema.sql, plus a registered repo. A task
// that touches src/schema.sql trips the require-task-spec Writer:/Populated:
// contract at swe spawn.
import { appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensureStandaloneProject, gitCommit, setupArgs, sql, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);

ensureStandaloneProject(project);

writeFile(
  project,
  'src/schema.sql',
  `CREATE TABLE IF NOT EXISTS todos (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    text  TEXT    NOT NULL,
    done  INTEGER NOT NULL DEFAULT 0
);
`,
);
writeFile(
  project,
  'src/cli.py',
  `"""TODO CLI: stdlib argparse + SQLite store in todos.db at the project root."""
import argparse
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "todos.db"
SCHEMA = Path(__file__).resolve().parent / "schema.sql"


def _connect():
    conn = sqlite3.connect(STORE)
    conn.executescript(SCHEMA.read_text())
    return conn


def add(args):
    with _connect() as conn:
        conn.execute("INSERT INTO todos (text) VALUES (?)", (args.text,))


def list_items(args):
    with _connect() as conn:
        for id_, text, done in conn.execute("SELECT id, text, done FROM todos ORDER BY id"):
            print(f"{id_}. [{'x' if done else ' '}] {text}")


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
appendFileSync(join(project, '.gitignore'), 'todos.db\n');
gitCommit(project, ['.gitignore', 'src/schema.sql', 'src/cli.py'], 'feat: todo CLI with a SQLite store');

sql(
  project,
  `INSERT OR IGNORE INTO repos (name, path, target_branch, branching_model, protected_branches)
VALUES (?, ?, 'main', 'github-flow', '["main"]')`,
  [basename(project), project],
);
