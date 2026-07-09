# 12.01-agent-creator

**Source:** L5 `04-agent-creator` (renumbered per reconciliation table).

**Scenario:** Bro is asked for the architect's opinion on SQLite WAL mode concurrency for `app.py`. Because `architect` isn't registered yet, bro must run the agent-creator ceremony: load `/tmb:agent-create`, copy the template, register the agent, then spawn it via Agent. The fixture `app.py` (SQLite + threading code) gives the architect real substance to evaluate.

**L5 mode:** `setup-l5.sh` seeds `onboarding-named` + commits `app.py`.
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `tmb_agent_created` audit event with architect name + template-copy mode |
| `outcome-files.json` | `.claude/agents/architect.md` exists and ≥100 bytes |
| `tools-required.json` | `audit_append`, `Write` |
| `tools-forbidden.json` | `task_update_status`, `validation_record`, `task_create_batch` |
| `cost-budget.json` | Soft 80K / 90s |
