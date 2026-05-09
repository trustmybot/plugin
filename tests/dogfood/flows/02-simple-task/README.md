# 02-simple-task

**Flow under test**: `FLOWS.md §2 — Simple Task`

**Pre-state** (`fixture-pre.sql`): onboarding complete, named identity.

**Trigger**: `@bro write a python cli todo`

**Expected behavior**:
1. Bro detects code-touching ask
2. Triages as `simple` (no architecture impact)
3. Creates issue + task
4. Spawns SWE
5. Logs `planning_complete` event

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | One issue exists with todo-like objective; one task exists for that issue; audit has `planning_complete` event |
| `tools-required.json` | `issue_create`, `task_create_batch`, `Task` (SWE spawn) all called at least once |
| `tools-forbidden.json` | `validation_record` (pr-reviewer-only) NOT called by bro; `task_update_status` with status='closed' NOT called (SWE hasn't returned yet in this snapshot) |
| `cost-budget.json` | Soft budget — warn if >50K tokens or >60s p99 latency, don't fail |
