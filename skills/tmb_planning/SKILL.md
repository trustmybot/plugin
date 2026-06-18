---
name: tmb_planning
description: Bro's code-touching flow — verify world model, propose branch, write spec, dispatch SWE, verify on return, atomic-close. Loaded on the first code-touching ask of a session.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, Task, mcp__plugin_tmb_trajectory-server
---

# Planning — bro's code-touching flow

## 1. Verify the world model

Before anything: `world_model_get(depth=2)`. Returns the project's directory tree with README-derived summaries — bro's working mental picture. If the response carries `warning: 'world-model-empty'`, run `scan_run(source='bro_auto_initial')` yourself to build it — it's deterministic and needs no Human — then re-read.

Zoom-in: `world_model_get(path='src/api', depth=1)`. "Where does X live": `world_model_search(query='X', mode='hybrid')`.

## 2. Triage the requirement

With the world model in hand, before you commit to building — two quick questions (judgment, not a research project):

1. **Is it actionable?** Well-defined, testable, in scope? If it's vague hand-waving, surface the gap via `tmb_concerns-protocol` (or an AUQ) and pin it down *before* authoring a spec.
2. **Does something already do this?** If an existing package or installed capability could plausibly cover it, run `cheatcode_search` for ranked candidates before specing a build-from-scratch — prefer reuse over reinventing.

Record the reuse-vs-build call with `discussion_append(issue_id, author='bro', kind='decision', body='<reuse X / build because …>')`.

## 3. Propose a branch

When a remote is configured, ask the Human which branch to base the new feature branch on — offer the configured `pr_target`, the current branch, and 1–3 prominent local branches. Choosing `pr_target` means check it out and bring it up to date with the remote; any other choice means switch and leave it as-is.

Get a name from `branch_id_propose` (pass the Human's verbatim intent and a short objective), confirm it with the Human ("Proceed with branch_id X?"), then let the `intent_start` composite create the issue, log the intent, and record the planning note in one transaction. Create the git branch locally afterward.

## 4. Author the spec

Pick conservative defaults; name them in `## Description` Assumptions bullets. If the project already uses a different tool, match the project — convention wins over default.

| Dimension | Default |
|---|---|
| Python CLI / test | `argparse` / `unittest` (stdlib); match `pytest` if project uses it |
| Node test | `node:test` (stdlib); match `vitest` / `jest` if project uses them |
| Storage | `~/.<app>/<file>.json` (personal); match project pattern |
| File layout | single file until ~200 LOC |
| Python / concurrency | `python3`; single-user, single-process |

**Typed args** on `task_create_batch` carry the machine-read contract; **spec_body markdown** carries the prose bro and swe reason from.

Pass the machine contract on each swe-executed task — the scope fence reads `files[]`, the verification gate reads `verification[]`:

- `files: string[]` — the paths the task touches.
- `verification: string[]` — runnable bash commands, one per entry, commands only. Each entry holds a command and nothing else — reasoning about what the command proves lives in `## Description`.

Spec body sections are `## Description, ## Success Criteria, ## Out of Scope, ## Commit` — when the scope outgrows one spec, split into multiple tasks linked by `parent_branch_id`:

- `## Description` — ≤3 sentences, file paths with line refs, Assumptions bullets
- `## Success Criteria` — 2–5 testable assertions
- `## Out of Scope`
- `## Commit` — `<emoji> <type>(<scope>): <msg>`

Before `task_create_batch`: `discussion_append(issue_id, author='bro', kind='decision', body='<chosen approach>')`.

### Architectural changes

When the change does any of the following, co-author an ADR at `docs/trustmybot/architecture/manual/decisions/N-*.md` and apply the blast-radius check:

- Touches `docs/trustmybot/architecture/` directly
- Introduces a new service boundary or top-level module
- Modifies a public API surface
- Commits to a strategic stack choice (auth provider, production DB, retention policy)
- Names multiple unrelated surfaces in one task
- Has external side effects (network, billing, message-sending, writes outside the worktree)

Blast-radius (external side effects only): default config is the safe state (opt-in); tests run against `:memory:` only; spec requires a pre-merge `bash tests/run-all.sh` yielding zero external mutations.

## 5. Spawn SWE

Create the tasks with `task_create_batch`, passing the typed `files[]` and `verification[]` for each swe-executed task and asking it to emit the planning-complete event in the same transaction.

Then run the worktree hook per branch and spawn SWE per task.

The batch response includes `parallel_groups` — tasks in the same group are safe to spawn in parallel.

## 6. Verify on SWE return + atomic close

After SWE returns `status=completed`, pull the work (`task_get` plus a `git diff` of the commit) and judge it against the spec on four counts:

1. Changed files match the typed `files[]` — nothing surprising outside scope.
2. The typed `verification[]` commands pass when re-run verbatim inside the SWE worktree.
3. Each `## Success Criteria` bullet is visibly met by the diff.
4. `world_model_get` on the changed directory confirms the change landed where expected.

All four pass → close with the `bro_atomic_close` composite (`close_issue_if_last_task=true` when it's the last task); the post-close hook re-scans so the world model refreshes. Then spawn pr-reviewer for the push gate — the spawn-shape hook enforces the anchors. On a reviewer FAIL: surface it, file the fix as a follow-up issue, and hold the push.

If any of the four checks fails, record it with `bro_verification_fail_record` (name which check and why), leave the task open, and either retry via `task_retry_batch` or escalate.

## Headless overrides (TMB_HEADLESS=1)

`tmb_recovery` §A carries the headless protocol and the per-skill defaults. The one planning-specific mechanic: after `branch_id_propose`, call `headless_intent_start` instead of `intent_start` — it writes the issue, intent, and note atomically and won't duplicate an existing intent — then proceed to step 4.
