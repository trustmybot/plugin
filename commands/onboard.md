---
description: Configure or change identity, branching model, PR target, remotes, and issue-sync. Server-driven — bro orchestrates AskUserQuestion rounds.
argument-hint: (none)
allowed-tools: AskUserQuestion, mcp__plugin_tmb_trajectory-server__onboard_state_get, mcp__plugin_tmb_trajectory-server__onboard_get_questions, mcp__plugin_tmb_trajectory-server__onboard_apply, mcp__plugin_tmb_trajectory-server__audit_log
---

# Onboard / Re-onboard

Bro orchestrates an AskUserQuestion ceremony in 2-3 rounds. All deterministic logic lives in the `onboard_*` MCP tools — bro's job is just to pass answers between AUQ and the server.

## Auto-fire trigger

Bro runs `/onboard` automatically on its first message in a session if `plugin_config.onboarded` is falsy (the empty-DB heuristic). The trigger is silent: no permission gate, no "want me to onboard?" question. `/onboard` also runs on demand whenever the Human types it for later changes.

## Step 1 — Read state (one MCP call)

Call `onboard_state_get(agent='bro')`. Returns `{ first_run, current, probe }`. Bro passes the probe to the server in subsequent calls; it doesn't interpret it.

## Round 1 — Project shape

Call `onboard_get_questions(agent='bro', round='shape')`. Feed the returned questions into `AskUserQuestion`. When a round returns no questions, skip its AUQ.

Store the answer as `shape` ∈ `{local, remote}`.

## Round 2 — Multiple-choice questions (server-built AUQ)

Call `onboard_get_questions(agent='bro', shape=<shape>, round='main')`. Feed the returned questions into `AskUserQuestion`. When the round returns no questions, skip its AUQ and proceed to Round 3 / Apply. The server already pre-selects the right option, supplies the correct `Keep "<current>"` options on re-onboard, and disables unavailable CLI options.

## Round 3 — Issue sync (remote shape only)

If `shape == 'remote'`, call `onboard_get_questions(agent='bro', shape='remote', round='sync')` and feed the returned questions into `AskUserQuestion`.

## Step 4 — Apply (one MCP call, transactional)

Call `onboard_apply` passing each answer. The server accepts both option wire values and their labels. Pass `Keep "<current>"` answers by omitting that field — the server treats omission as "no change". The server writes the `plugin_config.onboarded` marker, persists all config fields, recomputes protected branches, and wraps everything in a transaction.

Returns `{ ok: true, applied: { onboarded: true, branching_model, pr_target, protected_branches, remotes, issue_sync } }`.

## Step 5 — Confirm to the Human

Render the `applied` payload back as a short summary — project shape, branching model, PR target, protected branches, remotes, and issue sync — then close with "Tell me what you want to work on."

## Conflict handling

If the user picks `Local-only` on Round 1 but `state.probe.origin_kind` showed `github`/`gitlab`, surface the contradiction:

> Heads up: this project has a `<github|gitlab>` origin remote, but you picked Local-only. Issues won't mirror to the remote and PRs/MRs won't be tracked. Continue, or switch to Remote-tracked?

Re-render Round 1 once. Trust the user's second answer.

## Headless mode

`/onboard` is interactive by definition. If `TMB_HEADLESS=1` or AskUserQuestion errors, Step 1 (`onboard_state_get`) still runs — the halt-reply must cite the current shape. Then log `headless_reonboard_blocked` via `audit_log` (issue_id='-1') and surface: `Re-onboarding requires interactive input. Re-run with a Human in the loop, or use \`config_set\` directly if you know the values.`

Rationale: onboarding flips policy keys that drive `git-guards.sh`. Silent fallback could break the project's git workflow with no audit trace.

## Error handling

If any `onboard_*` call fails, report the exact error, retry once, then halt.
