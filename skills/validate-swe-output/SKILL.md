---
description: Fork an Explore subagent to verify a completed SWE task against its markdown spec and MCP state, then return a verdict.
context: fork
agent: Explore
allowed-tools: Read, Grep, Glob, Bash
invoked-by: architect
---

# validate-swe-output

## A. Purpose

Verify a completed SWE task in a forked context window. Confirm MCP task status,
re-run the spec's `## Verification` commands, diff actual changes against the
declared `## Files` list, and return a structured verdict block to the calling
Architect. The forked context means no side effects can leak back to the
Architect's workspace.

The Architect invokes this skill; the forked Explore agent runs all checks
independently, and only the verdict crosses back. Saves roughly 30K tokens
per validation cycle by keeping pytest/diff output out of the Architect's
context window.

## B. Inputs (provided by the Architect in the invocation message)

- `task_id` — MCP task ID (integer); the primary input; used to fetch the spec via `task_get`
- `commit_range` — SHA range of the SWE commit(s), e.g. `HEAD~1..HEAD`
- `changed_files` — space-separated list of files SWE reported modifying

## C. Execution Steps

### Step 1 — Check MCP task status

Call `task_get(task_id)` to retrieve the task row from SQLite.

If the task does not exist or `task_get` returns an error:
```
verdict: escalate
findings: task_get({task_id}) returned no row. Cannot validate without MCP state.
```
Stop immediately.

If `status` is not `'completed'`:
```
verdict: escalate
findings: task_get({task_id}) shows status='{status}', expected 'completed'.
          SWE may not have finished or called task_update_status correctly.
```
Stop immediately.

### Step 2 — Read the task spec

Call `task_get(task_id)` and read `spec_body`. Locate the `## Verification`
section within the returned body.

If the row is missing or `spec_body` is empty:
```
verdict: escalate
findings: task_get({task_id}) returned no row or empty spec_body. Cannot validate without the contract.
```
Stop immediately.

If the spec body has no `## Verification` section:
```
verdict: escalate
findings: Spec has no ## Verification section. Task is underspecified — escalate to Architect.
```
Stop immediately.

### Step 3 — Run verification commands

Extract every command from the spec's `## Verification` section and run each one.
Run from the directory specified in the section (default: repository root).

Collect stdout and exit code for each command.

If any command fails due to an environmental reason (tool not found, missing
deps, timeout):
```
verdict: escalate
findings: Verification command failed for environmental reason: {command} — {error text}
```
Stop immediately.

If any verification command produces FAIL markers or a non-zero exit code:
Record it as a failure. Continue running remaining commands to collect the full
picture, then return `verdict: fail` (see Step 6).

### Step 4 — Diff actual changes against declared files

Run:
```bash
git diff {commit_range} -- {changed_files}
```

Compare the diff against the `## Files` section in the spec:
- Every file listed in `## Files` as create or modify must appear in the diff.
- No file outside the listed paths should appear in the diff (scope creep).

If changed files do not match the declared `## Files` list:
```
verdict: fail
findings: Changed files do not match ## Files. Offending paths: {list paths not in spec or missing from diff}.
```

### Step 5 — Check error-handling and edge-cases coverage

For each error-handling and edge-case item described in the spec's
`## Description` or `## Success Criteria`:
- Use Grep or a Read pass to confirm the condition has a corresponding branch
  in the changed code.
- Count the items. If the spec lists N cases, the code must handle N cases.

Record which cases are covered and which are missing.

### Step 6 — Record verdict via MCP and return summary

Call `validation_record(task_id=task_id, verdict='pass'|'fail'|'escalate', notes=...)`.

Then return one of the following verdicts to the Architect.

**Pass** — MCP status is `completed`, all verification commands succeeded,
diff matches spec files, all error/edge cases are covered:
```
verdict: pass
commands-run:
  {each command run, one per line}
findings: MCP task_get confirmed status=completed. All verification commands passed.
          Diff matches declared ## Files. All {N} error-handling and edge-case entries confirmed covered.
          validation_record(pass) appended.
```

**Fail** — any check failed. Include first 10 and last 10 lines of failing output:
```
verdict: fail
commands-run:
  {each command run, one per line}
findings:
  {For each failure: which check failed, what was expected, what was observed.
   For long output: include first 10 lines and last 10 lines only.}
  validation_record(fail) appended.
```

**Escalate** — environmental failure (tool missing, dependency absent, timeout,
spec missing, MCP error):
```
verdict: escalate
commands-run:
  {commands attempted before failure}
findings: {exact error text from the failing tool or command}
```

## D. Constraints

- This forked agent MUST NOT commit, push, edit, or write any file.
- Bash usage is limited to read-only verification: `git diff`, `git log`,
  test runners in read-only mode, `cat`, `ls`, `wc`, `grep`, `sqlite3`
  read-only queries. Never run `git add`, `git commit`, `git push`, Write,
  or Edit.
- MCP calls are allowed: `task_get` (read) and `validation_record` (write) only.
- The forked context window means side effects cannot leak back to the calling
  Architect's workspace state, but this constraint still applies as defense in
  depth.
- Return the verdict block and nothing else as the final output. The Architect
  reads only that block.
