---
name: tmb_review
description: Review surface — pr-reviewer's qualitative phases at the push gate, bro's PR/MR comment triage flow, and bro's push-time orchestration. Loaded by pr-reviewer when scoring a task's commit, and by bro when the push hook blocks or the Human asks for review-before-push or PR comment monitoring. Self-contained — code-quality criteria + living patterns + AUQ shapes inline.
allowed-tools: Task, Bash, mcp__plugin_tmb_trajectory-server, AskUserQuestion
---

# Review

Three review-related judgments live here.

## A. PR-reviewer protocol (push gate, loaded by pr-reviewer)

Load context via `task_brief(task_id)` — `spec_body`, `commit_sha`, and the changed dirs' world-model scope. Apply phases in order; cite line numbers for every finding.

### Worktree discipline

The parent CC session's main checkout may be on ANY branch. Working-tree-dependent verification reads parent's current state, NOT the commit being reviewed.

For working-tree-dependent verification use `pr_review_worktree` with the workspace root — the directory holding `.claude/tmb/trajectory.db`; it creates the worktree, runs your command, and removes it atomically.

Sha-based git ops (`git show <sha>`, `git diff <sha>~1..<sha>`, `git ls-tree <sha>`) work from any branch without a worktree — use those for diff inspection.

### Phase 1 — Correctness reasoning

Trace concrete values through the new code:
- Happy path → expected output matches actual?
- Each failure mode named in the spec → has a code path?
- Boundary conditions (empty, null, max, duplicate, concurrent) → handled?

Show input → code path → expected → actual.

### Phase 2 — Design compliance

Sections are H2-anchored in `spec_body`:
- `## Files` — every named file/function changed; nothing surprising.
- `## Success Criteria` — each bullet visible in the diff.
- `## Description` error-handling items — each has a code path.
- `## Out of Scope` — nothing forbidden was done.

Gaps → Design-Compliance findings (severity is separate).

### Phase 3 — Pattern consistency

Naming, error-handling style, logging, test structure match the surrounding codebase? Deviations need explicit spec authorization; otherwise flag. Cross-check against the **Living patterns** below.

For context, pull the changed directory's world-model summary (`world_model_get(path='<changed-dir>')`) to see sibling patterns before judging.

### Phase 4 — Performance (only when the spec mentions it)

O(n²) where O(n) suffices? N+1 patterns? Hot-path allocations?
If `## Success Criteria` lists no performance bullet, skip.

### Phase 5 — Documentation

Public-API change reflected in user docs / type defs? Breaking change flagged in `CHANGELOG.md` if one exists? Examples still compile/run?

### Writing the validation_attempts row — YOU write it yourself

After producing a verdict, YOU (the pr-reviewer subagent) write the `validation_attempts` row directly, using the spawn prompt's `attempt_n`. Which path you take depends on your tool list. If `validation_record` is available, call it — the schema enforces the shape — and open your feedback with `'MCP available: yes'`. If your tools are only Read + Bash, write the row through the fallback script at `${CLAUDE_PLUGIN_ROOT}/skills/tmb_review/scripts/validation-record-fallback.sh` (`--help` shows the argument shape).

<!-- LOAD-BEARING-SAFETY: never delegate writing this row to bro. Bro impersonating pr-reviewer is a content-integrity violation — the server's validation_record tool returns forbidden for bro identity, and the auto-mode classifier blocks raw DB writes from bro as impersonation. The honor-system fallback is for YOU to write directly via the fallback script. -->

If you spot a recurring pattern at the push gate, append a bullet to **Living patterns** below using the format documented there.

## B. Spawning pr-reviewer (bro-side discipline)

The verdict row is always authored by pr-reviewer itself — via MCP when available, via the fallback script otherwise (§A). <!-- LOAD-BEARING-SAFETY: pr-reviewer must write validation_attempts directly; delegating to bro is impersonation and is blocked by the auto-mode classifier -->

**Clean spawn prompt example:**
```
task_id=42 commit_sha=abc123def branch_id=fix/foo repo=plugin attempt_n=<attempt #>

Push-gate review. Load the brief, verify each Success Criterion against the diff, and record your verdict — fail if any check fails.
```

No-MCP fallback (Bash-only spawn, no `mcp__...` tools in tool list): use the documented fallback script pattern — `bro-sqlite-readonly.sh` in `tmb_recovery` §C.2 for read-only DB access.

## C. Push-gate orchestration (bro, loaded reactively)

This loads when the push guard blocks unsigned commits, or when the Human asks to review before pushing.

### Reap commits → local feature branch

`reap_and_review_prep` fetches each unsigned task's detached HEAD into the main checkout and reports per task whether the reap landed.

