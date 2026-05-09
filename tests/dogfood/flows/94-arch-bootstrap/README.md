# 94-arch-bootstrap

**Flow under test**: First-code-touching-ask triggers silent arch bootstrap on small projects (≤200 commits) per `lazy-regen-postcheck.sh hook` issue #94 fix.

**Pre-state** (`onboarding-named`): tiny scratch project (1 commit), no arch docs.

**Trigger**: `@bro write a python cli todo`

**Expected behavior**:
1. Bro detects code-touching ask
2. `lazy-regen-postcheck.sh hook` runs first; sees N≤200 → invokes `architecture_regen MCP tool(scope='initial')` silently
3. Bootstrap populates `file_registry` + `regen_state`
4. Planning chain proceeds for the ask

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | `regen_state` has bootstrap row; `file_registry` has ≥1 arch path; ≥1 task |
| `tools-required.json` | `architecture_regen` + `task_create_batch` |
| `tools-forbidden.json` | `validation_record` |
| `cost-budget.json` | Soft 120K / 150s |

## Why this matters

Regression test for issue #94: tiny projects rarely cross the 25-commit threshold; the N≤200 silent-bootstrap branch closes that gap.
