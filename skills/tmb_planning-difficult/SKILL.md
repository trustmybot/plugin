---
name: tmb_planning-difficult
description: Bro's planning protocol when triage = difficult (architecture-touching, cross-cutting, or strategic). Full env probe + Q+A discussion + ADR + standard-template spec, plus the same bro verification step the simple path uses. Loaded only when triage warrants it.
agent: bro
allowed-tools: Read, Glob, Grep, Bash, Task, AskUserQuestion, mcp__plugin_tmb_trajectory-server
---

# Planning — Difficult Triage

Triage `difficult` = the change touches `docs/trustmybot/architecture/`, introduces a new service boundary, modifies a public API, or commits to a strategic technology choice. The protocol is the full alignment loop — you cannot just pick defaults like the simple path.

## Spec brevity (HARD CAP at 8000 chars)

`task_create_batch` rejects `spec_body` >8000 chars. Cite, don't restate. If the difficult-path spec is bigger than 8k, it should split into multiple tasks linked by `parent_branch_id`.

## Workflow

### Step 0 — Triage confirmation

You arrived here because bro's triage said `difficult`. Confirm with the heuristic before proceeding:

> **Does this request require updates to `docs/trustmybot/architecture/`?**
> If yes → difficult is correct. If no → downgrade to simple and load `tmb_planning-simple` instead.

Record the confirmation:

```
discussion_append(kind='note', body='Triage: difficult (confirmed)')
```

### Step 1 — Environment probe (ONE batched response)

Detect what the Human actually has locally before offering options. Use Bash, read-only. Pick the probes relevant to the stack the ask implies. **Run them as one batched response per the parallel-batching rule in CLAUDE.md** — gate fragile commands with `|| true` or skip them based on prior probe results.

```bash
# Language versions
python3 --version 2>&1 || echo "no python"
node --version 2>&1 || echo "no node"
go version 2>&1 || echo "no go"
rustc --version 2>&1 || echo "no rust"

# Python env/package managers
command -v uv && uv --version
command -v poetry && poetry --version
command -v pip && pip --version

# Python project files
ls pyproject.toml requirements.txt setup.py Pipfile 2>/dev/null

# Node ecosystem
command -v bun && bun --version
command -v pnpm && pnpm --version
command -v npm && npm --version
ls package.json bun.lock pnpm-lock.yaml package-lock.json 2>/dev/null

# Linters / formatters / test runners
command -v ruff && ruff --version
command -v black && black --version
command -v pytest && pytest --version
command -v vitest && vitest --version

# Git state
git remote -v 2>/dev/null | head -2
```

**Persist the probe findings** as a `kind='note'` discussion row so future sessions can replay the environment context:

```
discussion_append(kind='note', body='Env probe: uv 0.5.11, Python 3.12.3, no existing pyproject.toml, git remote set.')
```

### Step 2 — Build grounded options + ask

