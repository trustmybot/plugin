#!/usr/bin/env bash
# L5 seed for 11-roundtable: simulate the chain state by step 11 — TODO CLI
# committed, consultants (cto + data-engineer) already registered as
# project-local (cto from step 10's /tmb:agent-create flow; data-engineer
# seeded here as a project-specific consultant).
#
# Bro convenes a roundtable on storage choice (JSON vs SQLite vs backend
# service). Both consultants write analyses + votes.
set -uo pipefail

PROJECT="$1"
SCENARIO_DIR="$2"
# shellcheck disable=SC2034
:

PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$SCENARIO_DIR/../../../.." && pwd)}"

mkdir -p "$PROJECT/.claude/agents" "$PROJECT/src"

# Pre-seed the CLI substrate so consultants have real code to reference.
cat > "$PROJECT/src/cli.py" <<'PY'
"""TODO CLI — stdlib argparse + JSON storage at ~/.todo-cli/todos.json."""
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
PY
(
  cd "$PROJECT" || exit 1
  git add src/cli.py
  git commit -qm 'feat: todo CLI'
) >/dev/null

# Pre-seed cto (templated) so the roundtable's templated half is in place.
src="$PLUGIN_ROOT/templates/agents/cto.md"
[ -f "$src" ] && cp "$src" "$PROJECT/.claude/agents/cto.md"

# Pre-seed data-engineer (from-scratch; matches what an earlier chain step
# would have created via Branch C of /tmb:agent-create).
cat > "$PROJECT/.claude/agents/data-engineer.md" <<'MD'
---
name: data-engineer
tmb_owner: bro
description: Consultant. Storage architecture, query patterns, data-pipeline trade-offs.
model: opus
tools: Read, Glob, Grep, mcp__plugin_tmb_trajectory-server
skills: []
---

# Data Engineer

Storage architecture + query patterns + data-pipeline trade-offs. Read code + DB shape before recommending.

## TMB contract (binding)

You are spawned analysis-only. If `issue_id=<N>` was given, use it; else call `issue_list(agent='data-engineer', status='open')` and use the most recent open issue. NEVER call `issue_create` — server-rejected for consultants.

**Persistence is mandatory.** Before returning any text to bro, call `discussion_append(agent='data-engineer', issue_id=<N>, kind='analysis', body='<full analysis>')`. The DB row is the deliverable; text to bro is a summary.

Roundtable mode: also call `roundtable_vote(agent='data-engineer', vote='...', reasoning='...')` after persisting the analysis.

You decide nothing. Bro summarizes for the Human; the Human decides.
MD

# Pre-seed agents table + an open storage-scaling issue for the roundtable
# to cite.
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
INSERT OR REPLACE INTO agents (name, kind, scope, file_path, created_at)
VALUES
  ('cto',           'consultant', 'project-local', '.claude/agents/cto.md',           datetime('now')),
  ('data-engineer', 'consultant', 'project-local', '.claude/agents/data-engineer.md', datetime('now'));

INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('TODO CLI storage choice',
        'Team usage rising. JSON-file works at single-user; question is whether to move to SQLite or a small backend service.',
        'open', datetime('now'), datetime('now'));
SQL
