# 04-agent-creator

**Flow under test**: `tmb_agent-creator` skill — template-copy mode (PRIMARY path)

**Pre-state** (`fixture.txt` defaults to `onboarding-named`): onboarding complete, named identity, no architect agent in `.claude/agents/`.

**Trigger**: Human asks bro to get the architect's read on a technical question (SQLite WAL mode vs dedicated DB). No architect agent exists yet, so bro must invoke `tmb_agent-creator`.

**Expected behavior**:
1. Bro detects no `architect.md` exists in `.claude/agents/`
2. Bro invokes `tmb_agent-creator` skill with `name=architect`
3. Skill reads `templates/agents/architect.md` and asks Human for approval
4. On approval: writes `templates/agents/architect.md` → `.claude/agents/architect.md` verbatim
5. Skill calls `ledger_log(event_type='tmb_agent_created', content_json={"name":"architect","mode":"template-copy"})`
6. Bro spawns architect agent for the original ask

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Ledger has `tmb_agent_created` event; event content_json contains `"name":"architect"` and `"mode":"template-copy"` |
| `tools-required.json` | `Write` (for agent file copy) and `ledger_log` MCP tool both called at least once |
| `tools-forbidden.json` | Workflow state tools (`task_update_status`, `validation_record`, `task_create_batch`) NOT called — agent-creator is metadata-only |
| `cost-budget.json` | Soft budget 80K tokens / 90s p99 — skill-invocation + agent spawn is heavier than a bare SWE task; warn on overage, don't fail |

## Filesystem assertion — scoped down (follow-up filed)

The primary disk outcome — `.claude/agents/architect.md` existing on the scratch project — cannot be expressed in `outcome.sql` (which queries the trajectory DB only). No existing `outcome-files.json` convention or filesystem-scorer hook was found in `tests/dogfood/lib/scorers.sh` or any other flow. Rather than inventing new infrastructure in this PR, the scaffold ships with DB-only assertions.

A follow-up issue should be filed for filesystem-scorer infrastructure so future flows can assert on disk state post-run (e.g. `outcome-files.json` listing expected paths). This scaffold is intentionally conservative: the three DB assertions give strong signal that the skill executed correctly even without the disk check.
