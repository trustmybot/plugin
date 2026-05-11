---
name: tmb_planning
description: Bro's full code-touching flow — cold-start judgment, branch_id confirm, spec authoring (defaults table + ADR when architectural), decision audit, SWE spawn, V1/V2/V3 verification, atomic close, retry-on-fail. Loaded on the first code-touching ask of a session. Self-contained — everything bro needs is here.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, Task, mcp__plugin_tmb_trajectory-server
---

# Planning — bro's code-touching flow

The deterministic substrate (project inventory, registry warmth, regen
drift) lands as `additionalContext` from `session-start-prescan.sh` and
`session-start-regen-check.sh` before this skill loads. The mechanical
pre-checks (scope-ambiguity gate, branch-id-proposed audit,
greenfield architecture_regen, source-edit guard) are wire-enforced.
This skill is what bro decides.

## Headless fast path (TMB_HEADLESS=1)

**Skip every AUQ.** No Human means no answer; rendering an AUQ incurs
a deny-and-recover round trip per question. The 8-step recipe below is
fully self-contained.

1. `branch_id_propose(agent='bro', intent=<verbatim>, objective=<short>)` → take returned `branch_id`.
2. `issue_create(agent='bro', objective=<short>, description=<2-sentence summary>)`.
3. **One** combined headless-fallback record — both writes required:
   - `audit_log(agent='bro', issue_id=<I>, kind='event', event_type='headless_fallback', summary='tmb_planning headless: branch_id confirm → Yes, proceed; cold-start → lazy fill; defaults applied')`
   - `discussion_append(agent='bro', issue_id=<I>, author='bro', kind='note', body='Headless fallback: no Human in loop; defaults applied.')`
4. `discussion_append(issue_id=<I>, author='bro', kind='intent', body='Human intent verbatim: "<the request>"')`.
   Use `author='bro'`; `author='human'` is server-gated by the `verified_human=true` flag from the UserPromptSubmit hook.
5. `discussion_append(issue_id=<I>, author='bro', kind='decision', body='<chosen approach: what, why, trade-offs>')`. One short paragraph — the audit trail for "what did bro decide here." Required by the server-side decision gate on `task_create_batch`.
6. `git switch -c <branch_id>` (the WorktreeCreate hook routes to the right inner repo when in a workspace).
7. Author the spec body inline using the template in §"Spec body template". For architectural changes (touches `docs/trustmybot/architecture/`, schema, public API, or external side effects) also co-author an ADR at `docs/trustmybot/architecture/manual/decisions/N-*.md` and apply the blast-radius checklist (see §"Architectural changes" below).
8. `task_create_batch(agent='bro', issue_id=<I>, tasks=[{branch_id, description, success_criteria, spec_body}], emit_planning_complete=true, waive_scope_gate=true, waive_scope_gate_reason='headless mode: defaults applied; <one-line scope summary>')`.
9. Spawn SWE: `git worktree add .claude/worktrees/<slug> <branch_id>`, then `Task(subagent_type='swe', isolation='worktree', prompt='task_id=<N> worktree=.claude/worktrees/<slug>')`.

Interactive (Human-present) flow continues at Step 0.

## Step 0 — Cold-start codebase memory

Fires when `session-start-prescan.sh` reported `file_registry: cold` AND `N source > 0`.

**Tell the Human to run `/scan`.** The slash command is the deterministic path: bash + git + md5 populate `repos` + `file_registry` and emit a `deep_scan_completed` audit row, which clears the registry-cold gate on `task_create_batch`. Phase 2 of `/scan` dispatches background subagents to fill summaries in parallel — non-blocking.

If bro tries `task_create_batch` without `/scan` having ever run, the server returns `registry_cold_violation`. The error message names the fix (`/scan`); just relay it to the Human.

Drift (warm + dirty / branch behind / HEAD moved) is handled automatically by the post-task-close auto-rescan hook — md5-only invalidation preserves summaries on unchanged files; only changed files lose their summary so the next Read repopulates.

## Step 1 — Architectural-change check (judgment)

Most code-touching work is everyday: bro picks defaults, writes a one-paragraph `kind='decision'` body, and dispatches SWE. A small subset needs more rigor — those changes also require an ADR + the blast-radius checklist. See §"Architectural changes" below for the criteria + ceremony.

Either way bro writes **one** `kind='decision'` discussion summarizing the chosen approach. The server's **decision gate** on `task_create_batch` rejects when no `kind='decision'` row exists. For everyday work this is a sentence or two; for architectural changes it's the planned rationale that also lands in the ADR.

