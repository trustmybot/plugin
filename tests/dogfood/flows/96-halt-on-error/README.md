# 96-halt-on-error

**Flow under test**: Halt-on-error doctrine — when an MCP tool errors, bro must surface and stop, not fabricate fallbacks.

**Pre-state** (`onboarding-named`): identity set, no tasks.

**Trigger**: `@bro update task 99999 to closed status`

**Expected behavior**:
1. Bro calls `task_update_status` with task_id=99999
2. MCP server returns an error (no such task)
3. Bro surfaces the error and stops — does not invent a row

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Task 99999 doesn't exist; no task in `closed` status |
| `tools-required.json` | empty — the halt is a non-event |
| `tools-forbidden.json` | `validation_record` |
| `cost-budget.json` | Tight 30K / 60s |

## Why this is best-effort

Fully verifying "bro halted gracefully" requires correlating bro-mode response text with MCP errors, which the trajectory DB doesn't capture. The negative assertions catch the most common regression: a bro that papers over errors.
