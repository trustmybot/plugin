---
name: tmb_direct-mode
description: Narrow bypass for trivial single-file changes (≤3 lines, no API change, no docs/trustmybot/architecture/ touch) — bro edits the file directly, commits with chore message, logs direct_mode_used to ledger. Skips the planner-spawn-review chain. Loaded when bro recognizes a Direct Mode candidate.
agent: bro
allowed-tools: Read, Edit, Bash, mcp__plugin_tmb_trajectory-server__ledger_log
---

# direct-mode

## Purpose

The default decision chain (Human → bro → SWE → bro task gate → push gate) is correct overkill for a typo fix. Direct Mode is the one-line escape valve: bro edits the file, commits, logs, done. No issue, no task, no SWE spawn, no planning skill.

The narrow scope IS the discipline. If you find yourself extending Direct Mode "just for this one case," stop — that's the slippery slope this rule guards against.

## When to engage — ALL must hold

- **Single file change.**
- **≤3 lines diff.** Typo fix, comment, constant bump, one-line README rewording.
- **No public API change**, no new file, no test change required.
- **No `docs/trustmybot/architecture/` touched** — that's always difficult-triage.

If any condition fails, **fall back to the default chain** — propose an issue + task + SWE spawn with a brief explanation to the Human.

## Protocol — ALL THREE STEPS ARE MANDATORY

The skill is exactly three steps. **You MUST emit all three. The third is the audit trail and is the most commonly-skipped step — if you stop after step 2 you have committed code with no record that Direct Mode was used, indistinguishable from rogue bro behavior.**

1. `Edit` (the file) — the actual fix
2. `Bash (git commit -m "chore: ...")` — atomic commit with conventional-commit message
3. `ledger_log(agent='bro', event_type='direct_mode_used', summary='<one-line description of the fix>')` — **NEVER SKIP THIS.** This is what distinguishes "bro intentionally used Direct Mode" from "bro freelanced an edit"

Batch all three as parallel tool_use blocks in a single response when feasible (the ledger_log doesn't depend on the commit's exit code).

That's the whole skill. No `task_create_batch`. No `Task(subagent_type='swe', ...)`. No `planning_complete` ledger event. No bro verification step (the diff is small enough that bro reading it IS the verification). But the `direct_mode_used` ledger event is **non-negotiable**.

## Examples

- "@bro fix the typo `recieve` → `receive` in README.md" → Direct Mode
- "@bro bump the timeout constant from 30 to 60 in config.ts" → Direct Mode
- "@bro add a comment explaining why we use BTreeMap here" → Direct Mode

## Counter-examples — NOT Direct Mode

- "@bro rename this function" — touches every caller, multi-file
- "@bro add error handling" — likely test changes too
- "@bro update the README to reflect v0.5" — usually multi-section, plus might touch architecture docs

## Never

- Silently extend Direct Mode to "small but multi-file" — that's a planning skill ask.
- Skip the `direct_mode_used` ledger event. It's how `git log` and the trajectory diverge become reconcilable.
- Use Direct Mode when the change touches anything in `docs/trustmybot/architecture/` — those changes are by definition difficult-triage and need an ADR.
