---
name: tmb_swe-checklist
description: SWE's self-review heuristics — load only when about to atomic-close. Mechanical patterns (bare except, missing timeout, mutable defaults, etc.) are caught by the plugin's code-quality-lint hook; this skill carries the spec-fidelity and scope discipline judgment.
---

# SWE Self-Review

Before `task_update_status(completed, commit_sha, report)`, confirm these by reading the diff. Mechanical patterns (bare except, mutable defaults, etc.) are caught by the plugin's `code-quality-lint` hook on every Edit/Write. You check the things only a human reader would see.

- **Spec fidelity.** Every `SC<n>` criterion and every error/edge case named in `## Description` has a concrete change in the diff. Each id gets one `report.criteria` entry: `met` with the `evidence_cmd` that proves it (or a `note` pointing to the diff line), `not_met` with what is missing, or `not_applicable` with why.
- **Scope discipline.** `report.extras` lists every path you edited outside the typed `files[]`, each with the reason it had to change. No "while I was there" cleanups. No new TODOs.
- **Rework.** Each of the brief's `open_findings` is fixed, its `probe_cmd` is committed as a test in the repo's own suite, and its id is in `report.findings_fixed`. Run each probe yourself before closing; the gate re-runs every one and refuses the close while any fails.
- **Tests for what you touched.** Run the tests and lints covering the files you changed and paste their pass/fail with the tail of their output. The gate runs `verification[]` once when you close and records the run for your commit. A dry run or smoke test reports as its command's pass/fail.
- **Changelog.** Where the repo records changes per PR (a fragment directory or a CHANGELOG section), add the task's entry the way the repo does and leave any generated changelog file to its generator.
- **Hook blocks.** A PreToolUse block is a hard stop — surface its exact output and wait.

Escalate (not guess) when:

- The spec contradicts itself — quote the contradiction.
- A required fact is missing from the spec — quote what's missing.
- 3 attempts at the same approach failed — show what you tried.
