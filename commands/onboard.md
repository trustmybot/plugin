---
description: Configure or change identity, branching model, PR target, remotes, and issue-sync. Server-driven — bro orchestrates AskUserQuestion rounds; the MCP `onboard_*` tools own every if/else branch (probe, Keep options, derived defaults, transactional persistence).
argument-hint: (none)
---

# Onboard / Re-onboard

Bro orchestrates an AskUserQuestion ceremony in 2-3 rounds. **All deterministic logic lives in the `onboard_*` MCP tools** — bro's job is just to pass answers between AUQ and the server.

## Auto-fire trigger

Bro runs `/onboard` automatically on its first message in a session if `state.first_run === true` (the empty-DB heuristic — no `identity` row exists). The trigger is silent: no permission gate, no "want me to onboard?" question. `/onboard` also runs on demand whenever the Human types it for later changes.

## Scope

Allowed:
- `AskUserQuestion`
- `mcp__plugin_tmb_trajectory-server__onboard_state_get`
- `mcp__plugin_tmb_trajectory-server__onboard_get_questions`
- `mcp__plugin_tmb_trajectory-server__onboard_apply`

Out of scope: every other MCP tool, Bash, Read, Edit, Write. The slash command persists state via `onboard_apply` only — no direct `config_set` / `identity_set` / Bash probes from bro.

## Step 1 — Read state (one MCP call)

```
state = onboard_state_get(agent='bro')
```

Returns `{ first_run, current, probe }`. Bro doesn't interpret the probe — it's already pre-baked into the question structures the server returns next.

## Round 1 — Project shape (single AUQ — hardcoded options, no logic)

```
AskUserQuestion({
  questions: [{
    question: "Is this project local-only or remote-tracked?",
    header: "Shape",
    multiSelect: false,
    options: [
      { label: "Local-only",     description: "No GitHub/GitLab. Issues stay in the local trajectory DB; no PR/MR pushes." },
      { label: "Remote-tracked", description: "Pushes to GitHub or GitLab. We'll ask about issue mirroring next." }
    ]
  }]
})
```

Pre-select hint: if `state.probe.origin_kind` is `github` or `gitlab`, render `Remote-tracked` first; otherwise `Local-only` first.

Store the answer as `shape` ∈ `{local, remote}`.

## Round 2 — Multiple-choice questions (server-built AUQ)

```
r2 = onboard_get_questions(agent='bro', shape=<shape>, round='main')
```

The server returns the multi-choice question set. Bro doesn't ask for the user's name anywhere — the identity table is a pure onboarded-marker, no name stored.

| shape | first_run | round=main returns |
|---|---|---|
| `local` | `true`  | (empty — branching defaults silently; skip AUQ Round 2) |
| `local` | `false` | Branching (with Keep option) |
| `remote` | either | Branching + PR target + Remote |

If `r2.questions` is empty (local first-run), skip AUQ entirely — proceed straight to Round 3 / Apply. Otherwise feed `r2.questions` into `AskUserQuestion`. Each question already carries the right `Keep "<current>"` option (or omits it on first-run), the right disabled CLI options (gh/glab not installed), and the right pre-select index.

## Round 3 — Issue sync (remote shape only)

```
if (shape == 'remote') {
  r3 = onboard_get_questions(agent='bro', shape='remote', round='sync')
  AskUserQuestion({ questions: r3.questions })
}
```

The server picks the right `Auto`/`Off` description text based on whether `gh`/`glab` auth detected — bro doesn't render the warning manually.

## Step 4 — Apply (one MCP call, transactional)

```
onboard_apply(agent='bro', shape=<shape>, branching_model=<answer>, pr_target=<answer>, remote=<answer>, issue_sync=<answer>)
```

The server:

- Writes the identity row at id=1 as the onboarded marker (no name or other fields stored — just the row's existence).
- Persists `branching_model`, `pr_target`, `remotes`, `issue_sync`.
- Recomputes `protected_branches` from the branching model + PR target.
- Defaults missing fields on local shape (`branching_model`='github-flow', `pr_target`=derived, `remotes`=`[]`, `issue_sync`='off').
- Wraps the whole thing in `db.transaction(...)` so partial onboards never land.

Returns `{ ok: true, applied: { onboarded: true, branching_model, pr_target, protected_branches, remotes, issue_sync } }`.

## Step 5 — Confirm to the Human

Render the `applied` payload back as a short summary:

> Done. Settings updated:
> - Project shape: `<local|remote>`
> - Branching model: `<branching_model>`
> - PR target: `<pr_target>`
> - Protected branches: `<protected_branches.join(", ")>`
> - Remotes: one line per `{ name } → { provider }`, or `none — local-only` if empty
> - Issue sync: `<issue_sync>`
>
> Tell me what you want to work on.

## Answer translation

Bro translates AUQ answer strings back to the wire format `onboard_apply` expects:

| AUQ answer | Wire value |
|---|---|
| `Keep "<current>"` (any field) | omit that field — server treats omission as "no change" |
| `"GitHub Flow"` | `branching_model="github-flow"` |
| `"Git Flow"` | `branching_model="gitflow"` |
| `"GitHub"` | `remote="github"` |
| `"GitLab"` | `remote="gitlab"` |
| `"Both"` | `remote="both"` |
| `"main" / "develop" / "master"` | `pr_target="<lowercase>"` |
| `"Auto …"` / `"Off …"` | `issue_sync="auto"` / `"off"` |

## Conflict handling

If the user picks `Local-only` on Round 1 but `state.probe.origin_kind` showed `github`/`gitlab`, surface the contradiction:

> Heads up: this project has a `<github|gitlab>` origin remote, but you picked Local-only. Issues won't mirror to the remote and PRs/MRs won't be tracked. Continue, or switch to Remote-tracked?

Re-render Round 1 once. Trust the user's second answer.

## Headless mode

`/onboard` is interactive by definition. If `TMB_HEADLESS=1` or AskUserQuestion errors:

```
audit_log(agent='bro', issue_id='999999', kind='event',
          event_type='headless_reonboard_blocked',
          summary='Cannot run /onboard headless: policy keys require explicit Human re-confirmation. Tell the Human to run /onboard interactively.')
```

Surface: `Re-onboarding requires interactive input. Re-run with a Human in the loop, or use \`config_set\` directly if you know the values.`

Rationale: onboarding flips policy keys that drive `git-guards.sh`. Silent fallback could break the project's git workflow with no audit trace.

## Error handling

| Trigger | Response |
|---|---|
| `onboard_state_get` fails | Report the exact error, retry once, then halt. Cannot proceed without state. |
| `onboard_get_questions` fails | Same — halt cleanly. |
| `onboard_apply` returns `error` | Report the error verbatim, retry once. If the second attempt fails, halt and tell the Human to re-run `/onboard`. |
