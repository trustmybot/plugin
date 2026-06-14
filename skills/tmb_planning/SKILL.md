---
name: tmb_planning
description: Bro's code-touching flow — verify world model, propose branch, write spec, dispatch SWE, verify on return, atomic-close. Loaded on the first code-touching ask of a session.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, Task, mcp__plugin_tmb_trajectory-server
---

# Planning — bro's code-touching flow

## 1. Verify the world model

Before anything: `world_model_get(depth=2)`. Returns the project's directory tree with README-derived summaries — bro's working mental picture. If the response carries `warning: 'world-model-empty'`, run `scan_run(source='bro_auto_initial')` yourself to build it — it's deterministic and needs no Human — then re-read. Without the world model bro is planning blind.

Zoom-in: `world_model_get(path='src/api', depth=1)`. "Where does X live": `world_model_search(query='X', mode='hybrid')`.

## 2. Propose a branch

When a remote is configured, ask the Human which branch to base the new feature branch on — offer the configured `pr_target`, the current branch, and 1–3 prominent local branches. Choosing `pr_target` means check it out and bring it up to date with the remote; any other choice means switch and leave it as-is.

Get a name from `branch_id_propose` (pass the Human's verbatim intent and a short objective), confirm it with the Human ("Proceed with branch_id X?"), then let the `intent_start` composite create the issue, log the intent, and record the planning note in one transaction. Create the git branch locally afterward.

## 3. Author the spec

Pick conservative defaults; name them in `## Description` Assumptions bullets. If the project already uses a different tool, match the project — convention wins over default.

| Dimension | Default |
|---|---|
| Python CLI / test | `argparse` / `unittest` (stdlib); match `pytest` if project uses it |
| Node test | `node:test` (stdlib); match `vitest` / `jest` if project uses them |
| Storage | `~/.<app>/<file>.json` (personal); match project pattern |
| File layout | single file until ~200 LOC |
| Python / concurrency | `python3`; single-user, single-process |

Spec body sections — when the scope outgrows one spec, split into multiple tasks linked by `parent_branch_id`:

- `## Description` — ≤3 sentences, file paths with line refs, Assumptions bullets
- `## Files` — path — action
- `## Success Criteria` — 2–5 testable assertions
- `## Verification` — exact bash commands
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

## 4. Spawn SWE

Create the tasks with `task_create_batch`, asking it to emit the planning-complete event in the same transaction. `waive_scope_gate` is valid for truly trivial work (`'trivial: <what>'`) or headless mode (`'headless mode, defaults applied; <one-line scope summary>'`).

Then run the worktree hook per branch and spawn SWE per task — the post-create hint carries the exact spawn recipe.

The batch response includes `parallel_groups` — tasks in the same group are safe to spawn in parallel.

## 5. Verify on SWE return + atomic close

After SWE returns `status=completed`, pull the work (`task_get` plus a `git diff` of the commit) and judge it against the spec on four counts:

1. Changed files match `## Files` — nothing surprising outside scope.
2. `## Verification` commands pass when re-run verbatim inside the SWE worktree. Run these BEFORE you close — the cleanup hook removes the worktree on close, taking the working tree with it.
3. Each `## Success Criteria` bullet is visibly met by the diff.
4. `world_model_get` on the changed directory confirms the change landed where expected.

All four pass → close with the `bro_atomic_close` composite (`close_issue_if_last_task=true` when it's the last task); the post-close hook re-scans so the world model refreshes. Then spawn pr-reviewer for the push gate — the spawn-shape hook enforces the anchors. On a reviewer FAIL: surface it, file the fix as a follow-up issue, and hold the push.

If any of the four checks fails, record it with `bro_verification_fail_record` (name which check and why), leave the task open, and either retry via `task_retry_batch` or escalate.

## Headless overrides (TMB_HEADLESS=1)

No Human in the loop — skip AUQs, apply the documented defaults (see `tmb_recovery` §A per-skill defaults table), and record the fallback. After `branch_id_propose`, call `headless_intent_start` — it writes the issue, intent, and note atomically and won't duplicate an intent that already exists — then proceed to step 3.