(Note: when the human wants alignment before bro commits to a plan, they enter Claude Code's native plan mode — bro doesn't drive a bespoke Q+A loop. The decision-audit row captures the outcome of that conversation.)

## Step 2 — Branch-id + Human confirm (interactive)

When a remote is configured, render:

```
AskUserQuestion: "Which branch should I create the new feature branch from?"
options: [pr_target (pull origin/<pr_target> first) | <current_branch> | 1-3 prominent local branches]
```

On `pr_target`: `git fetch origin ${pr_target} && git checkout ${pr_target} && git pull --ff-only`.
On non-pr_target: switch, do not auto-pull.
Any git error: halt and surface.

Then derive + propose:

```
{ branch_id, confidence } = branch_id_propose(agent='bro', intent=<verbatim>, objective=<short>)
```

Render branch-id confirm AUQ:

```
AskUserQuestion: "Proceed with branch_id <X>?"
options: [Yes, proceed | Suggest different branch_id]
```

On Yes:

```
issue_create(agent='bro', objective=<short>)             # if no open issue
discussion_append(issue_id, author='human', kind='intent', body=<verbatim>)
discussion_append(issue_id, author='bro',   kind='note',   body='Beginning planning on ${branch_id}.')
git switch -c "${branch_id}"
audit_log(agent='bro', issue_id=<I>, branch_id=<branch_id>, kind='event', event_type='branch_id_proposed', summary='Branch <branch_id> created from origin/<base>.')
```

Conventional-format regex + the `branch_id_proposed` audit gate are both server-enforced.

## Step 3 — Spec authoring

Pick conservative defaults, name them in `## Description` "Assumptions:" bullets. If the project already uses a different tool, **match the existing pattern** — convention wins over default.

| Dimension | Default |
|---|---|
| Python CLI framework | `argparse` (stdlib) |
| Python test runner | `unittest` (stdlib), unless project already uses `pytest` |
| Node test runner | `node:test` (stdlib), unless project uses `vitest` / `jest` |
| Storage (personal tools) | `~/.<app>/<file>.json`, atomic write via tmpfile + rename |
| Storage (project tools) | match existing project convention |
| File layout | single file until ~200 LOC |
| Python version | `python3` (system) |
| Concurrency model | single-user, single-process |

Before `task_create_batch` write the decision audit:

```
discussion_append(kind='decision', body='<chosen approach: what, why, trade-offs>')
```

Server-enforced via the **decision gate** on `task_create_batch`: at least one `kind='decision'` row must exist or the call is rejected. Body is short for everyday work; longer + sibling ADR for architectural changes (next section).

The **scope-ambiguity gate** also stays: `task_create_batch` returns `forbidden` if the issue has zero `kind='question'` rows. Waivable for truly trivial changes.

### Architectural changes — ADR + blast-radius check

When the change does any of the following, also co-author an ADR + apply the blast-radius check:

- Touches `docs/trustmybot/architecture/` directly
- Introduces a new service boundary or top-level module
- Modifies a public API surface
- Commits to a strategic stack choice (auth provider, production DB, retention policy)
- Names multiple unrelated surfaces in one task
- Has external side effects (network, real API mutations, billing, message-sending, writes outside the worktree)

ADR location: `docs/trustmybot/architecture/manual/decisions/N-*.md` (see `templates/docs-trustmybot/architecture/manual/decisions/0001-example.md`).

Blast-radius checklist (external side effects only): default config MUST be the safe state (opt-in); tests MUST NOT hit live services on the default `:memory:` DB; spec MUST require a pre-merge `bash tests/run-all.sh` yielding zero external mutations. Any miss → spec back for revision.

If the human wants to deliberate on the architectural direction before bro commits, they enter **Claude Code's native plan mode** (Shift+Tab); bro doesn't run a bespoke Q+A loop. The decision-audit row captures the outcome of that deliberation either way.

## Spec body template (max 8000 chars)

Self-contained — never reference another spec for content. Split into multiple tasks linked by `parent_branch_id` if it exceeds 200 lines.

```markdown
## Description
<≤3 sentences. Cite file paths with line refs. Quote actual code that pins behaviour. Include explicit Assumptions bullets for picked defaults.>

## Files
- path/to/file — action: brief note

## Success Criteria
- 2–5 testable assertions.

## Verification
```bash
# Exact commands SWE runs to confirm Success Criteria.
```

## Out of Scope
- Nearby work this task explicitly does NOT do.

## Commit
```
<emoji> <type>(<scope>): <one-line message>
```
```

## Step 4 — Spawn SWE

