---
name: tmb_planning
description: Bro's full code-touching flow — cold-start judgment, branch_id confirm, spec authoring (defaults table + ADR when architectural), decision audit, SWE spawn, V1/V2/V3 verification, atomic close, retry-on-fail. Loaded on the first code-touching ask of a session. Self-contained — everything bro needs is here.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, Task, mcp__plugin_tmb_trajectory-server
---

# Planning — bro's code-touching flow

The deterministic substrate (project inventory, registry warmth) lands
as `additionalContext` from `session-start-prescan.sh` before this skill
loads. The mechanical pre-checks (scope-ambiguity gate, branch-id-proposed
audit, source-edit guard) are wire-enforced. This skill is what bro decides.

## Headless fast path (TMB_HEADLESS=1)

**Skip every AUQ.** No Human means no answer; rendering an AUQ incurs
a deny-and-recover round trip per question. The 6-step recipe below is
fully self-contained.

1. `branch_id_propose(agent='bro', intent=<verbatim>, objective=<short>)` → take returned `branch_id`.
2. `issue_create(agent='bro', objective=<short>, description=<2-sentence summary>)`.
3. `headless_intent_start(agent='bro', issue_id=<I>, branch_id=<branch_id>, intent_verbatim=<verbatim>, fallback_summary='<defaults applied>')` — writes headless_fallback audit + note + intent in one transaction. <!-- enforced by: headless_intent_start composite (mech 2) -->
4. `discussion_append(issue_id=<I>, author='bro', kind='decision', body='<chosen approach: what, why, trade-offs>')`. Required by the server-side decision gate on `task_create_batch`.
5. `git switch -c <branch_id>` (the WorktreeCreate hook routes to the right inner repo when in a workspace).
6. Author the spec body inline using the template in §"Spec body template". For architectural changes (touches `docs/trustmybot/architecture/`, schema, public API, or external side effects) also co-author an ADR at `docs/trustmybot/architecture/manual/decisions/N-*.md` and apply the blast-radius checklist (see §"Architectural changes" below).
7. `task_create_batch(agent='bro', issue_id=<I>, tasks=[{branch_id, description, spec_body}], emit_planning_complete=true, waive_scope_gate=true, waive_scope_gate_reason='headless mode: defaults applied; <one-line scope summary>')`.
8. Spawn SWE: `git worktree add .claude/worktrees/<slug> <branch_id>`, then `Task(subagent_type='swe', isolation='worktree', prompt='task_id=<N> worktree=.claude/worktrees/<slug>')`.

Interactive (Human-present) flow continues at Step 0.

## Step 0 — Cold-start codebase memory

Fires when `session-start-prescan.sh` reported `file_registry: cold` AND `N source > 0`.

**Tell the Human to run `/scan`.** The slash command is the deterministic path: bash + git + md5 populate `repos` + `file_registry` and emit a `deep_scan_completed` audit row, which clears the registry-cold gate on `task_create_batch`. Phase 2 of `/scan` dispatches background subagents to fill summaries in parallel — non-blocking.

<!-- enforced by: server registry_cold_violation gate (mech 1) — relay the error message if it fires -->

Drift (warm + dirty / branch behind / HEAD moved) is handled automatically by the post-task-close auto-rescan hook — md5-only invalidation preserves summaries on unchanged files.

## Step 1 — Architectural-change check (judgment)

Most code-touching work is everyday: bro picks defaults, writes a one-paragraph `kind='decision'` body, and dispatches SWE. A small subset needs more rigor — those changes also require an ADR + the blast-radius checklist. See §"Architectural changes" below for the criteria + ceremony.

Either way bro writes **one** `kind='decision'` discussion summarizing the chosen approach. <!-- enforced by: decision gate on task_create_batch (mech 3) -->

(Note: when the human wants alignment before bro commits to a plan, they enter Claude Code's native plan mode — bro doesn't drive a bespoke Q+A loop. The decision-audit row captures the outcome of that conversation.)

## Step 2 — Branch-id + Human confirm (interactive)

When a remote is configured, render:

```
AskUserQuestion: "Which branch should I create the new feature branch from?"
options: [pr_target (pull origin/<pr_target> first) | <current_branch> | 1-3 prominent local branches]
```

On `pr_target`: `git fetch origin ${pr_target} && git checkout ${pr_target} && git pull --ff-only`.
On non-pr_target: switch; leave the branch as-is (no auto-pull). Any git error: halt and surface.

