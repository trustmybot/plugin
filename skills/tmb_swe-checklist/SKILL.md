---
name: tmb_swe-checklist
description: SWE's self-review heuristics — load only when about to atomic-close. Mechanical patterns (bare except, missing timeout, mutable defaults, etc.) are caught by the plugin's code-quality-lint hook; this skill carries the spec-fidelity and scope discipline judgment.
---

# SWE Self-Review

Before `task_update_status(completed, commit_sha, report)`, confirm these by reading the diff. Mechanical patterns (bare except, mutable defaults, etc.) are caught by the plugin's `code-quality-lint` hook on every Edit/Write. You check the things only a human reader would see.

- **Spec fidelity.** Every `SC<n>` criterion and every error/edge case named in `## Description` has a concrete change in the diff. Each id gets one `report.criteria` entry: `met` with the `evidence_cmd` that proves it (or a `note` pointing to the diff line), `not_met` with what is missing, or `not_applicable` with why.
- **Scope discipline.** `report.extras` lists every path you edited outside the typed `files[]`, each with the reason it had to change. No "while I was there" cleanups. No new TODOs.
- **Rework.** Each of the brief's `open_findings` is fixed, its `probe_cmd` is committed as a test in the repo's own suite, and its id is in `report.findings_fixed`. Run each probe yourself before closing; the gate re-runs every one and refuses the close while any fails.
- **Tests for what you touched.** Run each test and lint covering the files you changed as `node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/test-run.js" -- <command>`. It prints one summary line plus each failure and keeps the full log at its `log=` path; report the pass/fail and that summary line. The gate runs `verification[]` once when you close and records the run for your commit. A dry run or smoke test reports as its command's pass/fail.
- **Changelog.** Where the repo records changes per PR (a fragment directory or a CHANGELOG section), add the task's entry the way the repo does and leave any generated changelog file to its generator.
- **Hook blocks.** A PreToolUse block is a hard stop on that call. A deny that names an allowed form: rerun in that form. A deny that names none, or says it is policy: reach that effect no other way, close with `task_update_status(status='failed')` and no `report`, and quote the exact hook output in your final message. Every run ends through `task_update_status`.

Escalate (not guess) when:

- The spec contradicts itself — quote the contradiction.
- A required fact is missing from the spec — quote what's missing.
- 3 attempts at the same approach failed — show what you tried.
