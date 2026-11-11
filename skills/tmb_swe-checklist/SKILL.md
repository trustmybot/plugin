---
name: tmb_swe-checklist
description: SWE's self-review heuristics — load only when about to atomic-close. Mechanical patterns (bare except, missing timeout, mutable defaults, etc.) are caught by the plugin's code-quality-lint hook; this skill carries the spec-fidelity and scope discipline judgment.
---

# SWE Self-Review

Before `task_update_status(completed, commit_sha, report)`, confirm these by reading the diff. Mechanical patterns (bare except, mutable defaults, etc.) are caught by the plugin's `code-quality-lint` hook on every Edit/Write. You check the things only a human reader would see.

- **Spec fidelity.** Every `SC<n>` criterion and every error/edge case named in `## Description` has a concrete change in the diff. Each id gets one `report.criteria` entry: `met` with the `evidence_cmd` that proves it (or a `note` pointing to the diff line), `not_met` with what is missing, or `not_applicable` with why.
- **Case sweep.** For each rule or pattern the diff changes and each open finding's `class`, search the diff and the changed symbols' callers for every other instance, fix the ones in scope, and name the rest in the report. `report.case_sweep` lists one `{class, checked}` entry per class, `checked` holding each `file:line` or symbol you looked at. code-reviewer checks it against the diff, and a sibling it missed fails the review only when it breaks function.
- **Scope discipline.** `report.extras` lists every path you edited outside the typed `files[]`, each with the reason it had to change. No "while I was there" cleanups. No new TODOs.
- **Rework.** Each of the brief's `open_findings` is fixed, along with every sibling of its `class` (the case sweep above), its `probe_cmd` is committed as a test in the repo's own suite, and its id is in `report.findings_fixed`. Run each probe yourself before closing; the close gate re-runs the probe of every open blocking finding (nit and pre_existing findings are not probed) and refuses the close while any fails.
- **Tests for what you touched.** Run each test and lint covering the files you changed as `node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/test-run.js" -- <argv...>`, or `-- bash -c '<cmd>'` for shell syntax. It prints one summary line plus each failure and keeps the full log at its `log=` path; give the pass/fail and that summary line as evidence in `report`. Before closing, also run the repo's CI lint command through the same wrapper; CI runs the full suite. The gate runs `verification[]` once when you close and records the run for your commit. A dry run or smoke test reports as its command's pass/fail.
- **Changelog.** Where the repo records changes per PR (a fragment directory or a CHANGELOG section), add the task's entry the way the repo does and leave any generated changelog file to its generator.
- **Hook blocks.** A PreToolUse block is a hard stop on that call. A deny that names an allowed form: rerun in that form. A deny that names none, or says it is policy: reach that effect no other way, close with `task_update_status(status='failed')` and no `report`, and quote the exact hook output in your final message. Every run ends through `task_update_status`. Change file contents with Edit or Write; Bash runs commands and read-only probes, so an inline python, node or sed program that rewrites a file goes through Edit or Write instead.

Escalate (not guess) when:

- The spec contradicts itself — quote the contradiction.
- A required fact is missing from the spec — quote what's missing.
- 3 attempts at the same approach failed — show what you tried.
