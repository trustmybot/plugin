# 04-agent-creator

**Flow under test**: `tmb_agent-creator` skill — template-copy mode (PRIMARY path)

**Pre-state** (`fixture.txt` defaults to `onboarding-named`): onboarding complete, named identity, no architect agent in `.claude/agents/`.

**Trigger**: Human asks bro to get the architect's read on a technical question (SQLite WAL mode vs dedicated DB). No architect agent exists yet, so bro must invoke `tmb_agent-creator`.

**Expected behavior**:
1. Bro detects no `architect.md` exists in `.claude/agents/`
2. Bro invokes `tmb_agent-creator` skill with `name=architect`
3. Skill reads `templates/agents/architect.md` and asks Human for approval
4. On approval: writes `templates/agents/architect.md` → `.claude/agents/architect.md` verbatim
5. Skill calls `audit_log(kind='event', event_type='tmb_agent_created', content_json={"name":"architect","mode":"template-copy"})`
6. Bro spawns architect agent for the original ask

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Audit has `tmb_agent_created` event (kind='event'); event content_json contains `"name":"architect"` and `"mode":"template-copy"` |
| `tools-required.json` | `Write` (for agent file copy) and `audit_log` MCP tool both called at least once |
| `tools-forbidden.json` | Workflow state tools (`task_update_status`, `validation_record`, `task_create_batch`) NOT called — agent-creator is metadata-only |
| `cost-budget.json` | Soft budget 80K tokens / 90s p99 — skill-invocation + agent spawn is heavier than a bare SWE task; warn on overage, don't fail |

## Filesystem assertion

`outcome-files.json` asserts that `.claude/agents/architect.md` exists with at least 100 bytes after the flow runs. This is the first use of the opt-in `outcome-files.json` convention (see `tests/dogfood/flows/README.md`).
