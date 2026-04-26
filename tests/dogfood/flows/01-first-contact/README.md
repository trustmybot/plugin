# 01-first-contact

**Replaces** the deleted `01-onboarding` flow. The plugin no longer has a first-run-onboarding ceremony — bro applies defaults silently on first activation per modern-agent UX (no ceremony, no blocking forms).

**Pre-state** (`empty` fixture): no identity, no config, no ledger.

**Trigger**: `@bro hi`

**Expected behavior**: bro detects empty config → silently writes 3 default `plugin_config` rows + `tmb_defaults_applied` ledger event → mentions defaults in the welcome banner → continues with the casual greeting. **No `identity` row** is written; the user must explicitly run `tmb_reonboard` to set their name.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | identity table is empty; 3 plugin_config keys present with the documented default values; `tmb_defaults_applied` ledger event recorded exactly once |
| `tools-required.json` | first-action chain MCP probes called + the 3 config_set writes + the ledger_log write |
| `tools-forbidden.json` | `AskUserQuestion` was NOT called (no interactive ceremony); `identity_set` was NOT called (identity stays unset) |
| `cost-budget.json` | Soft budget — first activation should be cheap (~5 MCP writes + a small response) |

## Why this matters

This is the regression test for the no-onboarding doctrine. If a future bro change reintroduces an onboarding ceremony (e.g. by re-adding `tmb_first-run-onboarding` and invoking it from the first-action chain), this flow's `tools-forbidden.json` catches it immediately — `AskUserQuestion` should NEVER fire on first contact.
