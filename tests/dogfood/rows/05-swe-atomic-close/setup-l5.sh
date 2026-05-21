#!/usr/bin/env bash
# L5 isolation setup for 05-swe-atomic-close. Simulates the chain state
# step 04 leaves behind: scan_run already done, an issue + a pending task
# already in the trajectory DB. Bro picks it up and dispatches SWE this
# turn (no re-planning).
#
# In L6 chain, step 04 produces this exact state organically: same prompt
# in step 05 ("dispatch the pending task") works against the same input.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

# Scaffold src/ so SWE has a clear directory to land src/cli.py in.
mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/__init__.py" <<'PY'
"""src package — SWE lands modules here."""
PY
(
  cd "$PROJECT" || exit 1
  git add src/__init__.py
  git commit -qm 'feat: scaffold src/ package'
) >/dev/null

# Seed the post-step-04 trajectory state: scan ran, repo registered,
# issue + pending task already planned (so step 05 only needs to dispatch).
PROJECT_REAL=$(cd "$PROJECT" && pwd -P)
REPO_NAME="${EXISTING_REPO:-todo-cli}"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
-- repo row from the prior scan
INSERT OR REPLACE INTO repos (name, path) VALUES ('$REPO_NAME', '$PROJECT_REAL');

-- deep_scan_completed audit row from step 04's scan
INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'Scan completed at step 04.', '{"source":"step04"}', datetime('now'));

-- The planned issue + pending task from step 04's task_create_batch
INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Build todo CLI', 'Pre-planned in step 04; pending dispatch.', 'open', datetime('now'), datetime('now'));

INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, status, created_at, updated_at)
SELECT id,
       'feat/todo-cli',
       'main',
       'Implement todo CLI add/list/done/remove',
       '## Description
Implement src/cli.py — argparse + JSON storage at ~/.todo-cli/todos.json.

## Files
- src/cli.py — main entry; add/list/done/remove subcommands; atomic JSON write.

## Success Criteria
- src/cli.py exists with main() entry.
- add/list/done/remove subcommands round-trip an item end-to-end.

## Verification
```bash
python -m py_compile src/cli.py
```

## Commit
```
🎯 feat(cli): todo CLI with JSON storage
```',
       'Pre-planned in step 04.',
       'pending',
       datetime('now'),
       datetime('now')
FROM issues WHERE objective = 'Build todo CLI'
ORDER BY id DESC LIMIT 1;
SQL
