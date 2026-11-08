// L5 isolation setup for 19-review-fail-rework: a closed "count subcommand"
// task whose commit code-reviewer failed (count prints the store's character
// count, not its item count), with its branch, its linked worktree, the swe
// run that worked there and the FAIL validation row. Bro reopens the task,
// swe reworks it in the same worktree, code-reviewer reviews it again.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensureStandaloneProject, gitCommit, gitOrThrow, setupArgs, withDb, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
const branch = 'feat/add-count-subcommand';
const wt = join(project, '.claude', 'worktrees', 'add-count-subcommand');

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
rmSync(join(project, 'todos.json'), { force: true });
for (const text of ['buy milk', 'call mom', 'file taxes']) {
  execFileSync('python3', [join(project, 'src', 'cli.py'), 'add', text], { stdio: 'inherit' });
}
gitCommit(project, ['src/cli.py', 'todos.json'], 'feat: todo CLI with add and list');

// The swe's first attempt, committed in the task worktree: count reads the
// raw file length instead of the number of items.
gitOrThrow(project, ['worktree', 'add', '-q', '-b', branch, wt]);
const wtCli = join(wt, 'src', 'cli.py');
writeFileSync(
  wtCli,
  readFileSync(wtCli, 'utf8')
    .replaceAll('\n\ndef main():', '\n\ndef count(args):\n    print(len(STORE.read_text()))\n\n\ndef main():')
    .replaceAll(
      '    sub.add_parser("list").set_defaults(func=list_items)\n',
      '    sub.add_parser("list").set_defaults(func=list_items)\n    sub.add_parser("count").set_defaults(func=count)\n',
    ),
);
gitCommit(wt, ['src/cli.py'], 'feat: add count subcommand');
const seedSha = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const repo = basename(project);
const verifyCmd = 'python3 src/cli.py count';

withDb(project, (db) => {
  db.prepare(
    `INSERT OR IGNORE INTO repos (name, path, target_branch, branching_model, protected_branches)
VALUES (?, ?, 'main', 'github-flow', '["main"]')`,
  ).run(repo, project);

  db.prepare(
    `INSERT INTO issues (objective, description, status, repo, created_at, updated_at)
VALUES ('Add count subcommand to todo CLI',
        'Count subcommand; first attempt failed review.', 'open', ?,
        datetime('now'), datetime('now'))`,
  ).run(repo);

  db.prepare(
    `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, status, commit_sha, repo, files, verification,
                   effort, created_at, updated_at, completed_at)
SELECT id, ?1, 'main', 'Add count subcommand',
       '## Description
Add a count subcommand to src/cli.py that prints the number of todo items in the JSON store.

## Success Criteria
- python3 src/cli.py count prints the number of items in todos.json
- An empty or missing store prints 0
', 'See spec.', 'closed', ?2, ?3,
       ?4, ?5, 'medium',
       datetime('now'), datetime('now'), datetime('now')
FROM issues
WHERE objective = 'Add count subcommand to todo CLI'
ORDER BY id DESC LIMIT 1`,
  ).run(branch, seedSha, repo, JSON.stringify(['src/cli.py']), JSON.stringify([verifyCmd]));

  db.prepare(
    `INSERT INTO agent_runs (task_id, issue_id, agent_type, tool_uses, duration_ms,
                        started_at, completed_at, repo, spawn_id, usage_source,
                        root_dir, model, host, exit_reason, effort)
SELECT id, issue_id, 'swe', 12, 60000, datetime('now'), datetime('now'),
       ?1, 'tool_use:l5-seed-swe', 'unmeasured',
       ?2, 'claude-sonnet-4-5', 'claude', 'completed', 'medium'
FROM tasks
WHERE branch_id = ?3
ORDER BY id DESC LIMIT 1`,
  ).run(repo, wt, branch);

  db.prepare(
    `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback,
                                 mcp_available, repo, created_at)
SELECT id, 1, 'code-reviewer', 'fail',
       'FAIL: count prints len(STORE.read_text()), the character count of todos.json, not the number of items. It also raises FileNotFoundError when todos.json does not exist; the spec wants 0. Fix: print len(_load()).',
       1, ?1, datetime('now')
FROM tasks
WHERE branch_id = ?2
ORDER BY id DESC LIMIT 1`,
  ).run(repo, branch);
});
