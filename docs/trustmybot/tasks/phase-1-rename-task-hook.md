---
name: phase-1-rename-task-hook
branch_id: refactor/phase-1-rename-task-hook
status: pending
authorized_by: architect
depends_on: []
estimated_minutes: 40
---

# Goal

Rename the SWE-spawn gating hook from `require-task-xml.sh` to
`require-task-spec.sh`, update the path regex inside it from `bro/tasks/*.xml`
to `docs/trustmybot/tasks/*.{xml,md}` with format-dispatched authorization
checks, and update `require-review-sign.sh` to scan the new directory. Update
`hooks/hooks.json` to reference the renamed file.

# Context

`scripts/hooks/require-task-xml.sh` currently regex-matches
`bro/tasks/[a-zA-Z0-9_.-]+\.xml` in the SWE-spawn prompt and verifies the
referenced file (checks `<authorized-by>` and `status="open"`). With Phase 1
relocating the workflow directory to `docs/trustmybot/` AND v0.3 introducing
markdown task specs (currently in use for the Phase 1 specs themselves), the
regex must accept BOTH `.xml` (legacy/Phase 2 deferred) and `.md` formats at
the new path, with format-dispatched authorization checks.

`scripts/hooks/require-review-sign.sh` similarly iterates `bro/tasks/*.xml` to
verify PR Reviewer sign-off before push/merge. It needs the new path AND must
also iterate `.md` files (which won't have `<reviewed-by>` XML tags — for
markdown specs, a frontmatter `reviewed_by:` field is the equivalent).

`hooks/hooks.json` references `scripts/hooks/require-task-xml.sh` by path on
line 35 — it must be updated to point at the new filename.

**Bootstrap note:** before this task is committed, the current
`require-task-xml.sh` was patched in place to also accept the new
`docs/trustmybot/tasks/*.md` path with frontmatter
`authorized_by:` + `status: pending`. That bootstrap unblocked SWE spawns for
this Phase 1 batch. This task FINALIZES the hook by renaming the file,
canonicalizing the regex, and removing the old `bro/tasks/*.xml` legacy path
support entirely.

# Files to change

- `/Users/Zax/Git/GitHub/TMB/plugin/scripts/hooks/require-task-xml.sh` → rename via `git mv` to `/Users/Zax/Git/GitHub/TMB/plugin/scripts/hooks/require-task-spec.sh`. Inside, the file should look like this (canonicalized form — the bootstrap patch already added markdown support; this task removes the legacy `bro/tasks/*.xml` path entirely):

  ```bash
  #!/usr/bin/env bash
  # Hook: Block SWE agent spawn unless prompt references a valid
  # docs/trustmybot/tasks/*.{xml,md} task spec.
  set -euo pipefail

  INPUT=$(cat)

  AGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')
  PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

  # Only gate SWE agents
  [ "$AGENT_TYPE" != "swe" ] && exit 0

  # Match docs/trustmybot/tasks/*.xml or *.md (no legacy bro/tasks support)
  TASK_FILE=$(echo "$PROMPT" \
    | grep -oE 'docs/trustmybot/tasks/[a-zA-Z0-9_.-]+\.(xml|md)' \
    | head -1 || true)

  if [ -z "$TASK_FILE" ]; then
    echo '{"decision":"block","reason":"BLOCKED: SWE requires a task spec at docs/trustmybot/tasks/*.{xml,md}. None found in prompt. Route through Architect to create a spec first."}'
    exit 0
  fi

  if [ ! -f "$TASK_FILE" ]; then
    echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Task spec $TASK_FILE does not exist. Architect must create it first.\"}"
    exit 0
  fi

  case "$TASK_FILE" in
    *.xml)
      if ! grep -q '<authorized-by' "$TASK_FILE" 2>/dev/null; then
        echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: $TASK_FILE missing <authorized-by> tag.\"}"
        exit 0
      fi
      if ! grep -q 'status="open"' "$TASK_FILE" 2>/dev/null; then
        echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: $TASK_FILE status is not open.\"}"
        exit 0
      fi
      ;;
    *.md)
      if ! grep -q '^authorized_by:' "$TASK_FILE" 2>/dev/null; then
        echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: $TASK_FILE frontmatter missing authorized_by.\"}"
        exit 0
      fi
      if ! grep -qE '^status:\s*(pending|open)' "$TASK_FILE" 2>/dev/null; then
        echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: $TASK_FILE status is not pending or open.\"}"
        exit 0
      fi
      ;;
  esac

  exit 0
  ```