### Spawn pr-reviewer per unsigned task (parallel)

Use `subagent_type='pr-reviewer'` (no-namespace form resolves project-local override). Tasks are independent; spawn in parallel where possible.

Read pr-reviewer's first response line:
- `MCP available: yes` — the reviewer wrote `validation_record` itself.
- `MCP available: no — honor-system fallback` — the reviewer wrote the row through the §A fallback script, which prepends the required feedback prefix itself.

### Outcomes

- All-pass → `git push origin <feature>`, then `gh pr create` / `glab mr create`, surface URL. After merge, run post-merge cleanup below.
- Any fail → surface verbatim. AUQ: `"PR-reviewer failed on N task(s). Spawn SWE to fix, or abort the push?"` options: `[Spawn SWE to fix | Abort push]`. Headless default: **Abort push**.

### Post-merge cleanup

`git switch <pr_target> && git pull --ff-only && git branch -d <feature>`. The cleanup-on-task-close hook removes the SWE worktree automatically on task close.

## D. PR/MR comment triage (bro, loaded by /monitor)

`pr_comments_get` does the deterministic fetch + since-marker bookkeeping. This section is the judgment around what's task-worthy.

### Resolve the PR

If the Human named a PR number, use it. Otherwise:
- GitHub: `gh pr view --json number`
- GitLab: `glab mr list --source-branch <branch> --json`

Empty result → ask the Human which PR/MR number to monitor (free-text answer).

### Fetch

Call `pr_comments_get` with the PR number.

Carrier: look up the issue via `tasks.branch_id` for the current branch. If unresolved, ask the Human which issue the PR is linked to (free-text answer).

### Triage (judgment)

Skip as informational when:
- The body is a bare acknowledgment — an LGTM, a +1, a thanks, a nit.
- The author is a bot (already classified by the MCP tool).
- The comment is already resolved.

Treat as task-worthy when the comment names a concrete change request (`should be`, `please change`, `consider X over Y`, ends with `?`), or contains a code suggestion fence.

Group task-worthy comments by file or shared concept; one task per group. Flag tasks that touch any seeded ADR directory (e.g. `docs/architecture/`), DB schema files (e.g. `*.sql`), agent/plugin config directories (e.g. `agents/`, `skills/`, plugin manifest files), or public API surfaces as `(arch-impact)`.

### Dispatch

Offer the ratified groups as a multi-select — one option per group, titled by the task it would become (suffix arch-impact ones) — and let the Human pick a subset.

For each ratified group: `task_create_batch(...)`, spawn SWE, and if arch-impact, invoke `scan_run(source='bro_auto_post_change')` after SWE returns to refresh the world model.

## Code-quality criteria (qualitative reference)

Mechanical patterns (bare except, f-string SQL, mutable default args, missing subprocess timeout, etc.) are caught mechanically. This section is the qualitative pass.

**Error handling**: each external dependency failure mode named in the spec? Partial failures recoverable or full rollback? Errors diagnosable from logs alone?

**Edge cases**: empty/null/boundary inputs handled? State-transition preconditions enforced? Bounded loops for user-controlled or network-derived collections? Concurrent-call safety?

**Database safety**: queries parameterized? Connections managed by `with` blocks? Upserts use `ON CONFLICT … DO UPDATE`? Test environment isolated from production?

**Security**: user input validated at entry point? <!-- LOAD-BEARING-SAFETY: secrets must stay out of code/logs/errors — literal secrets in source are a hard security violation --> Secrets from env var / secrets manager only? No `shell=True` with untrusted input? Bulk operations bounded?

## Living patterns (caught at the push gate)

Format: `- <Pattern name> / Symptom: ... / Root cause: ... / Rule: ... / Check: ...`

### Bro persona patterns

- **AskUserQuestion-default ignored**
  Symptom: Bro renders a 2–5 mutually-exclusive choice as markdown bullets and waits for prose, instead of calling AskUserQuestion.
  Root cause: Without an explicit doctrine entry, the LLM falls back to general-Claude prose-asking habits.
  Rule: See **Asking the Human** in `CLAUDE.md`.
  Check: Bro offering a numbered list of choices and waiting for "1" / "2" / etc. — flag as a regression.

### Prompt authoring

- **Negative directive in prompt**
  Trigger: a PR adds a negation-phrased rule to a prompt or skill body — the prompt-author lint flags the exact forms.
  Action: Propose the positive alternative inline ("Use X" instead of "Don't use Y"). Or recommend promotion to a deterministic layer (hook / `requireRoles`) for structural enforcement. If load-bearing safety: require `<!-- LOAD-BEARING-SAFETY: <reason> -->` justification.

(Add new findings here as they're caught.)
