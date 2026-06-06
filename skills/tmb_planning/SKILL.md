---
name: tmb_planning
description: Bro's code-touching flow — verify world model, propose branch, write spec, dispatch SWE, verify on return, atomic-close. Loaded on the first code-touching ask of a session.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, Task, mcp__plugin_tmb_trajectory-server
---

# Planning — bro's code-touching flow

## 1. Verify the world model

Before anything: `world_model_get(depth=2)`. Returns the project's directory tree with README-derived summaries — bro's working mental picture. If the response carries `warning: 'world-model-empty'`, tell the Human to run `/scan` first. Without it bro is planning blind.

Zoom-in: `world_model_get(path='src/api', depth=1)`. "Where does X live": `world_model_search(query='X', mode='hybrid')`.

## 2. Propose a branch

When a remote is configured:

```
AskUserQuestion: "Which branch should I create the new feature branch from?"
options: [pr_target (pull origin/<pr_target> first) | <current_branch> | 1–3 prominent local branches]
```

On `pr_target`: `git fetch origin ${pr_target} && git checkout ${pr_target} && git pull --ff-only`. On a non-pr_target: switch; leave the branch as-is.

Then derive + propose:

```
{ branch_id, confidence } = branch_id_propose(agent='bro', intent=<verbatim>, objective=<short>)
```

```
AskUserQuestion: "Proceed with branch_id <X>?"
options: [Yes, proceed | Suggest different branch_id]
```

On Yes:

```
issue_create(agent='bro', objective=<short>)
discussion_append(issue_id, author='bro', kind='intent', body=<verbatim>)
discussion_append(issue_id, author='bro', kind='note',   body='Beginning planning on ${branch_id}.')
git branch "${branch_id}"
```

Create the branch but **stay on the base** — don't switch the main checkout to it. SWE's worktree owns `${branch_id}` while the task runs; the main checkout sits on the base branch for the duration.

## 3. Author the spec

Pick conservative defaults; name them in `## Description` Assumptions bullets. If the project already uses a different tool, match the project — convention wins over default.

| Dimension | Default |
|---|---|
| Python CLI / test | `argparse` / `unittest` (stdlib); match `pytest` if project uses it |
| Node test | `node:test` (stdlib); match `vitest` / `jest` if project uses them |
| Storage | `~/.<app>/<file>.json` (personal); match project pattern |
| File layout | single file until ~200 LOC |
| Python / concurrency | `python3`; single-user, single-process |

Spec body sections (≤200 lines; split into multiple tasks linked by `parent_branch_id` if longer):

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

```
task_create_batch(agent='bro', issue_id=<I>, tasks=[{branch_id, spec_body, ...}], emit_planning_complete=true, ...)
```

`waive_scope_gate` is valid for truly trivial work (`'trivial: <what>'`) or headless mode (`'headless mode, defaults applied; <one-line scope summary>'`).

Then: `git worktree add .claude/worktrees/<slug> <branch_id>`, then `Task(subagent_type='swe', isolation='worktree', prompt='task_id=<N> worktree=.claude/worktrees/<slug>')`. Parallel spawns when tasks have no overlapping `## Files`; sequential when they share files.

## 5. Verify on SWE return + atomic close

After SWE returns `status=completed`:

**V1** — pull: `task_get(task_id=<N>)` + `git diff <commit_sha>~1..<commit_sha>`.

**V2** — three checks:
1. Changed files match `## Files`. No surprise files outside scope.
2. `## Verification` commands pass — re-run verbatim inside the SWE worktree. Do this BEFORE V3 — the cleanup hook removes the worktree on close.
3. Each `## Success Criteria` bullet visibly met by the diff.

**V3** — all pass → `bro_atomic_close(agent='bro', task_id=<N>, commit_sha=<sha>, verification_summary='...', close_issue_if_last_task=true)`. The post-close hook re-scans automatically — the world model refreshes.

Then spawn pr-reviewer for the push gate (see `tmb_review` §B). On PASS: `git push -u origin <branch>`. On FAIL: surface, file the fix as a follow-up issue, do not push.

**V3 — any check fails**: `bro_verification_fail_record(agent='bro', task_id=<N>, which_check='<V1|V2|V3>', details='<≤500 chars>')`. Leave the task open. Retry via `task_retry_batch` (max 3) or escalate.

## Headless overrides (TMB_HEADLESS=1)

No Human in the loop — skip AUQs, apply the documented defaults, and record the fallback. After `branch_id_propose`, run step 2's "On Yes" block (issue_create + intent/note `discussion_append` + branch create) without the AUQs to get `<I>` and `<branch_id>`, then call `headless_intent_start(agent='bro', issue_id=<I>, branch_id=<branch_id>, intent_verbatim=<verbatim>, fallback_summary='<defaults applied>')`, then proceed to step 3.

| AUQ | Default |
|---|---|
| Base-branch | `${pr_target}` |
| Branch-id confirm | "Yes, proceed" |
| Difficult Q+A | "proceed as proposed" |

`tmb_skill-creator` and `/tmb:agent-create` from-scratch mode HALT in headless mode — silent skill/agent generation in CI is the foot-gun this guards.
