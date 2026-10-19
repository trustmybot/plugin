#!/usr/bin/env bash
# L5 isolation setup for 22-onboard-persona. Seeds a Human-owned CLAUDE.md
# and snapshots it to .claude/tmb/_l5_claude_md_seed.md so outcome.sql can
# prove /tmb:onboard left the file byte-for-byte untouched (GH 1496: the
# persona loads from the plugin's hooks, never from the project CLAUDE.md).
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/.claude/tmb" || exit 1
cat > "$PROJECT/CLAUDE.md" <<'MD'
# todo-cli

Project notes for Claude Code, written by the Human.

- Python 3.11, stdlib only; the CLI lives in src/cli.py.
- Run tests with `python -m pytest tests/`.
MD
cp "$PROJECT/CLAUDE.md" "$PROJECT/.claude/tmb/_l5_claude_md_seed.md" || exit 1

if git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1; then
  (
    cd "$PROJECT" || exit 1
    git add CLAUDE.md
    git commit -qm 'docs: project CLAUDE.md (row 22 substrate)'
  ) >/dev/null || exit 1
fi