- `/Users/Zax/Git/GitHub/TMB/plugin/scripts/hooks/require-review-sign.sh`:
  - Change the `[ -d "bro/tasks" ]` check (line 15) to `[ -d "docs/trustmybot/tasks" ]`.
  - Change the `for f in bro/tasks/*.xml` loop (line 19) to iterate both formats:
    ```bash
    for f in docs/trustmybot/tasks/*.xml docs/trustmybot/tasks/*.md; do
    ```
  - Inside the loop, dispatch the unsigned check by extension:
    - `.xml`: existing logic — has `<authorized-by>` but missing `<reviewed-by>`/`<closed-by>`.
    - `.md`: has frontmatter `authorized_by:` but missing `reviewed_by:` and missing `closed_by:`.

- `/Users/Zax/Git/GitHub/TMB/plugin/hooks/hooks.json`:
  - Change line 35 `"command": "scripts/hooks/require-task-xml.sh"` to `"command": "scripts/hooks/require-task-spec.sh"`.

# Success criteria

- File `scripts/hooks/require-task-xml.sh` no longer exists.
- File `scripts/hooks/require-task-spec.sh` exists, is executable (`chmod +x`), and `git log --follow` shows it inheriting from the renamed file.
- New file's grep regex matches `docs/trustmybot/tasks/[NAME].xml` AND `docs/trustmybot/tasks/[NAME].md`, and rejects `bro/tasks/*.xml`.
- `hooks/hooks.json` references `scripts/hooks/require-task-spec.sh` and is valid JSON.
- `require-review-sign.sh` iterates BOTH `docs/trustmybot/tasks/*.xml` AND `docs/trustmybot/tasks/*.md`, and dispatches the sign-check correctly per extension.
- Both hook scripts pass `bash -n` syntax check.
- Both hook scripts remain executable (`-rwxr-xr-x`).

# Out of scope

- Removing `.xml` support entirely (Phase 2 — once all in-flight XML specs are drained).
- Migrating `require-review-sign.sh` to read from SQLite instead of grepping files (Phase 2).
- Touching `git-guards.sh` or `create-worktree.sh` (no path strings to change).

# Verification

```bash
cd /Users/Zax/Git/GitHub/TMB/plugin
test ! -f scripts/hooks/require-task-xml.sh && echo "OK: old hook removed"
test -x scripts/hooks/require-task-spec.sh && echo "OK: new hook present + executable"
bash -n scripts/hooks/require-task-spec.sh && echo "OK: syntax"
bash -n scripts/hooks/require-review-sign.sh && echo "OK: syntax"
grep -q "docs/trustmybot/tasks/" scripts/hooks/require-task-spec.sh && echo "OK: regex updated"
grep -q '\\.(xml|md)' scripts/hooks/require-task-spec.sh && echo "OK: both formats matched"
! grep -q "bro/tasks/" scripts/hooks/require-task-spec.sh && echo "OK: no stale bro path"
grep -q "docs/trustmybot/tasks" scripts/hooks/require-review-sign.sh && echo "OK: review-sign updated"
! grep -q "bro/tasks" scripts/hooks/require-review-sign.sh && echo "OK: no stale bro path in review-sign"
grep -q "require-task-spec.sh" hooks/hooks.json && echo "OK: hooks.json updated"
! grep -q "require-task-xml.sh" hooks/hooks.json && echo "OK: hooks.json no stale ref"
python3 -c "import json; json.load(open('hooks/hooks.json'))" && echo "OK: hooks.json valid"
```

Smoke-test:

```bash
# Old path should be REJECTED
echo '{"tool_input":{"subagent_type":"swe","prompt":"go work on bro/tasks/old.xml"}}' \
  | bash scripts/hooks/require-task-spec.sh
# Expect: {"decision":"block",...}

# New path with .md should be ACCEPTED (uses this task's own spec as the test fixture)
echo '{"tool_input":{"subagent_type":"swe","prompt":"work on docs/trustmybot/tasks/phase-1-rename-task-hook.md"}}' \
  | bash scripts/hooks/require-task-spec.sh
# Expect: empty stdout, exit 0
```

All checks must print OK.
