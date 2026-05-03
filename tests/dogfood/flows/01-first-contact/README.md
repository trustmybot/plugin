# 01-first-contact

**Replaces** the deleted `01-onboarding` flow. The plugin no longer has an onboarding ceremony, and as of the schema-seeded-defaults refactor, bro never writes any defaults either — the SQL schema seeds them at DB creation. Bro just greets.

**Pre-state** (`empty` fixture): schema only. Tables exist; `plugin_config` is pre-populated by `schema.sql` with `branching_model='github-flow'`, `pr_target='main'`, `protected_branches=["main"]`. Identity is empty. Audit is empty.

**Trigger**: `@bro hi`

**Expected behavior**: bro reads `identity_get` (returns null) + `issue_resume` (returns no work) → emits the welcome banner *"Entering bro mode. What are we doing?"* → continues. **No DB writes.** No `AskUserQuestion`, no `config_set`, no `audit_log`, no `identity_set`.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | identity table is empty; 3 plugin_config keys present at the documented default values (proves schema-seed worked); audit table is empty (proves bro made zero decisions to log) |
| `tools-required.json` | first-action MCP probes called: `identity_get` + `issue_resume` |
| `tools-forbidden.json` | `AskUserQuestion` (no ceremony), `identity_set` (no row written), `config_set` (defaults are schema-seeded), `audit_log` (no bro decision to audit) |
| `cost-budget.json` | Soft budget — first contact should be very cheap (~2 MCP reads + a small response) |

## Why this matters

Regression test for the schema-seeded-defaults doctrine. If a future change reintroduces bro-side default-writes (e.g. by re-adding the silent `config_set` block to the first-action chain), the `tools-forbidden` assertions catch it immediately. Schema is the source of truth for system defaults; bro is the source of truth for user intent.
