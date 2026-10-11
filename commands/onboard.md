---
description: Configure or change identity, branching model, PR target, remotes, issue-sync, headless gates, and the Bash sandbox. Server-driven — bro orchestrates AskUserQuestion rounds.
argument-hint: (none)
allowed-tools: AskUserQuestion, mcp__plugin_tmb_trajectory-server__onboard_state_get, mcp__plugin_tmb_trajectory-server__onboard_get_questions, mcp__plugin_tmb_trajectory-server__onboard_apply, mcp__plugin_tmb_trajectory-server__repos_list, mcp__plugin_tmb_trajectory-server__audit_append
---

# Onboard / Re-onboard

Bro orchestrates an AskUserQuestion ceremony in 4-5 rounds — Round 3 runs only when `shape == 'remote'`. Pass answers between AUQ and the server; all deterministic logic lives in the `onboard_*` MCP tools.

## 1. Read state (one MCP call)

Call `onboard_state_get(agent='bro')`. Returns `{ first_run, current, probe }`. The server re-probes internally on each call, so bro never feeds the probe back — read `state.probe` only to spot a shape/remote conflict in Round 1.

## 2. Ask the questions

Run the AskUserQuestion ceremony in up to five rounds.

### Round 1 — Project shape

Call `onboard_get_questions(agent='bro', round='shape')`. Feed the returned questions into `AskUserQuestion`. When a round returns no questions, skip its AUQ.

Store the answer as `shape` ∈ `{local, remote}`.

#### If the answer conflicts with the probe

Only when the user picks `Local-only` but `state.probe.origin_kind` showed `github`/`gitlab`, surface the contradiction:

> Heads up: this project has a `<github|gitlab>` origin remote, but you picked Local-only. Issues won't mirror to the remote and PRs/MRs won't be tracked. Continue, or switch to Remote-tracked?

Re-render Round 1 once. Trust the user's second answer.

### Round 2 — Branching + PR target (per repo)

Branching model and PR target are per-repo. Enumerate repos with `repos_list(agent='bro')`.

**One repo** — single pass. Call `onboard_get_questions(agent='bro', shape=<shape>, round='main')`, feed into `AskUserQuestion`, no per-repo framing.

**Multiple repos** — loop. For each repo `<name>`:

- Call `onboard_get_questions(agent='bro', shape=<shape>, round='main', repo=<name>)`.
- Feed the returned branching + PR-target questions into `AskUserQuestion`, framed for `<name>`.
- Call `onboard_apply(agent='bro', shape=<shape>, repo=<name>, branching_model=<answer>, pr_target=<answer>)` — writes only that repo's row. `shape` is required (the value resolved in Round 1).

The remote/provider is git-derived (scan), not asked per repo — Round 2 asks only branching + PR target.

When the round returns no questions, skip its AUQ. The server pre-selects the right option, supplies the correct `Keep "<current>"` options on re-onboard, and disables unavailable CLI options.

### Round 3 — Issue sync (remote shape only)

If `shape == 'remote'`, call `onboard_get_questions(agent='bro', shape='remote', round='sync')` and feed the returned questions into `AskUserQuestion`.

### Round 4 — Headless enforcement

Call `onboard_get_questions(agent='bro', round='headless')` and feed the returned question into `AskUserQuestion`. Store the answer as `headless_enforcement` (default `no`). `yes` writes TMB's PreToolUse gates into `<project>/.claude/settings.local.json` so they also fire in headless `claude -p` runs.

### Round 5 — Bash sandbox

Call `onboard_get_questions(agent='bro', round='sandbox')` and feed the returned question into `AskUserQuestion`. Store the answer as `sandbox_enforcement` (default `no`). `yes` writes a Claude Code sandbox block into `<project>/.claude/settings.local.json` that lets Bash write only in this project and the model cache.

## 3. Apply (transactional)

Per-repo branching + PR target are already applied in Round 2 (one `onboard_apply(shape=<shape>, repo=<name>, ...)` per repo, each writing only that repo's row).

The final apply is workspace-level: call `onboard_apply(agent='bro', shape=<shape>, ...)` with **no** `repo` to write the global `issue_sync` answer, `headless_enforcement`, `sandbox_enforcement`, and the `onboarded` marker. `shape` is required on every apply. Omit `branching_model` / `pr_target` on this call so it sets only these workspace answers and leaves per-repo policy intact.

The server accepts both option wire values and their labels. Pass `Keep "<current>"` answers by omitting that field — the server treats omission as "no change". Each apply recomputes protected branches and wraps its writes in a transaction.

Returns `{ ok: true, applied: { onboarded: true, branching_model, pr_target, protected_branches, remotes, issue_sync, headless_enforcement, headless_shim, sandbox_enforcement, sandbox } }`.

## 4. Confirm to the Human

Render a short summary — project shape, then per repo its branching model, PR target, and protected branches, plus the workspace remotes, the global issue sync, headless enforcement, and the Bash sandbox — then close with "Tell me what you want to work on."

## Error handling

If any `onboard_*` call fails, report the exact error, retry once, then halt.
