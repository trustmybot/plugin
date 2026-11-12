// L5 seed for 13-roundtable: simulate the chain state by step 11 — TODO CLI
// committed, consultants (cto + data-engineer) already registered as
// project-local (cto from step 10's /tmb:agent-create flow; data-engineer
// seeded here as a project-specific consultant).
//
// Bro convenes a roundtable on storage choice (JSON vs SQLite vs backend
// service). Both consultants write analyses + votes.
import { gitCommit, setupArgs, sql, writeFile } from '../../../lib/setup-helpers.ts';
import { seedAgents } from './seed-agents.ts';

const { project } = setupArgs(import.meta.dirname);

// Pre-seed the CLI substrate so consultants have real code to reference.
writeFile(
  project,
  'src/cli.py',
  `"""TODO CLI — stdlib argparse + JSON storage at ~/.todo-cli/todos.json."""
import argparse, json, os
from pathlib import Path

STORE = Path(os.path.expanduser("~/.todo-cli/todos.json"))

def _load():
    return json.loads(STORE.read_text()) if STORE.exists() else []

def _save(items):
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2))
    tmp.replace(STORE)

def add(args):
    items = _load()
    items.append({"id": len(items)+1, "text": args.text, "done": False})
    _save(items)
`,
);
gitCommit(project, ['src/cli.py'], 'feat: todo CLI');

// Pre-seed the roundtable panel (cto + data-engineer) via the shared seed so
// L5 and L6 (step-11 chain_setup_command) convene the identical panel.
seedAgents(project);

// Pre-seed an open storage-scaling issue for the roundtable to cite. (L5-only:
// in the L6 chain this issue already exists from the prior steps' discussion.)
sql(
  project,
  `INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('TODO CLI storage choice',
        'Team usage rising. JSON-file works at single-user; question is whether to move to SQLite or a small backend service.',
        'open', datetime('now'), datetime('now'));`,
);
