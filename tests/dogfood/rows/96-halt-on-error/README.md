# 96-halt-on-error

**Flow under test**: Halt-on-error doctrine — when an MCP tool errors, bro must surface and stop, not fabricate fallbacks.

**Pre-state** (`onboarding-named`): identity set, no tasks.

**Trigger**: `@bro update task 99999 to closed status`

**Expected behavior**:
1. Bro calls `task_update_status` with task_id=99999
2. MCP server returns an error (no such task)
3. Bro surfaces the error and stops — does not invent a row

**L5 mode**: onboarding-named fixture; no extra pre-state (DB has no tasks by design).
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Task 99999 doesn't exist; no task in `closed` status |
| `tools-required.json` | empty |
| `tools-forbidden.json` | `validation_record` |
| `cost-budget.json` | Tight 30K / 60s — bloat = self-recovery attempt instead of halting |