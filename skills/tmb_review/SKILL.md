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

### Sign-off

```
validation_record(agent='pr-reviewer', task_id=N, attempt_n=<N>,
                  verdict='pass'|'fail', subagent_session_id=<your-id>,
                  feedback=<rationale>)
```

`scripts/hooks/git-push-guard.sh` only lets pushes through when this row exists. The MCP server enforces `agent='pr-reviewer'` via `requireRoles`. Output format lives in `agents/pr-reviewer.md`.

If you spot a recurring pattern at the push gate, append a bullet to **Living patterns** below using the format documented there.

## B. Push-gate orchestration (bro, loaded reactively)

Triggers:
1. `git push` blocked by `git-push-guard.sh` ("BLOCKED: pushing N unsigned commits.")
2. Human says "review before push" / "@bro review before push".

### Reap commits → local feature branch

For each unsigned task, look up `tasks.branch_id` and slug. From the main checkout:
```bash
git fetch ./.claude/worktrees/<slug> HEAD:<branch_id>
```

### Spawn pr-reviewer per unsigned task (parallel)

Use `subagent_type='pr-reviewer'` (no `tmb:` prefix — the no-namespace form resolves the project-local override at `.claude/agents/pr-reviewer.md`). Pass `task_id=N`. Tasks are independent; spawn in parallel where possible.

Read pr-reviewer's first response line:
- `MCP available: yes` → reviewer wrote `validation_record` itself.
<!-- LOAD-BEARING-SAFETY: feedback must start with the exact literal string — schema CHECK rejects paraphrases like "MCP unavailable" or "[honor-system fallback]" -->
- `MCP available: no — honor-system fallback` → record on its behalf via sqlite3 (insert into `validation_attempts` with `agent='pr-reviewer'`, `subagent_session_id` from its response, and `feedback` starting with the LITERAL string `MCP available: no — honor-system fallback\n` — paste verbatim ("MCP unavailable", "[honor-system fallback]" etc. all violate the schema CHECK and the row will be rejected). After the prefix line, paste the reviewer's verdict text verbatim.

### Outcomes

- All-pass → `git push origin <feature>`, then `gh pr create` / `glab mr create`, surface URL. After merge, run post-merge cleanup below.
- Any fail → surface the failure verbatim. Render AUQ:
  ```
  AskUserQuestion: "PR-reviewer failed on N task(s). Spawn SWE to fix, or abort the push?"
  options: [Spawn SWE to fix | Abort push]
  ```
  Headless default: **Abort push** (half-fixed work shouldn't ship without Human review).

### Post-merge cleanup

```bash
git switch <pr_target>
git pull --ff-only
git branch -d <feature>
```
The cleanup-on-task-close hook removes the SWE worktree automatically when bro flips the task to `closed`.

### Why pr-reviewer is the push gate (not per-task)

Per-task review multiplies the heavy review cost by task count. The push moment is the natural batch boundary — the Human is already pausing to ship. Bro's `bro_verification_pass` (per-task gate, written by `bro_atomic_close`) is the lighter always-on check; pr-reviewer's `validation_record` is the deeper occasional check.

## C. PR/MR comment triage (bro, loaded by /monitor)

`pr_comments_get` does the deterministic fetch + since-marker bookkeeping; this section is the judgment around what's task-worthy and which to dispatch.

### Resolve the PR

If `$ARGUMENTS` has a PR number, use it. Otherwise:
- GitHub: `gh pr view --json number`
- GitLab: `glab mr list --source-branch <branch> --json`

Empty result → render AUQ:
```
AskUserQuestion: "Which PR/MR number to monitor?"
options: []  # Other free-text only
```

### Fetch + persist

```
pr_comments_get(agent='bro', pr_number=N)
```

For each returned comment:
```
discussion_append(agent='bro', issue_id=<carrier>, author=<commenter>,
  kind='note', body='[PR #N comment by <author>] <body>')
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

For each ratified group: `task_create_batch(...)`, spawn SWE, and if arch-impact, invoke `scan_run(source='bro_auto_post_change')` after SWE returns to refresh the file_registry.

## Code-quality criteria (qualitative reference)

Mechanical patterns (bare except, f-string SQL, mutable default args, missing subprocess timeout, etc.) are flagged automatically by `scripts/hooks/code-quality-lint.sh`. This section is the qualitative pass.

### Error handling — design questions

- What happens when each external dependency fails (DB, HTTP, subprocess, file IO)? Each failure mode named in the spec with expected behaviour?
- Are partial failures recoverable, or does the whole operation roll back?
- Is the caller expected to handle the error, or does the function eat it and return a sentinel?
- Will errors be diagnosable from the logs alone?

### Edge cases

- Empty / null / single-element / boundary inputs: which are valid and which are errors?
- State-transition preconditions: which state must hold before this function runs?
- Bounded vs. unbounded loops: any iteration over a user-controlled or network-derived collection needs an explicit cap.
- Concurrent calls: safe under concurrent invocation, or requires external serialization?

### Database safety

- All queries parameterized?
- Connection / cursor lifecycles managed by `with` blocks?
- Upserts use `ON CONFLICT … DO UPDATE` rather than check-then-insert?
- Test environment isolated from production data?

### Security

- Where does user input enter the system, where is it validated?
<!-- LOAD-BEARING-SAFETY: secrets must stay out of code/logs/errors — literal secrets in source are a hard security violation -->
- Are secrets retrievable only through the configured backend (env var, secrets manager) — kept out of code, logs, and error responses?
- Subprocess calls structured to avoid shell injection (no `shell=True` with untrusted input)?
- Bulk operations bounded against denial-of-service?

## Living patterns (caught at the push gate)

Format for each finding:

```
- <Pattern name>
  Symptom: <what went wrong>
  Root cause: <why>
  Rule: <generalized guidance>
  Check: <how to detect in future reviews>
```

### Bro persona patterns

- **AskUserQuestion-default ignored**
  Symptom: Bro renders a 2–5 mutually-exclusive choice as markdown bullets and waits for prose, instead of calling AskUserQuestion.
  Root cause: Without an explicit doctrine entry, the LLM falls back to general-Claude prose-asking habits.
  Rule: For any 2–5 mutually-exclusive choice, use AskUserQuestion. Constraints + skip-cases live inline at `CLAUDE.md ## Asking the Human`.
  Check: Bro turns offering a numbered list of choices and waiting for "1" / "2" / etc. should be flagged as a regression.

### Prompt authoring

- **Negative directive in prompt**
  Trigger: PR introduces a negation clause (start-of-line `Don't` / `Never` / `Do not`, or mid-sentence `MUST NOT` / `do not`) to a prompt or skill body. <!-- LOAD-BEARING-SAFETY: pattern description must name the negation forms for the lint check to be enforceable -->
  Action: Propose the positive alternative inline ("Use X" instead of "Don't use Y"). Or recommend promotion to a deterministic layer (hook / `requireRoles`) for structural enforcement. If load-bearing safety: require `<!-- LOAD-BEARING-SAFETY: <reason> -->` justification.

(Add new findings here as they're caught.)
