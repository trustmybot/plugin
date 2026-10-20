---
description: Configure or change identity, branching model, PR target, remotes, issue-sync, and the Bash sandbox. Server-driven — bro orchestrates AskUserQuestion rounds.
argument-hint: (none)
allowed-tools: AskUserQuestion, mcp__plugin_tmb_trajectory-server__onboard_state_get, mcp__plugin_tmb_trajectory-server__onboard_get_questions, mcp__plugin_tmb_trajectory-server__onboard_apply, mcp__plugin_tmb_trajectory-server__repos_list, mcp__plugin_tmb_trajectory-server__audit_append
---

# Onboard / Re-onboard

Bro orchestrates an AskUserQuestion ceremony in 3-5 rounds — Round 0 runs only when the session is nested below the project or another trajectory DB exists, Round 3 only when `shape == 'remote'`. Pass answers between AUQ and the server; all deterministic logic lives in the `onboard_*` MCP tools.

## 1. Read state (one MCP call)

Call `onboard_state_get(agent='bro')`. Returns `{ first_run, current, probe, nesting, scan }`. The server re-probes internally on each call, so bro never feeds the probe back — read `state.probe` only to spot a shape/remote conflict in Round 1, `state.nesting` for Round 0, and `state.scan` for Round 2. `scan` is the offline pre-onboard scan of every registered repo: `scan.summary` (`repo_count`, `hosts`, `with_dev_branch`, `main_only`, `uniform`) and one `scan.repos[]` entry per repo with its evidence and recommendation.

## 2. Ask the questions

Run the AskUserQuestion ceremony in up to five rounds.

Every question from `onboard_get_questions` carries `evidence` (short facts from the scan) and `recommended_reason` (why the option marked `recommended: true` comes first, or `null` when the evidence picks none). Before each AskUserQuestion, write that round's `evidence` lines in chat as a short list, each line once, then each question's `recommended_reason` as one sentence. They stay in chat prose: feed the option labels and descriptions to AskUserQuestion exactly as the server built them. The Human confirms what the scan found instead of guessing.

### Round 0 — Which project (only when nested)

`nesting` is `{ session_dir, project_root, nested, other_dbs: [{path, issues, tasks, empty}] }`. Skip this round when `nested` is false and `other_dbs` is empty.

Otherwise explain in chat first: this session opened in `session_dir`, but the TMB project it uses is the workspace at `project_root`; list each `other_dbs` entry with its path and its issue and task counts. Then ask one AskUserQuestion:

- **Use workspace `<project_root>` (Recommended)** — keep the workspace project. For each `other_dbs` entry with `empty: true`, ask whether to remove that empty DB (one Yes/No question per DB). Collect the paths the Human said yes to and pass them as `remove_stray_dbs=[...]` with the final workspace apply in step 3 (or in an `onboard_apply(agent='bro', remove_stray_dbs=[...])` call of their own if the ceremony stops early). The server deletes a DB only while it is still empty and below the project root, and reports each refusal; a DB with any issue or task is never offered or removed. Continue with Round 1.
- **Make `<session_dir>` its own TMB project** — offer this only when `nested` is true. Call `onboard_apply(agent='bro', standalone=true)` on its own. The server writes a `standalone` marker and a fresh DB under `session_dir`. Tell the Human to restart the session (quit and relaunch Claude Code in `session_dir`), then run `/onboard` again there. Stop this ceremony.
- **Cancel** — stop. Call no apply; nothing is written.

### Round 1 — Project shape

Call `onboard_get_questions(agent='bro', round='shape')`. Open the round with the scan summary sentence — the question's first `evidence` line, built from `state.scan.summary` ("Found N git repositories under this folder; …") — and its `recommended_reason`, then feed the returned questions into `AskUserQuestion`. When a round returns no questions, skip its AUQ.

Store the answer as `shape` ∈ `{local, remote}`.

#### If the answer conflicts with the probe

Only when the user picks `Local-only` but `state.probe.origin_kind` showed `github`/`gitlab`, surface the contradiction:

> Heads up: this project has a `<github|gitlab>` origin remote, but you picked Local-only. Issues won't mirror to the remote and PRs/MRs won't be tracked. Continue, or switch to Remote-tracked?

Re-render Round 1 once. Trust the user's second answer.

### Round 2 — Branching + PR target

Branching model and PR target are per-repo. Enumerate repos with `repos_list(agent='bro')`.

**Once** — when there is one repo or `state.scan.summary.uniform` is true (every repo points the same way). Call `onboard_get_questions(agent='bro', shape=<shape>, round='main')`, show its evidence lines and reasons, and feed the questions into `AskUserQuestion`. Then call `onboard_apply(agent='bro', shape=<shape>, repo=<name>, branching_model=<answer>, pr_target=<answer>)` once per repo with the same answers.

