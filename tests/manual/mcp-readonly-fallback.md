# Manual Test Recipe — mcp-readonly-fallback

Tests for `plugin/scripts/bro-sqlite-readonly.sh` and `plugin/skills/tmb_mcp-readonly-fallback/SKILL.md`.

All commands run from the `plugin/` directory. Replace `<DB>` with your trajectory DB path (default: `<project>/.claude/tmb/trajectory.db`).

## Setup

### Locate the trajectory DB

```bash
# Default path (from project root, stable channel):
DB="$(pwd)/../.claude/tmb/trajectory.db"

# Override via env var:
export TRAJECTORY_DB_PATH="$DB"
```

### Verify DB is readable (dry-run check)

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh --dry-run
```

Expected output shape:
```json
{"ok":true,"db_path":"/path/to/trajectory.db","issues_count":<N>}
```

### Simulate MCP death (optional — bro can also test helper without killing MCP)

```bash
pkill -f 'trajectory-server/dist/index.js' || true
```

After this, all `mcp__plugin_tmb_*` calls in Claude Code will return `is_error=true` with a `no matching deferred tools` error.

---

## Verify each fall-through tool

Substitute real IDs from your DB. Find one with:

```bash
sqlite3 "$DB" "SELECT id FROM issues ORDER BY updated_at DESC LIMIT 3;"
sqlite3 "$DB" "SELECT id, issue_id FROM tasks WHERE status IN ('pending','failed') LIMIT 3;"
```

### 1. issue_resume

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh issue_resume '{"issue_id":"<ID>"}'
```

Expected JSON shape:
```json
{"issue": {"id": <N>, "objective": "...", "status": "...", ...}, "next_task": <task-object-or-null>}
```

Assert: top-level keys are `issue` and `next_task`. `issue` has `id`, `objective`, `status`, `created_at`, `updated_at`.

### 2. issue_get

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh issue_get '{"issue_id":"<ID>"}'
```

Expected JSON shape:
```json
{"id": <N>, "parent_issue_id": null, "objective": "...", "status": "...", ...}
```

Assert: no `description` field (redacted in default mode). Keys include `id`, `objective`, `status`, `created_at`, `updated_at`.

Test with description included:
```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh issue_get '{"issue_id":"<ID>","include_description":true}'
```

Assert: `description` field present in response.

### 3. issue_get_phase

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh issue_get_phase '{"issue_id":"<ID>"}'
```

Expected JSON shape:
```json
{"phase": "tasks", "counts": {"tasks_total": <N>, "tasks_completed": <N>, "tasks_failed": <N>}}
```

Assert: `phase` is one of `discussion | blueprint | tasks | done`. `counts` has all three integer fields.

### 4. task_get

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh task_get '{"task_id":"<ID>"}'
```

Expected JSON shape:
```json
{"id": <N>, "issue_id": <N>, "branch_id": "feat/...", "status": "pending", ...}
```

Assert: all Task fields present: `id`, `issue_id`, `branch_id`, `parent_branch_id`, `title`, `description`, `tools_required`, `skills_required`, `success_criteria`, `status`, `attempts`, `spec_body`, `commit_sha`, `created_at`, `updated_at`, `completed_at`.

### 5. task_first_actionable

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh task_first_actionable '{"issue_id":"<ID>"}'
```

Expected output: full task JSON object (same shape as `task_get`) OR `null` if no pending/failed tasks.

Assert: either a task object with all fields, or the literal `null`.

### 6. config_get

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh config_get '{"key":"branching_model"}'
```

Expected output: the raw JSON value (not an object wrapper), e.g. `"github-flow"`.

Assert: output is the deserialized config value. For `branching_model` it should be a string like `"github-flow"`.

Test a missing key:
```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh config_get '{"key":"nonexistent_key"}'
```

Assert: output is `null`.

### 7. config_list

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh config_list '{}'
```

Expected JSON shape:
```json
{"branching_model": "github-flow", "pr_target": "main", "protected_branches": ["main"], ...}
```

Assert: top-level object where keys are config key names, values are deserialized (not JSON strings).

---

## Verify writes refuse cleanly

Each of these should exit 1 and return a JSON error — never touch the DB.

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh issue_create '{"objective":"test"}'; echo "exit: $?"
```

Expected:
```json
{"error":"degraded-mode-readonly","requested":"issue_create","recovery":"MCP is dead. Kill zombie: pkill -f 'trajectory-server/dist/index.js' then restart Claude Code."}
exit: 1
```

Repeat for other write tools:

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh task_create_batch '{}'; echo "exit: $?"
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh task_update_status '{}'; echo "exit: $?"
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh validation_record '{}'; echo "exit: $?"
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh discussion_append '{}'; echo "exit: $?"
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh config_set '{}'; echo "exit: $?"
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh issue_close '{}'; echo "exit: $?"
```

Assert for each: exit code 1, `error` field is `"degraded-mode-readonly"`, `requested` matches the tool name.

Unknown tools also refuse:
```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh some_made_up_tool '{}'; echo "exit: $?"
```

Assert: same refusal shape, exit 1.

---

## Verify logging

### Pre-condition

Check that the log directory exists:
```bash
ls ~/.claude/tmb/logs/
```

If `mcp-health.log` exists, note the current line count:
```bash
wc -l ~/.claude/tmb/logs/mcp-health.log
```

### Fire a fallback read

```bash
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh config_list '{}' > /dev/null
```

### Assert log entry appended

```bash
tail -1 ~/.claude/tmb/logs/mcp-health.log
```

Expected JSONL line shape:
```json
{"ts":"2026-04-28T06:42:09.000Z","kind":"fallback","tool":"config_list","agent":"bro"}
```

Assert: `kind` is `"fallback"`, `tool` matches the called tool name, `agent` is `"bro"`, `ts` is a valid ISO-8601 timestamp.

### If log dir does not exist

Script must not error — logging is suppressed silently:
```bash
tmplog=$(mktemp -d) && unset HOME  # edge-case test only in isolated shell
# Script should still return valid JSON with exit 0
```

---

## Verify flags

```bash
# --dry-run
TRAJECTORY_DB_PATH="$DB" scripts/bro-sqlite-readonly.sh --dry-run
# Assert: {"ok":true,"db_path":"...","issues_count":<N>}

# --list
scripts/bro-sqlite-readonly.sh --list
# Assert: {"supported_read_tools":["issue_resume","issue_get","issue_get_phase","task_get","task_first_actionable","config_get","config_list"]}

# No args → usage error
scripts/bro-sqlite-readonly.sh; echo "exit: $?"
# Assert: {"error":"usage",...}, exit 1
```

---

## Recovery

After simulating MCP death and running fallback reads:

1. Kill any remaining zombie node processes:
   ```bash
   pkill -f 'trajectory-server/dist/index.js' || true
   ```

2. Restart Claude Code:
   ```bash
   # Exit the current session and relaunch:
   claude --plugin-dir /path/to/plugin
   ```

3. Verify MCP is live again — first `mcp__plugin_tmb_*` call should succeed (`is_error` absent from response).

4. Check that `mcp-health.log` no longer receives new `fallback` entries (only regular `mcp_health_check` entries from the hook).

See memory `feedback_mcp_recovery.md` for the full recovery doctrine.
