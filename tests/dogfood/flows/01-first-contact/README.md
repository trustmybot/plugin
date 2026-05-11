# 01-first-contact

**Replaces** the prior contract ("bro greets, no writes") which is now obsolete. Per the new auto-fire doctrine, bro detects an empty identity row on first contact and fires `/onboard` automatically. In headless L5 the AUQ ceremony hits the deny hook and `/onboard` halts cleanly with a `headless_reonboard_blocked` audit event.

**Pre-state** (`empty` fixture): schema only. `plugin_config` is pre-populated by `schema.sql` with default policy keys; `identity` is empty (no row at id=1); `audit` is empty; the system issue (id=-1) is schema-seeded so the headless-block audit_log has somewhere to attach.

**Trigger**: `@bro hi`

**Expected behavior**:

1. Bro reads `onboard_state_get(agent='bro')` → sees `first_run=true` (no identity row).
2. Bro auto-fires `/onboard` (no permission gate).
3. `/onboard` renders Round 1 AUQ (project shape).
4. `auq-headless-deny.sh` hook denies AUQ in headless mode.
5. `/onboard` catches the deny and writes a `headless_reonboard_blocked` audit event with `/onboard` in its summary, attached to issue -1.
6. Bro halts cleanly with a surface message telling the Human to re-run interactively.

**Identity must remain empty** — `/onboard` couldn't complete, so no `identity_set` and no policy-key writes landed.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | (1) identity table still empty (proves `/onboard` halted before write). (2) ≥1 audit event with `/onboard` in summary OR `headless_reonboard_blocked` event_type (proves auto-fire reached the headless-block path). (3) plugin_config defaults still at schema-seeded values (proves no partial onboard write). |
| `tools-required.json` | `onboard_state_get` (the empty-DB detection) + `audit_log` (the headless-block event) |
| `tools-forbidden.json` | `onboard_apply` (must not complete onboard in headless), `task_create_batch` (out of scope), `validation_record` (out of scope) |
| `cost-budget.json` | Tight — first contact in headless is just a probe + halt + audit (~5K tokens) |

## Why this matters

Regression test for the auto-fire trigger. If a future change drops the `first_run` detection or re-opens the AUQ-deny window in headless, this flow catches it. The doctrine: **empty identity row = onboard pending; bro fires the ceremony, but headless is a hard stop, not a silent default.**