**Per repo** — otherwise. For each repo `<name>`:

- Call `onboard_get_questions(agent='bro', shape=<shape>, round='main', repo=<name>)`.
- Name the repo in chat, quote that repo's own `evidence` lines and `recommended_reason`, then feed the returned branching + PR-target questions into `AskUserQuestion`.
- Call `onboard_apply(agent='bro', shape=<shape>, repo=<name>, branching_model=<answer>, pr_target=<answer>)` — writes only that repo's row.

`shape` is required on each apply (the value resolved in Round 1). The per-repo questions run for either shape and are branching + PR target only.

When the round returns no questions, skip its AUQ. The server puts the recommended option first and pre-selects it, keeps `Keep "<current>"` first on re-onboard, and disables unavailable CLI options.

### Round 3 — Issue sync (remote shape only)

If `shape == 'remote'`, call `onboard_get_questions(agent='bro', shape='remote', round='sync')` and feed the returned questions into `AskUserQuestion`.

### Round 4 — Bash sandbox

Call `onboard_get_questions(agent='bro', round='sandbox')` and feed the returned question into `AskUserQuestion`. Store the answer as `sandbox_enforcement` (default: the question's first option). The Yes/No question itself names `<project>/.claude/settings.local.json` and the keys it writes, so the Human consents to that exact edit. `yes` writes a Claude Code sandbox block into that file that keeps Bash writes in this project and the model cache, and gives Bash a network allow-list of the hosts TMB needs plus the host of each of the repo's HTTPS remotes. On a fresh onboard the question defaults to `Yes (Recommended)` only on the platform the recorded sandbox probe measured (macOS today) and only when no git remote uses SSH; otherwise it defaults to `No`. `yes` also sets `env` entries `npm_config_cache` and `BUN_INSTALL_CACHE_DIR` pointing under the plugin state dir's `cache/`, and on macOS only `sandbox.enableWeakerNetworkIsolation`, which slightly weakens isolation so Go tools such as `gh` can reach the TLS trust service. When TMB creates `settings.local.json` in a git work tree, it adds the file to `.gitignore`.

## 3. Apply (transactional)

Per-repo branching + PR target are already applied in Round 2 (one `onboard_apply(shape=<shape>, repo=<name>, ...)` per repo, each writing only that repo's row).

The final apply is workspace-level: call `onboard_apply(agent='bro', shape=<shape>, ...)` with **no** `repo` to write `remote` (the Round 2 Remote answer; on the per-repo path omit `remote` and the server probes each repo's git remotes, warning when none has one), the global `issue_sync` answer, `sandbox_enforcement`, and the `onboarded` marker, plus `remove_stray_dbs` from Round 0 when the Human chose any. `shape` is required on every apply except the Round 0 ones (`standalone=true` alone, or `remove_stray_dbs` alone). Omit `branching_model` / `pr_target` on this call: it sets only these workspace answers, never changes a repo's Round 2 policy, and gives a repo that has none yet GitHub Flow and its default branch.

The server accepts both option wire values and their labels. Pass `Keep "<current>"` answers by omitting that field — the server treats omission as "no change". Each apply recomputes protected branches and wraps its writes in a transaction.

Returns `{ ok: true, stray_dbs?: { removed, refused }, applied: { onboarded: true, branching_model, pr_target, protected_branches, remotes, issue_sync, headless_enforcement, headless_shim, sandbox_enforcement, sandbox } }`. `headless_enforcement` is not asked during onboarding and stays `no` unless enabled on request (see below).

The apply never touches the project's `CLAUDE.md`: bro's persona loads from the plugin through its persona hooks. `onboard_apply` takes no `persona` argument and rejects one with `persona_input_removed`.

## Headless runs (on request)

Plugin hooks do not fire in non-interactive `claude -p` runs. When the Human mentions `claude -p`, `claude --print`, headless, non-interactive or CI runs, the `headless-intent` hint fires on bro's turn. Bro asks ONE AskUserQuestion consent that names `<project>/.claude/settings.local.json` and the number of PreToolUse hook entries it writes:

- **Yes** — call `onboard_apply(agent='bro', headless_enforcement='yes')`. The server accepts it alone on an onboarded project and refuses it before `/onboard`.
- **No** — write nothing.

`TMB_DISABLE_HEADLESS_HINT=1` silences the hint.

## 4. Confirm to the Human

Render a short summary — project shape, then per repo its branching model, PR target, and protected branches, plus the workspace remotes, the global issue sync, and the Bash sandbox — then close with "Tell me what you want to work on."

## Error handling

If any `onboard_*` call fails, report the exact error, retry once, then halt.