Then derive + propose:

```
{ branch_id, confidence } = branch_id_propose(agent='bro', intent=<verbatim>, objective=<short>)
```

Render branch-id confirm AUQ:

```
AskUserQuestion: "Proceed with branch_id <X>?"
options: [Yes, proceed | Suggest different branch_id]
```

On Yes: <!-- enforced by: branch_id_proposed audit gate (mech 3) + conventional-format regex (mech 3) -->

```
issue_create(agent='bro', objective=<short>)
discussion_append(issue_id, author='bro', kind='intent', body=<verbatim>)
discussion_append(issue_id, author='bro', kind='note',   body='Beginning planning on ${branch_id}.')
git switch -c "${branch_id}"
audit_log(agent='bro', from_node='bro', issue_id=<I>, branch_id=<branch_id>, event_type='branch_id_proposed', summary='Branch <branch_id> created from origin/<base>.')
```

## Step 3 — Spec authoring

Pick conservative defaults, name them in `## Description` "Assumptions:" bullets. If the project already uses a different tool, **match the existing pattern** — convention wins over default.

| Dimension | Default |
|---|---|
| Python CLI / test | `argparse` / `unittest` (stdlib); match `pytest` if project uses it |
| Node test | `node:test` (stdlib); match `vitest` / `jest` if project uses them |
| Storage | `~/.<app>/<file>.json` (personal), match existing pattern (project) |
| File layout | single file until ~200 LOC |
| Python version / concurrency | `python3`; single-user, single-process |

Decision audit before `task_create_batch`: `discussion_append(kind='decision', body='<chosen approach>')`. <!-- enforced by: decision gate (mech 3) — rejected if missing -->

The **scope-ambiguity gate** also stays: waivable for truly trivial changes. <!-- enforced by: scope gate on task_create_batch (mech 3) -->

### Architectural changes — ADR + blast-radius check

When the change does any of the following, also co-author an ADR + apply the blast-radius check:

- Touches `docs/trustmybot/architecture/` directly
- Introduces a new service boundary or top-level module
- Modifies a public API surface
- Commits to a strategic stack choice (auth provider, production DB, retention policy)
- Names multiple unrelated surfaces in one task
- Has external side effects (network, real API mutations, billing, message-sending, writes outside the worktree)

ADR location: `docs/trustmybot/architecture/manual/decisions/N-*.md` (see `templates/docs-trustmybot/architecture/manual/decisions/0001-example.md`).

<!-- LOAD-BEARING-SAFETY: blast-radius checklist is required for all external-side-effect changes; any miss blocks GA -->
Blast-radius checklist (external side effects only): default config MUST be the safe state (opt-in); tests run only against the `:memory:` DB on default; spec MUST require a pre-merge `bash tests/run-all.sh` yielding zero external mutations. Any miss → spec back for revision.

If the human wants to deliberate on the architectural direction before bro commits, they enter **Claude Code's native plan mode** (Shift+Tab).

## Spec body template (max 8000 chars)

Self-contained — inline all referenced content. Sections: `## Description` (≤3 sentences, file paths with line refs, Assumptions bullets), `## Files` (path — action), `## Success Criteria` (2–5 testable assertions), `## Verification` (exact bash commands), `## Out of Scope`, `## Commit` (`<emoji> <type>(<scope>): <msg>`). Split into multiple tasks linked by `parent_branch_id` if it exceeds 200 lines.

## Step 4 — Spawn SWE

`task_create_batch(agent='bro', issue_id=<I>, tasks=[{branch_id, spec_body, ...}], emit_planning_complete=true, ...)` — see MCP schema for full parameter list. <!-- enforced by: emit_planning_complete=true flag emits closing audit in same DB transaction (mech 2) -->

**`waive_scope_gate` use cases** — two valid:

1. **Truly trivial work** (typo fix, one-line doc, mechanical rename per the user's exact request). Reason: `'trivial: <what>'`.
2. **Headless mode (TMB_HEADLESS=1).** No Human in the loop means no chance to ask a clarifying question. Reason: `'headless mode, defaults applied; <one-line scope summary>'`.

Spawn: `git worktree add .claude/worktrees/<slug> <branch_id>`, then `Task(subagent_type='swe', isolation='worktree', prompt='task_id=<N> worktree=.claude/worktrees/<slug>')`. `<slug>` = everything after the `<type>/` prefix. Parallel spawns when tasks have no overlapping `## Files`; sequential when they share files.

## Step 5 — Verify + atomic close

After SWE returns `completed`:

**V1 — Pull**: `task_get(task_id=<N>)` + `git diff <commit_sha>~1..<commit_sha>`

**V2 — Three checks (all required)**
1. Files match `## Files` — every changed file listed; no surprise files outside scope.
2. `## Verification` commands pass — re-run verbatim inside the SWE worktree. Run V2 BEFORE V3 — the `cleanup-worktree-on-task-close.sh` hook removes the worktree on close.
3. Each `## Success Criteria` bullet visibly met by the diff.

**V3 — All three pass → one atomic call**: `bro_atomic_close(agent='bro', task_id=<N>, commit_sha=<sha>, file_summaries=[...], verification_summary='...', close_issue_if_last_task=true)` — see MCP schema. <!-- enforced by: bro_atomic_close composite (mech 2) -->

<!-- LOAD-BEARING-SAFETY: bro is forbidden from calling validation_record — server enforces via requireRoles -->
Then tell the Human "Trust me bro, it works." `validation_record` is pr-reviewer-only; the server returns `forbidden` if bro attempts it.

## Step 5.5 — pr-reviewer push gate

After `bro_atomic_close` succeeds, BEFORE pushing the branch, spawn pr-reviewer to score the commit.

Spawn prompt MUST follow §C of `tmb_review`: pass only the bare anchors (task_id, commit_sha, branch_id, repo) plus a one-line context summary. <!-- enforced by: pr-reviewer-spawn-prompt-shape.sh PreToolUse hook (mech 3) -->

On PASS verdict (validation_attempts row written): `git push -u origin <branch>`.
On FAIL verdict: surface the failure, file the fix as a follow-up issue, do NOT push the failing commit.

**V3 — Any check fails**: call `bro_verification_fail_record(agent='bro', task_id=<N>, which_check='<V1|V2|V3>', details='<≤500 chars>')` — writes the audit + note in one transaction. Leave the task open. Retry via `task_retry_batch` (max 3 retries) or escalate. <!-- enforced by: bro_verification_fail_record composite (mech 2) -->

If `bro_atomic_close` returns `is_error: true`, halt and surface — see `tmb_recovery` §B.

## Step 6 — Architecture refresh (post-close)

<!-- enforced by: post-task-close-rescan.sh PostToolUse hook (mech 4) — fires automatically after bro_atomic_close -->
The rescan hook runs `scan_run(source='bro_auto_post_close')` automatically. There is no separate arch-refresh step bro fires.

## Headless fallback (interactive flow falls back here on AUQ error)

If an AUQ in Steps 0/2 errors mid-interactive-run OR `TMB_HEADLESS=1` flips on:

| AUQ | Default |
|---|---|
| Cold-start (Step 0) | Lazy fill |
| Base-branch (Step 2) | `${pr_target}` |
| Branch-id confirm (Step 2) | "Yes, proceed" |

Use `headless_intent_start` to record the fallback. Auto-picking "Suggest different branch_id" or any "halt + ask" choice headlessly is blocked — those require explicit Human intent.

For architectural changes in headless mode, still author the ADR with conservative assumptions. Waive the scope gate (Step 4 case 2).

## Search-first retrieval

When looking up past decisions, audit events, or file context, prefer `discussion_search` / `audit_search` / `file_registry_search` over the list/get tools — they return ranked snippets instead of full dumps. Use `mode='hybrid'` (the default) for combined keyword + semantic retrieval; `mode='keyword'` for exact-term queries where FTS5 precision matters; `mode='semantic'` when you know the concept but not the phrasing (e.g., "what did we decide about login flow?" returns results mentioning "authentication" and "JWT" even without those words in the query). Fallback to FTS5-only is automatic when the embedding model is unavailable; you'll see `warning: 'semantic_unavailable'` in the response.

## Learning (post-retry or escalation)

Capture the lesson once the retry is in flight:

1. **Is this new or known?** Check the patterns + criteria documented in `tmb_review` skill body.
2. **Where should the knowledge live?** Specific code pattern → `tmb_review` Living-patterns section. Design-time question or implementation rule → `tmb_review` Code-quality criteria, or a new lint hook in `scripts/hooks/`.
3. **Was the task underspecified?** If SWE had to guess, update the spec template above.

Skip one-off typos, tooling glitches, and bugs from stale task files.