Use the probe findings to build options that actually work on this machine. Never offer an unexecutable option ("uv" when uv isn't installed). Never list a tool as `(Recommended)` unless detected AND fits the task.

```
| If probe shows | Question | Options |
|---|---|---|
| `uv` installed + `python3` ≥ 3.11 | "Package manager?" | `uv (detected, v0.5.x) (Recommended)`, `pip + venv`, `poetry` |
| No package manager installed | "Install one?" | `Install uv (curl ...)`, `Use pip + venv`, `I'll handle it` |
| `pyproject.toml` exists | "Use existing pyproject.toml?" | `Yes (keep layout)`, `New project alongside`, `Scrap and restart` |
```

Bro is main Claude — `AskUserQuestion` is available; use the radio UI for clean Q+A.

Each round:

```
AskUserQuestion({ questions: [...] })   # human picks
discussion_append(kind='question', body=<question + options verbatim>)
discussion_append(kind='answer', author='human', body=<reply verbatim>)
```

Loop until aligned. Max 3-4 questions per round to avoid form fatigue.

### Step 3 — Scope-ambiguity gate (HARD RULE, MCP-enforced)

**`task_create_batch` refuses to run if the issue has zero `kind='question'` rows in discussions.** This is an MCP-level check — auto-mode cannot bypass it.

The waiver has two legitimate uses:

1. **Simple fast-lane** (in `tmb_planning-simple`, not here).
2. **Truly trivial difficult-path changes** that escalated to difficult only because they touch `docs/trustmybot/architecture/` (e.g. updating an ADR after a real-but-already-discussed code change). Reason: `"trivial difficult-path: only updates ADR-N for already-decided change"`.

**Auto-mode does NOT waive this gate on the difficult path.** If your response body would include phrases like "auto-mode defaults" or "defaulting to X since you didn't specify" — STOP. Ask the Human.

**Ambiguous choices that ALWAYS need a question + answer pair before a `kind='decision'` row:**

- Storage backend (JSON vs SQLite vs external DB)
- Library choice (argparse vs click vs typer; pytest vs unittest)
- Command surface / CLI verbs
- Feature scope ("auth this iteration or not?")
- Persistence location
- Runtime target (Python 3.10 vs 3.12, Node 18 vs 22)
- File layout (single file vs package vs module)

**Self-review before `task_create_batch`:**

```
Healthy:                              Violation (RED FLAG):
  intent → note(triage) →               intent → note(triage) →
  note(env probe) →                     note(env probe) →
  question(framework?) →                decision(plan, "auto-mode defaults")
  answer →                                       ^^^^^^^^^^^^^^^^^^
  question(storage?) →                  → revert, ask the missing question
  answer →
  decision(plan)
```

If `discussion_list` shows a `kind='decision'` row with no preceding `kind='question'` — you skipped the gate. Revert by NOT creating tasks, asking the missing question, persisting Q+A, then re-decide.

### Step 4 — Capture the architectural decision

```
discussion_append(kind='decision', body=<architectural plan: what changes, why, trade-offs, risks>)
```

Co-author an ADR at `docs/trustmybot/architecture/manual/decisions/N-*.md` when the change is significant enough to warrant durable documentation.

### Blast-radius review (for features with external side effects)

When the spec introduces a feature that performs external side effects — network calls, real API mutations, billing operations, file writes outside the worktree, message-sending — bro MUST verify the following BEFORE creating the SWE task:

1. **Default value**: is the default config value the **safe** state? Side-effecting features must default to OFF; users opt in explicitly.
2. **Test invocation surface**: trace whether ANY test (L2/L3/L4) can hit the live external service. In particular, fresh `:memory:` test DBs inherit the default. If the default would cause tests to make real external calls, the spec is unsafe — flip the default OR add a kill-switch.
3. **Pre-merge verification**: spec must require a pre-merge verification step that confirms `bash tests/run-all.sh` produces zero external mutations. SWE explicitly checks pre/post external state. If delta > 0, ship is blocked.

If any of these three checks fail, send the spec back for revision before SWE dispatches.

### Step 5 — Author the spec body (standard template)

Standard difficult-path template. ≤8000 chars. Cite existing code; don't restate.

```markdown
## Description
<Full context, motivation, constraints. Tie back to the kind='decision' row + ADR.>

## Files
- path/to/file — action: per-file description of what changes

## Success Criteria
- Detailed, covering every error state, edge case, validation requirement.
- Include validation matrix where applicable.

## Verification
```bash
# Comprehensive commands covering happy path AND failure modes.
```

## Out of Scope
- Explicit list of nearby work this task does NOT do.

## Commit
```
<emoji> <type>(<scope>): <one-line message>
```
```

### Step 6 — Batched handoff (single response)

Same hard rule as the simple path: emit `task_create_batch` + `Task(swe)` + `ledger_log(planning_complete)` as multiple tool_use blocks in ONE response. CC runs them concurrently. Splitting these across messages costs ~30s of round-trip latency.

If multiple tasks were planned, fan out the SWE spawns in parallel where they have no `parent_branch_id` dependency.

### Step 7 — Bro verification protocol — never skip this

Same as the simple path: bro must verify SWE actually delivered what the spec required before flipping to closed.

#### V1 — Pull spec + diff
```
task_get(agent='bro', task_id=<N>)
git diff <commit_sha>~1..<commit_sha>
```

#### V2 — Three checks (all required)
1. **Files match `## Files`** — every changed file listed in spec; no surprise files outside scope.
2. **`## Verification` commands pass** — re-run verbatim from the spec inside the SWE worktree. **Run V2 BEFORE the V3 close batch** — the cleanup hook removes the worktree on `task_update_status(closed)`.
3. **Success criteria visibly met** — for each bullet in `## Success Criteria`, scan diff for the corresponding code/test.

#### V3 — Decide
- All three pass → batch FOUR calls in the same response:
  1. `ledger_log(agent='bro', issue_id=<I>, branch_id=<B>, from_node='bro', event_type='bro_verification_pass', summary='V1 files match. V2 verification commands passed. V3 success criteria met. Closing.')`
  2. **`file_registry_update_summaries(agent='bro', updates=[<one entry per touched path: {path, summary: '<your fresh 1-3 sentence summary based on the diff you just verified>'}], advance_verified_sha=<sha>)`** — you have full task context (issue + spec + diff just reviewed); SWE doesn't. Server enforces this is bro-only. A PreToolUse hook gates the next call: `task_update_status(closed)` will be DENIED if file_registry doesn't have fresh summaries for the touched paths.
  3. `task_update_status(agent='bro', task_id=<N>, status='closed', commit_sha=<sha>)`
  4. `issue_close(agent='bro', issue_id=<I>)` IF all tasks on the issue are closed

  **Do NOT call `validation_record`** — pr-reviewer-only; server returns `forbidden` for bro callers. Bro writes `bro_verification_pass` to the ledger; pr-reviewer writes `validation_record` later at the push gate, over the batch.
- Any check fails → batch `ledger_log(event_type='bro_verification_fail')` + `discussion_append(kind='note', body='Verification fail: ...')`. Do NOT close. Re-spawn SWE with feedback (max 3 retries) or escalate.

#### Halt-on-MCP-error
If any close-related MCP call returns `is_error: true`, STOP. Do not emit a success message. Surface the exact error to the Human — usually means the call signature is wrong.

### Step 8 — Loop

If more tasks remain in the planned batch, return to Step 6 (handoff). After all tasks closed, optionally generate `issue_snapshot_md` for human review and close the issue.

## What this is NOT

- This is **not** pr-reviewer's job — pr-reviewer is the push gate (deeper style/security checks at `git push` time).
- This is **not** a re-review of the spec body. The spec was authored at planning time; you're verifying SWE matched it.

## When to downgrade back to simple

If the difficult triage was wrong (e.g. the ask doesn't actually touch architecture and the defaults table covers it), downgrade and switch skills:

```
discussion_append(kind='note', body='Triage: simple (downgraded from difficult; reason: <why>)')
# Then load tmb_planning-simple skill instead.
```

## Headless fallback

When `AskUserQuestion` errors OR `TMB_HEADLESS=1` is set, proceed with the spec bro has drafted as if the Human had said "proceed as proposed". Record both:

- `ledger_log(agent='bro', event_type='headless_fallback', summary='tmb_planning-difficult: scope confirmation → auto-accepted')`
- `discussion_append(agent='bro', kind='note', body='Headless fallback: planning-difficult sought scope confirmation, no Human in loop, auto-accepted. Reason: spec was drafted from project context; SWE will surface scope drift if it occurs.')`

Then run the full planning chain (architecture probe, ADR draft, batched task_create_batch + spawn swe + ledger_log). Do NOT skip the ADR — that's the difficult-triage's primary deliverable.
