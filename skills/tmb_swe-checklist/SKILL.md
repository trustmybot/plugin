---
name: tmb_swe-checklist
description: SWE's self-review heuristics — load only when about to atomic-close. Mechanical patterns (bare except, missing timeout, mutable defaults, etc.) are caught by scripts/hooks/code-quality-lint.sh; this skill carries the spec-fidelity and scope discipline judgment.
---

# SWE Self-Review

Before `task_update_status(completed)`, confirm these by reading the diff. Mechanical patterns (bare except, mutable defaults, etc.) are caught by `scripts/hooks/code-quality-lint.sh` on every Edit/Write. You check the things only a human reader would see.

- **Spec fidelity.** Every bullet under `## Success Criteria` and every error/edge case named in `## Description` has a concrete change in the diff. Quote the item, point to the diff line.
- **Scope discipline.** Your close report lists every path you edited outside the typed `files[]`, each with the reason it had to change. No "while I was there" cleanups. No new TODOs.
- **Tests for what you touched.** Run the tests and lints covering the files you changed and paste their pass/fail with the tail of their output. The gate runs `verification[]` once when you close and records the run for your commit. A dry run or smoke test reports as its command's pass/fail.
- **Changelog fragment.** Where the repo keeps `changelog.d/`, add `changelog.d/<gh>-<slug>.md` and leave `CHANGELOG.md` as it is.
- **After a rebase.** Run `scripts/maintenance/regen-generated.sh` where the repo has it, and commit what it regenerated.
- **Hook blocks.** A PreToolUse block is a hard stop — surface its exact output and wait.

Escalate (not guess) when:

- The spec contradicts itself — quote the contradiction.
- A required fact is missing from the spec — quote what's missing.
- 3 attempts at the same approach failed — show what you tried.
