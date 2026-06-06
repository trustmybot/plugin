---
name: tmb_review
description: Review surface — pr-reviewer's qualitative phases at the push gate, bro's PR/MR comment triage flow, and bro's push-time orchestration. Loaded by pr-reviewer when scoring a task's commit, and by bro when the push hook blocks or the Human asks for review-before-push or PR comment monitoring. Self-contained — code-quality criteria + living patterns + AUQ shapes inline.
allowed-tools: Task, Bash, mcp__plugin_tmb_trajectory-server, AskUserQuestion
---

# Review

Three review-related judgments live here. Mechanical pre-checks (lint
pass, test pass, secrets regex, hardcoded-cred scan, file-count, push
gate's signed-off check) run by hooks + CI before this skill loads.

## A. PR-reviewer protocol (push gate, loaded by pr-reviewer)

Spec lives in `tasks.spec_body`; fetch via `task_get(task_id)`. Apply phases in order; cite line numbers for every finding.

### Worktree discipline

The parent CC session's main checkout may be on ANY branch. Working-tree-dependent verification reads parent's current state, NOT the commit being reviewed.

For working-tree-dependent verification use `pr_review_worktree(agent='pr-reviewer', commit_sha=<sha>, repo_path=<CLAUDE_PLUGIN_ROOT>, command='<verification command>')` — creates the worktree, runs the command, removes it atomically. <!-- enforced by: pr_review_worktree composite (mech 2) -->

Sha-based git ops (`git show <sha>`, `git diff <sha>~1..<sha>`, `git ls-tree <sha>`) work from any branch and don't need a worktree — use those for diff inspection.

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

### Phase 4 — Performance (only when the spec mentions it)

O(n²) where O(n) suffices? N+1 patterns? Hot-path allocations?
If `## Success Criteria` lists no performance bullet, skip.

### Phase 5 — Documentation

Public-API change reflected in user docs / type defs? Breaking change flagged in `CHANGELOG.md` if one exists? Examples still compile/run?

### Writing the validation_attempts row — YOU write it, never delegate

After producing a verdict, YOU (the pr-reviewer subagent) write the `validation_attempts` row directly. Two paths depending on your tool list:

**Path 1 — MCP available** (your tool list includes `mcp__plugin_tmb_trajectory-server__validation_record`):
```
validation_record(agent='pr-reviewer', task_id=N, attempt_n=1, verdict='pass'|'fail', feedback='MCP available: yes\n<your verdict text>', subagent_session_id='<your-session-id>')
```

**Path 2 — MCP unavailable** (only Read + Bash in your tool list): `sqlite3 "${TRAJECTORY_DB_PATH}" "INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, subagent_session_id, created_at) VALUES (<N>, 1, 'pr-reviewer', '<pass|fail>', 'MCP available: no — honor-system fallback\n<verdict text>', '<session-id>', '$(date -u +%Y-%m-%dT%H:%M:%SZ)')"`

The `feedback` column CHECK constraint: must start with `'MCP available: yes'` OR `'MCP available: no — honor-system fallback'`. <!-- enforced by: requireRoles (mech 6) — server rejects bro identity; schema CHECK rejects wrong prefix -->

<!-- LOAD-BEARING-SAFETY: never delegate writing this row to bro. Bro impersonating pr-reviewer is a content-integrity violation — server's validation_record MCP tool returns forbidden for bro identity, AND the auto-mode classifier blocks raw sqlite3 INSERT from bro as impersonation. The honor-system fallback is for YOU to write directly via Bash sqlite3. -->

`scripts/hooks/git-push-guard.sh` only lets pushes through when this row exists. <!-- enforced by: git-push-guard.sh PreToolUse hook (mech 3) -->

If you spot a recurring pattern at the push gate, append a bullet to **Living patterns** below using the format documented there.

## B. Spawning pr-reviewer (bro-side discipline)

When bro spawns pr-reviewer, the prompt MUST contain task_id, commit_sha, branch_id, repo, and a one-line context summary. The prompt MUST NOT contain prior verdict text or rubber-stamp shortcuts. <!-- enforced by: pr-reviewer-spawn-prompt-shape.sh PreToolUse hook (mech 3) -->

**Clean spawn prompt example:**
```
task_id=42 commit_sha=abc123def branch_id=fix/foo repo=plugin

Push-gate review. Per §A worktree discipline if running linters/build/tests against the working tree. Load spec via sqlite3 from tasks.spec_body; load diff via sha-based git ops. Verify each Success Criterion. Write validation_attempts row per §A (path 1 if you have MCP, path 2 if you have only Bash). Verdict='fail' if any check fails — do not fabricate.
```

## C. Push-gate orchestration (bro, loaded reactively)

Triggers:
1. `git push` blocked by `git-push-guard.sh` ("BLOCKED: pushing N unsigned commits.")
2. Human says "review before push" / "@bro review before push".

### Reap commits → local feature branch

`reap_and_review_prep(agent='bro', task_ids=[<N>, ...], repo_path=<CLAUDE_PLUGIN_ROOT>)` — fetches each unsigned task's detached HEAD from its worktree into the main checkout, returns `{ reaped: [{task_id, branch_id, commit_sha, reaped, error?}] }`. <!-- enforced by: reap_and_review_prep composite (mech 2) -->

### Spawn pr-reviewer per unsigned task (parallel)

Use `subagent_type='pr-reviewer'` (no-namespace form resolves project-local override). Tasks are independent; spawn in parallel where possible.

Read pr-reviewer's first response line:
- `MCP available: yes` → reviewer wrote `validation_record` itself.
<!-- LOAD-BEARING-SAFETY: feedback must start with the exact literal string — schema CHECK rejects paraphrases like "MCP unavailable" or "[honor-system fallback]" -->
- `MCP available: no — honor-system fallback` → record on its behalf via sqlite3 (insert into `validation_attempts` with `agent='pr-reviewer'`, `subagent_session_id` from its response, and `feedback` starting with the LITERAL string `MCP available: no — honor-system fallback\n` — paste verbatim).

### Outcomes

- All-pass → `git push origin <feature>`, then `gh pr create` / `glab mr create`, surface URL. After merge, run post-merge cleanup below.
- Any fail → surface verbatim. AUQ: `"PR-reviewer failed on N task(s). Spawn SWE to fix, or abort the push?"` options: `[Spawn SWE to fix | Abort push]`. Headless default: **Abort push**.

### Post-merge cleanup

`git switch <pr_target> && git pull --ff-only && git branch -d <feature>`. The cleanup-on-task-close hook removes the SWE worktree automatically on task close.

## D. PR/MR comment triage (bro, loaded by /monitor)

`pr_comments_get` does the deterministic fetch + since-marker bookkeeping; comment rows are auto-persisted as discussion notes by `post-pr-comments-persist.sh` PostToolUse hook. This section is the judgment around what's task-worthy. <!-- enforced by: post-pr-comments-persist.sh PostToolUse hook (mech 4) -->

### Resolve the PR

If `$ARGUMENTS` has a PR number, use it. Otherwise:
- GitHub: `gh pr view --json number`
- GitLab: `glab mr list --source-branch <branch> --json`

Empty result → render AUQ:
```
AskUserQuestion: "Which PR/MR number to monitor?"
options: []  # Other free-text only
```

### Fetch

```
pr_comments_get(agent='bro', pr_number=N)
```

Carrier: look up the issue via `tasks.branch_id` for the current branch. If unresolved, render AUQ:
```
AskUserQuestion: "Which issue is this PR linked to?"
options: []  # free-text issue ID
```

### Triage (judgment)

Skip as informational when:
- Body matches `^(LGTM|👍|\+1|thanks|nice work|nit:)`.
- Author is a bot (already classified by the MCP tool).
- Comment is `is_resolved: true`.

Treat as task-worthy when the comment names a concrete change request (`should be`, `please change`, `consider X over Y`, ends with `?`), or contains a code suggestion fence.

Group task-worthy comments by file or shared concept; one task per group. Flag tasks that touch `docs/trustmybot/architecture/`, `mcp/.../schema.sql`, `.claude-plugin/plugin.json`, or `agents/` as `(arch-impact)`.

### Dispatch

Render AUQ:
```
AskUserQuestion: "Which review comments to address now? (subset OK)"
multiSelect: true
options: [<task title (with optional (arch-impact) suffix)> per ratified group]
```

For each ratified group: `task_create_batch(...)`, spawn SWE, and if arch-impact, invoke `scan_run(source='bro_auto_post_change')` after SWE returns to refresh the world model.

## Search-first retrieval

When looking up past decisions or project structure, prefer the search tools over list/get — they return ranked snippets, not full dumps. `world_model_get` / `world_model_search` for project navigation; `discussion_search` / `audit_search` for prior decisions and history. `mode='hybrid'` is the default; falls back to keyword if embeddings are unavailable (`warning: 'semantic_unavailable'`).

## Code-quality criteria (qualitative reference)

Mechanical patterns (bare except, f-string SQL, mutable default args, missing subprocess timeout, etc.) are flagged automatically by `scripts/hooks/code-quality-lint.sh`. This section is the qualitative pass.

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
  Rule: For any 2–5 mutually-exclusive choice, use AskUserQuestion. Constraints + skip-cases live inline at `CLAUDE.md ## Asking the Human`.
  Check: Bro offering a numbered list of choices and waiting for "1" / "2" / etc. — flag as a regression.

### Prompt authoring

- **Negative directive in prompt**
  Trigger: PR introduces a negation clause (start-of-line `Don't` / `Never` / `Do not`, or mid-sentence `MUST NOT` / `do not`) to a prompt or skill body. <!-- LOAD-BEARING-SAFETY: pattern description must name the negation forms for the lint check to be enforceable -->
  Action: Propose the positive alternative inline ("Use X" instead of "Don't use Y"). Or recommend promotion to a deterministic layer (hook / `requireRoles`) for structural enforcement. If load-bearing safety: require `<!-- LOAD-BEARING-SAFETY: <reason> -->` justification.

(Add new findings here as they're caught.)