```
task_create_batch(
  agent='bro', issue_id=<I>,
  spec_body=<≤8000 chars>,
  emit_planning_complete=true,
  planning_complete_summary='<one-line>',
  waive_scope_gate=<true | false>,
  waive_scope_gate_reason='<≥10 chars>',
)
```

`emit_planning_complete=true` emits the closing audit row in the same DB transaction.

**`waive_scope_gate` use cases** — two valid:

1. **Truly trivial work** (typo fix, one-line doc, mechanical rename per the user's exact request). Reason: `'trivial: <what>'`.
2. **Headless mode (TMB_HEADLESS=1).** No Human in the loop means no chance to ask a clarifying question; the gate would block forever. Reason: `'headless mode, defaults applied; <one-line scope summary>'`.

For interactive runs (Human present) on substantive changes, **do not** waive — let the scope-ambiguity gate enforce at least one clarifying question.

Spawn commands:

```bash
git fetch origin <pr_target>
git switch -c <branch_id> origin/<pr_target>     # already done in Step 2 if there
git worktree add .claude/worktrees/<slug> <branch_id>
```

```
Task(subagent_type='swe', isolation='worktree', prompt='task_id=<N> worktree=.claude/worktrees/<slug>')
```

`<slug>` = everything after the `<type>/` prefix. Parallel spawns when tasks have no overlapping `## Files`; sequential when they share files.

## Step 5 — Verify + atomic close

After SWE returns `completed`:

**V1 — Pull**
```
task_get(task_id=<N>)                            # spec_body, commit_sha
git diff <commit_sha>~1..<commit_sha>            # actual changes
```

**V2 — Three checks (all required)**
1. Files match `## Files` — every changed file listed; no surprise files outside scope.
2. `## Verification` commands pass — re-run verbatim inside the SWE worktree. Run V2 BEFORE V3 — the `cleanup-worktree-on-task-close.sh` hook removes the worktree on close.
3. Each `## Success Criteria` bullet visibly met by the diff.

**V3 — All three pass → one atomic call**

```
bro_atomic_close(
  agent='bro', task_id=<N>, commit_sha=<sha>,
  file_summaries=[<{path, summary}> per touched path],
  verification_summary='V1 files match. V2 verification commands all passed. V3 success criteria visibly met.',
  close_issue_if_last_task=true,
)
```

Then tell the Human "Trust me bro, it works." Bro never calls `validation_record` — server returns `forbidden`.

**V3 — Any check fails**

```
audit_log(agent='bro', from_node='bro', kind='event', event_type='bro_verification_fail', summary='<which check> — <details>')
discussion_append(kind='note', body='Verification fail: <which check> — <details>')
```

Don't close. Either retry SWE via `task_retry_batch` (max 3 retries per task) or escalate.

```
task_retry_batch(
  agent='bro', failed_task_id=<N>,
  new_branch_id='<type>/<slug>-v2',
  corrected_spec_body=<≤8000 chars>,
  retry_rationale='<≤200 chars: root cause → corrected approach>',
  description=<...>, success_criteria=<...>,
)
```

If `bro_atomic_close` returns `is_error: true`, halt and surface — see `tmb_recovery` §B.

## Step 6 — Architecture refresh (architectural changes only, post-close)

When an architectural task (per §"Architectural changes" — new module boundary, schema change, public API change, new dependency) closes:

```
architecture_regen(agent='bro', scope='full')
```

Surface one line if `changed > 0`.

## Headless fallback (interactive flow falls back here on AUQ error)

If an AUQ in Steps 0/2 errors mid-interactive-run OR `TMB_HEADLESS=1` flips on:

| AUQ | Default |
|---|---|
| Cold-start (Step 0) | Lazy fill |
| Base-branch (Step 2) | `${pr_target}` |
| Branch-id confirm (Step 2) | "Yes, proceed" |

Record both audit + discussion writes for each fallback (`event_type='headless_fallback'`). Do not auto-pick "Suggest different branch_id" or any "halt + ask" choice headlessly — those need explicit Human intent.

For architectural changes in headless mode, still author the ADR with conservative assumptions. Waive the scope gate (Step 4 case 2).

## Learning (post-retry or escalation)

Capture the lesson once the retry is in flight:

1. **Is this new or known?** Check the patterns + criteria documented in `tmb_review` skill body.
2. **Where should the knowledge live?** Specific code pattern → `tmb_review` Living-patterns section. Design-time question or implementation rule → `tmb_review` Code-quality criteria, or a new lint hook in `scripts/hooks/`.
3. **Was the task underspecified?** If SWE had to guess, update the spec template above.

Skip one-off typos, tooling glitches, and bugs from stale task files.
