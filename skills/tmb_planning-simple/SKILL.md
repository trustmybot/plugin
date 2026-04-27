---
name: tmb_planning-simple
description: Bro's planning protocol when triage = simple. Pick defaults from the table, batch all post-triage tool calls in one response, spawn SWE, verify SWE's work, close. Targets ≤30s of bro work + ≤2 min total chain.
agent: bro
allowed-tools: Read, Glob, Grep, Bash, Task, mcp__plugin_tmb_trajectory-server
---

# Planning — Simple Triage

Triage `simple` = narrow scope, no architecture impact, no public API change. The protocol is compressed: bro picks defaults from the table below, never asks ceremonial questions, and emits the spec → SWE spawn → planning audit as a SINGLE batched response.

## Spec brevity (HARD CAP at 8000 chars)

`task_create_batch` rejects `spec_body` >8000 chars. Cite, don't restate — *"Use stdlib argparse + unittest"*, not a 200-line stdlib explainer. Spec longer than 8k usually means the task should split.

## Defaults table — pick, don't ask

| Dimension | Default |
|---|---|
| Python CLI framework | `argparse` (stdlib) |
| Python test runner | `unittest` (stdlib), unless project already uses `pytest` |
| Node test runner | `node:test` (stdlib), unless project uses `vitest`/`jest` |
| Storage (personal tools) | `~/.<app>/<file>.json`, atomic write via tmpfile + rename |
| Storage (project tools) | match existing project convention |
| File layout | single file until ~200 LOC |
| Python version | `python3` (system) |
| Concurrency model | single-user, single-process |

If the project already uses a different tool, **match the existing pattern** — convention wins over the default.

## Required steps (in order)

1. `issue_create(agent='bro', objective, description)` — anchors the work.
2. `discussion_append(kind='note', body='Triage: simple')` — audit-trail row.

3. **HARD RULE — single batched response.** After step 2, your VERY NEXT assistant response must contain ALL FIVE of these tool_use blocks emitted in parallel:
   - `task_create_batch(agent='bro', spec_body=<≤8000 chars, trivial template>, waive_scope_gate=true, waive_scope_gate_reason='<defaults named, e.g. "simple-triage personal CLI: defaulted to argparse + unittest + JSON at ~/.todo/todos.json; no cross-cutting ambiguity">')`
   - `Task(subagent_type='swe', prompt='task_id=<N>', isolation='worktree')` — SWE picks up the row a few seconds later via `task_get`
   - `discussion_append(kind='note', body='Beginning planning on branch_id <branch_id>, triage: simple')`
   - `ledger_log(event_type='planning_complete', summary='...')`
   - (Optional) `discussion_append(kind='question'+'answer'` Q+A pair if you wanted to ask anything — but the simple path's whole point is you don't need to.)

   **Do NOT split these across multiple bro messages.** Each separate message costs 13–60s of round-trip latency. Batched, they run concurrently in ~5s.

4. SWE returns with `status='completed'` and `commit_sha`. Proceed to verification (next section).

## Bro verification protocol — never skip this

Before flipping the task to `closed`, bro MUST verify SWE actually delivered what the spec required. This is the **task gate** — it's not negotiable. The protocol is lean to keep it fast, not to skip it.

### Step V1 — Pull the spec + diff

```
task_get(agent='bro', task_id=<N>)              # spec_body, commit_sha
git diff <commit_sha>~1..<commit_sha>           # actual changes
```

### Step V2 — Three checks (all required)

1. **Files match `## Files`** — every changed file listed in the spec; no surprise files outside scope.
2. **`## Verification` commands pass** — re-run the verification commands from the spec inside the worktree. PASS/FAIL recorded. Don't paraphrase the commands; run them verbatim.
3. **Success criteria visibly met** — for each bullet in `## Success Criteria`, scan the diff for the corresponding code/test. If a criterion has no matching change, fail.

### Step V3 — Decide

- **All three pass** → batch FOUR calls in the SAME response:
  1. `ledger_log(agent='bro', issue_id=<I>, branch_id=<B>, from_node='bro', event_type='bro_verification_pass', summary='V1 files match. V2 verification commands all passed. V3 success criteria visibly met. Closing.')`
  2. **`file_registry_update_summaries(agent='bro', updates=[<one entry per touched path: {path, summary: '<your fresh 1-3 sentence summary based on the diff you just verified>'}], advance_verified_sha=<sha>)`** — you have the full task context (issue + spec + diff just reviewed); SWE doesn't. Server enforces this is bro-only (#181). A PreToolUse hook gates the next call: `task_update_status(closed)` will be DENIED if file_registry doesn't have fresh summaries for the touched paths.
  3. `task_update_status(agent='bro', task_id=<N>, status='closed', commit_sha=<sha>)`
  4. `issue_close(agent='bro', issue_id=<I>)` IF this was the only task on the issue

  Then tell the Human "Trust me bro, it works." **Do NOT call `validation_record`** — that's pr-reviewer's tool and the server will reject the call as `forbidden`. Bro's task gate writes `bro_verification_pass` to the ledger; pr-reviewer's push gate writes `validation_record` later, over the batch.

- **Any check fails** → batch:
  1. `ledger_log(agent='bro', from_node='bro', event_type='bro_verification_fail', summary='<which check> — <details>')`
  2. `discussion_append(kind='note', body='Verification fail: <which check> — <details>')`

  Do NOT close the task. Either re-spawn SWE with feedback (max 3 attempts per task) or escalate to the Human.

### Halt-on-MCP-error

If `task_update_status` or `issue_close` returns `is_error: true`, STOP. Do not emit "Trust me bro, it works." Surface the exact error to the Human. The most common cause is a role-enforcement rejection — meaning the call signature is wrong, not that the close is allowed.

### What this is NOT

- This is **not** pr-reviewer's job. PR-reviewer is the push gate — runs at `git push` over the batch of unsigned commits, with deeper style/security checks.
- This is **not** a re-review of the spec body. The spec was already authored at planning time; you're verifying SWE matched it, not re-deciding what should have been written.

## Escalate simple → difficult when

- Ask names multiple unrelated surfaces (e.g. "auth AND payments").
- Ask implies architecture change (new service, new data store, new cross-cutting concern).
- A default choice carries strategic weight (production database, auth scheme, retention policy).
- The spec can't fit in 8000 chars.

On any trigger, record the override and load `tmb_planning-difficult`:

```
discussion_append(kind='note', body='Triage: difficult (overriding simple proposal; reason: <why>)')
# Then load tmb_planning-difficult skill and proceed there.
```

## Trivial template (this is what you author for spec_body)

```markdown
## Description
<≤3 sentences. Include explicit Assumptions bullets for picked defaults.>

## Files
- path/to/file — action: brief note

## Success Criteria
- Bullet list of testable assertions (2–5 bullets).

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

That's the whole spec_body. Don't pad it; the brevity IS the point.
