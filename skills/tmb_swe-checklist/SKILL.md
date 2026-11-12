---
name: tmb_swe-checklist
description: SWE's self-review before close. Mechanical patterns (bare except, missing timeout, mutable defaults, etc.) are caught by the plugin's code-quality-lint hook; this skill carries the spec-fidelity and scope discipline judgment.
---

# SWE Self-Review

Before `task_update_status(completed, commit_sha, report)`, confirm these by reading the diff. Mechanical patterns (bare except, mutable defaults, etc.) are caught by the plugin's `code-quality-lint` hook on every Edit/Write. You check the things only a human reader would see.

- **Spec fidelity.** Every `SC<n>` criterion and every error/edge case named in `## Description` has a concrete change in the diff.
- **Scope discipline.** No "while I was there" cleanups and no new TODOs: name an out-of-scope defect in your final message for bro to file instead.
- **Prompt and docs changes.** When the preloaded `tmb_doc-review` skill applies (its "When it applies" section; your brief's `files[]` and diff tell you), run its steps 1–4 on your commit and fix every blocking result before closing. List the rubric ids you graded and each fact-check and contradiction probe in `report.case_sweep`, one entry per class (`rubric`, `fact`, `consistency`), so code-reviewer grades these results instead of re-running steps 1–4; give every claim its probe, because a claim without one is what it spot-checks.
- **Tests for what you touched.** Run each test and lint covering the files you changed as `node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/test-run.js" -- <argv...>`, or `-- bash -c '<cmd>'` for shell syntax. It prints one summary line plus each failure and keeps the full log at its `log=` path; give the pass/fail and that summary line as evidence in `report`. Before closing, also run the repo's CI lint command through the same wrapper. Locally you run the touched-path tests, and your world-model caller check stands in for the full suite; CI only confirms, so a CI failure is a leak from this layer. The gate runs `verification[]` once when you close and records the run for your commit. A dry run or smoke test reports as its command's pass/fail.
- **Changelog.** Where the repo records changes per PR (a fragment directory or a CHANGELOG section), add the task's entry the way the repo does and leave any generated changelog file to its generator.

Rather than guess, close with `task_update_status(status='failed')` and quote it in your final message when:

- The spec contradicts itself — quote the contradiction.
- A required fact is missing from the spec — quote what's missing.
- 3 attempts at the same approach failed — show what you tried.
