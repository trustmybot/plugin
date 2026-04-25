# TMB Performance — latency budget + design decisions

This doc records the latency target, the measured baseline from #63, the optimizations shipped in #64, and the **doctrine of what's safe to trim** so future contributors can decide where to spend complexity budget.

## Target

Plugin overhead vs pure Claude Code on the same ask should land in this band:

| Ask shape | Pure Claude | TMB target | Acceptable ceiling |
|---|---|---|---|
| Trivial single-file (typo, comment) | ~10s | ~10–20s (Direct Mode) | 30s |
| Simple task (CLI todo, single feature) | ~30s | ~2–3 min | 5 min |
| Difficult task (architecture change, ADR + multiple files) | ~2 min | ~5–8 min | 12 min |
| Multi-task batch | n/a | ≤ 1.5× single-task per task | 2× per task |

The 1.5× ceiling for batches reflects amortizing planning + audit across multiple tasks.

## Baseline (PR #63 — pre-optimization)

Verified Layer 3 dogfood run for a single CLI-todo ask (simple triage):

```
19:54:43  issue created
19:55:34  planning_complete           Δ 51s          (simple-fast-lane planning)
19:59:10  tmb_bootstrap_complete      Δ 3min 36s     (interactive AskUserQuestion + 9 file copies — one-time per project)
20:03:48  task → completed            Δ 4min 38s     (sonnet SWE: cold-start + worktree + 3 files + tests + commit)
20:06:44  validation pass + closed    Δ 2min 56s     (opus pr-reviewer: cold-start + read diff + verdict)
20:08:11  issue → closed              Δ 1min 27s     (bro wrapper, issue_close)
─────────
Total:    ~12 min wall-clock
```

Subtracting the one-time bootstrap (~3.5min): subsequent tasks ran ~8.5min. Pure Claude on the same ask: ~32s. **Ratio: ~16× pure-Claude.** Above the 5-min acceptable ceiling for simple tasks.

## Doctrine — what's safe to trim, what isn't

The 12-minute baseline has overhead in three categories. Each has a different trim budget:

### Tier 1 — pure waste, trim aggressively

- Sequential MCP writes that could batch in one assistant response (fixed in #64 by emitting `task_create_batch` + `Task(swe)` + `ledger_log` as parallel tool_use blocks).
- Subagent prompts that include forced chain-of-thought blocks for tasks that don't benefit from them (fixed for SWE in #64; SWE template's `<chain_of_thought>` requirement removed).
- Eager skill loading that fires on every spawn but is needed in <30% of spawns (fixed in #64; `swe-checklist` moved to lazy-load via Skill tool when the spec's `## Verification` actually needs interpretation).
- Two-question UX ("approve onboarding" + "approve bootstrap") collapsed into one (fixed in #64; bootstrap folded into onboarding's existing approval scope).

### Tier 2 — design overhead, trim with care

- Per-task pr-reviewer spawn. Justified for difficult-triage architectural work; not justified for every typo. Fixed in #64 by making pr-reviewer the **push gate** instead of the **task gate**. Bro auto-closes tasks; pr-reviewer fires at `git push` time over the batch of unsigned commits.
- Worktree creation. Justified for code isolation; cost ~3-5s. Parallelized with `task_get` in #64.
- Forced subagent cold-start when bro could just edit. Fixed in #64 by introducing **Direct Mode**: bro edits trivial single-file changes (≤3 lines, typo/comment scope) directly without spawning SWE.

### Tier 3 — load-bearing overhead, do NOT trim

- The trajectory DB (issues, tasks, discussions, validation_attempts, ledger). The audit trail IS the product. ~50–200ms per write; total ~5–10s per task. Don't try to skip writes for speed.
- `requireRoles` server-side enforcement of the decision chain. ~1ms per check. Don't bypass for speed.
- Worktree isolation for SWE. Cost ~3-5s; benefit is preventing one task from corrupting another's working tree. Don't skip.
- Pre-push gate. Cost is paid once per push regardless of task count. Don't skip; it's the only structural protection against pushing unreviewed commits.

## Changes shipped in #64

| Change | Source proposal | Estimated impact |
|---|---|---|
| pr-reviewer = push gate (not task gate) | DISCUSSION.md #1 + #2 | -3min per task, -1min per push (amortized) |
| Bootstrap folded into onboarding (zero extra question) | DISCUSSION.md #3 | -30s to -1min, removes a question |
| SWE template: drop `<chain_of_thought>` block | DISCUSSION.md #4a | -30s to -1min per task |
| SWE template: lazy-load `swe-checklist` skill | DISCUSSION.md #4b | -10–20s per task |
| SWE template: parallel `task_get` + `git worktree add` | DISCUSSION.md #4c | -5–10s per task |
| Direct Mode for trivial single-file changes | DISCUSSION.md #5 | -5+ min for those specific asks |
| Planner emits `task_create_batch` + Task(swe) + `ledger_log` in one response | Q2 lighter | -5–10s of MCP write serialization |

Conservative estimate of total impact on the simple-task path: **~12 min → ~3–5 min**. Direct Mode cuts trivial asks to **~10–20s**, approaching pure-Claude.

## Verification (Layer 3 — pending after this PR ships)

Re-run the same `@bro write a cli todo by python` scenario from #63 in a fresh Mode B session. Record:

- Time to first ledger event (planning_complete)
- Time to task → completed (SWE work)
- Time to task → closed (bro flip — should be ~immediate after SWE return now)
- Time to issue → closed (bro wrap)
- Total wall-clock

Compare line-by-line to the #63 baseline timeline above.

For Direct Mode: separately fire a typo-fix ask (`@bro fix typo "recieve" → "receive" in README.md`). Time it. Should be <30s.

## Re-evaluation triggers

Open this doc and re-measure when any of:

- A new SWE-spawn or pr-reviewer-spawn cold-start in a Layer 3 dogfood takes >2× the previous baseline.
- A user reports a chain that took >12 min for a simple-triage task in real use.
- We add a new gate / hook / skill that fires on the per-task path.
- CC platform changes the subagent cold-start cost (model swap, tool-registration overhead, etc.).
