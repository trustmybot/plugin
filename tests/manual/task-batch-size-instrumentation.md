# Manual: task_create_batch size instrumentation

Verifies that every `task_create_batch` call writes a `tool_size` log line, and that
oversize payloads (max spec_body > 8192 bytes) also write an `oversize_warning` line.

## Setup

```bash
LOG=~/.claude/tmb/logs/mcp-server.log
```

Restart MCP so the new code is loaded:

```
/reload-plugins
```

## Step 1 — tiny call (no spec_body)

Call `task_create_batch` with a task that has no `spec_body` (or an empty one).
Use `waive_scope_gate=true` and an existing issue_id for convenience.

Expected: a `tool_size` line appears in the log with `max_spec_bytes:0`.

```bash
tail -n 20 "$LOG" | grep tool_size
# → {"kind":"tool_size","tool":"task_create_batch","total_bytes":<N>,"max_spec_bytes":0,"n_tasks":1,"agent":"bro",...}
```

No `oversize_warning` line should appear.

## Step 2 — oversize call (spec_body > 8192 bytes)

Call `task_create_batch` with a task whose `spec_body` is at least 10 000 characters
(e.g. `"x".repeat(10000)` padded inline, or a real spec pasted in).

Expected: BOTH a `tool_size` line AND an `oversize_warning` line appear.

```bash
tail -n 20 "$LOG" | grep -E 'tool_size|oversize_warning'
# → {"kind":"tool_size","tool":"task_create_batch","total_bytes":<N>,"max_spec_bytes":10000,...}
# → {"kind":"oversize_warning","tool":"task_create_batch","total_bytes":<N>,"max_spec_bytes":10000,...,"threshold":8192,"upstream_ref":"anthropics/claude-code#36319",...}
```

## Step 3 — verify no behavior regression

Confirm the task was actually inserted (step 2 call should succeed):

```bash
sqlite3 ~/.claude/tmb/trajectory.db \
  "SELECT id, branch_id, status FROM tasks ORDER BY id DESC LIMIT 3;"
# → the oversize task is in the DB with status='pending'
```

The call must NOT be refused — logging is observation-only.

## Pass criteria

- [ ] Step 1: `tool_size` line present, `max_spec_bytes` = 0, no `oversize_warning`
- [ ] Step 2: both `tool_size` and `oversize_warning` lines present, `max_spec_bytes` > 8192
- [ ] Step 3: task row exists in DB (not refused)
