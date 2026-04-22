---
description: Fork an Explore subagent to verify a completed SWE task against its XML contract and return a verdict.
context: fork
agent: Explore
allowed-tools: Read, Grep, Glob, Bash
invoked-by: architect
---

# validate-swe-output

## A. Purpose

Verify a completed SWE task in a forked context window. Re-run the task's
verification commands, diff the actual changes against the declared scope, and
return a structured verdict XML block to the calling Architect. The forked
context means no side effects can leak back to the Architect's workspace.

This skill replaces the Architect's inline validation work. The Architect
invokes it, the forked Explore agent runs all checks independently, and only
the verdict XML crosses back. Saves roughly 30K tokens per validation cycle.

## B. Inputs (provided by the Architect in the invocation message)

- `task_xml_path` — absolute path to the task XML file for the completed task
- `commit_range` — SHA range of the SWE commit(s), e.g. `HEAD~1..HEAD`
- `changed_files` — space-separated list of files SWE reported modifying

## C. Execution Steps

### Step 1 — Read the task XML

Read the full task XML at `task_xml_path`.

If the file does not exist:
```xml
<validation>
  <verdict>escalate</verdict>
  <commands-run>Read task XML at {task_xml_path}</commands-run>
  <findings>Task XML not found at the provided path: {task_xml_path}. Cannot validate without the contract.</findings>
</validation>
```
Stop immediately.

If the task XML has no `<verification>` block:
```xml
<validation>
  <verdict>escalate</verdict>
  <commands-run>Read task XML at {task_xml_path}</commands-run>
  <findings>Task XML has no &lt;verification&gt; block. Task is underspecified — escalate to Architect.</findings>
</validation>
```
Stop immediately.

### Step 2 — Run verification commands

Extract every command from the task's `<verification>` block and run each one.
Run from the directory specified in the block (default: repository root).

Collect stdout and exit code for each command.

If any command fails due to an environmental reason (tool not found, missing
deps, timeout):
```xml
<validation>
  <verdict>escalate</verdict>
  <commands-run>{list commands attempted}</commands-run>
  <findings>Verification command failed for environmental reason: {command} — {error text}</findings>
</validation>
```
Stop immediately.

If any verification command produces FAIL markers or a non-zero exit code:
Record it as a failure. Continue running remaining commands to collect the full
picture, then return `verdict=fail` (see Step 5).

### Step 3 — Diff actual changes against declared scope

Run:
```bash
git diff {commit_range} -- {changed_files}
```

Compare the diff against the `<scope>` block in the task XML:
- Every file listed in `<scope>` as CREATE or MODIFY must appear in the diff.
- No file outside the `<scope>` paths should appear in the diff (scope creep).

If changed files do not match the declared `<scope>` paths:
```xml
<validation>
  <verdict>fail</verdict>
  <commands-run>git diff {commit_range} -- {changed_files}</commands-run>
  <findings>Changed files do not match &lt;scope&gt;. Offending paths: {list paths not in scope or missing from diff}.</findings>
</validation>
```

### Step 4 — Check error-handling and edge-cases coverage

For each entry in the task XML's `<error-handling>` and `<edge-cases>` blocks:
- Use Grep or a Read pass to confirm the trigger/input condition has a
  corresponding branch in the changed code.
- Count the entries. If the task lists N cases, the code must handle N cases.

Record which cases are covered and which are missing.

### Step 5 — Compose and return verdict XML

Collect all results from Steps 2–4 and return one of the following verdicts.

**Pass** — all verification commands succeeded, diff matches scope, all
error/edge cases are covered:
```xml
<validation>
  <verdict>pass</verdict>
  <commands-run>
    {each command run, one per line}
  </commands-run>
  <findings>All verification commands passed. Diff matches declared scope. All {N} error-handling and edge-case entries confirmed covered.</findings>
</validation>
```

**Fail** — any verification command failed, scope mismatch, or missing
error/edge-case coverage. Include first 10 and last 10 lines of failing output:
```xml
<validation>
  <verdict>fail</verdict>
  <commands-run>
    {each command run, one per line}
  </commands-run>
  <findings>
    {For each failure: which check failed, what was expected, what was observed.
     If SWE's &lt;results&gt; reports FAILED, copy SWE's summary here.
     For long output: include first 10 lines and last 10 lines only.}
  </findings>
</validation>
```

**Escalate** — environmental failure (tool missing, dependency absent, timeout,
task underspecified, XML not found):
```xml
<validation>
  <verdict>escalate</verdict>
  <commands-run>
    {commands attempted before failure}
  </commands-run>
  <findings>{exact error text from the failing tool or command}</findings>
</validation>
```

## D. Constraints

- This forked agent MUST NOT commit, push, edit, or write any file.
- Bash usage is limited to read-only verification: `git diff`, `git log`,
  test runners in read-only mode, `cat`, `ls`, `wc`, `grep`, `sqlite3`
  read-only queries. Never run `git add`, `git commit`, `git push`, Write,
  or Edit.
- The forked context window means side effects cannot leak back to the calling
  Architect's workspace state, but this constraint still applies as defense in
  depth.
- Return the verdict XML block and nothing else as the final output. The
  Architect reads only that block.
