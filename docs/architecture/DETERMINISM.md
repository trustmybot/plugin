# Determinism vs. Judgment — Layering Rules

The architectural rule for every line of every skill, agent prompt, hook, and MCP tool in this plugin:

> **If a step could fail because the LLM forgot, misordered, or misunderstood it, that step does not belong in a prompt. It belongs in a deterministic layer.**

Skills, CLAUDE.md, and agent files are reserved for the irreducibly judgment-bound parts of the workflow. Everything else migrates to one of the deterministic layers below.

---

## The seven mechanisms (ordered by enforcement strength)

| # | Mechanism | What it does | Right shape for |
|---|---|---|---|
| 1 | **Server-side defaults** | LLM omits an arg; server fills it from policy state | Per-arg defaults: `parent_branch_id` ← `config('pr_target')`; `repo` ← `config('tmb_default_repo')` |
| 2 | **Atomic composite tools** | Multi-step workflow wrapped into one MCP call inside one DB transaction | Multi-step batches that the LLM today emits as N separate calls and frequently drops the last one |
| 3 | **PreToolUse hooks (block)** | LLM cannot proceed without prerequisite; hook returns `decision: block` | "Don't run X without Y first" — e.g. push-gate, no-source-edit-from-main, require-task-spec, require-feature-branch-active |
| 4 | **PostToolUse hooks (side-effect)** | After a tool call, auto-emit follow-up events or queue downstream work | Auto-derived audit events, cleanup-worktree-on-task-close, write-active-workspace-sentinel |
| 5 | **UserPromptSubmit hooks (inject)** | Inject directives into the LLM's context at prompt arrival, before the LLM responds | Pattern-detected routing hints ("consultant question → spawn Agent first") |
| 6 | **`requireRoles` / wire enforcement** | Server rejects forbidden tool calls with `is_error: true` regardless of prompt content | Role-bound tool access — bro/swe/pr-reviewer/consultant boundaries |
| 7 | **Skill prose + AskUserQuestion** | LLM reads markdown and applies judgment | Irreducibly judgment-bound work only |

Mechanism 7 is the *fallback*, not the default. Anything that fits 1–6 should migrate.

---

## What stays in mechanism 7 (skills + CLAUDE.md + agent files)

Recognizable by the verb. **Anything that is *classifying*, *composing*, or *weighing novel context*.**

| Verb class | TMB examples |
|---|---|
| **Classify / decide** | "Is this triage difficult or simple?" "Is this scope creep?" "Should I downgrade triage?" "Is this an emergent ADR or routine task?" |
| **Draft / compose** | Spec body, ADR prose, commit messages, issue descriptions, Q+A wording, discussion notes |
| **Weigh / trade off** | "Should I raise this concern with the human?" "Is the simpler alternative acceptable?" "Should the scope split into multiple tasks?" |
| **Synthesize from novel context** | Roundtable participant arguments, code review qualitative assessment, consultant-style analysis |
| **Recognize patterns in unfamiliar input** | Codebase memory verify, "does this diff match the spec?", "is this a regression in the diff?" |

These have no deterministic substitute. Code cannot classify "difficult" universally because the criteria require contextual judgment over an open-ended input space.

---

## What migrates out of mechanism 7

Recognizable by mechanism. **Anything that is *sequencing*, *defaulting*, *constraining*, or *measuring* against a stable specification.**

| Pattern in current skill prose | Migrates to |
|---|---|
| "Then call X with Y" (multi-step) | (2) Atomic composite — one MCP call does both steps inside a transaction |
| "If config has X, use it; otherwise default Y" | (1) Server-side default |
| "Don't proceed until Z has happened" | (3) PreToolUse hook with state check |
| "After A, also do B" | (4) PostToolUse hook |
| "Tool X is forbidden for role Y" | (6) `requireRoles` |
| "Probe the environment for X, Y, Z" | MCP tool (e.g., `project_metadata_detect`) |
| "Validate input matches schema" | MCP tool's input validation |
| "Enforce file naming convention" | (3) Lint hook |
| "Ensure committed before push" | (3) Pre-push hook |
| "Always emit a closing audit_log after task creation" | (2) Composite (`emit_planning_complete=true` flag) |

---

## The boundary test (apply this to any prompt line)

For every numbered step or imperative in a skill, agent file, or CLAUDE.md:

1. **Strike the verb.** Is what remains a *fact about the world* (file exists, role has access, value is X)? → migrate. Is it a *judgment* (is this good, is this difficult, what should I write)? → keep.
2. **Imagine the LLM dropping this line.** Does the workflow break in a deterministic way (test fails, hook blocks, server rejects)? Then determinism is missing — build the deterministic safety net so the prose isn't the safety net.
3. **Check token cost vs. failure rate.** A 5-step skill costs ~5K tokens loaded and has ~0.95⁵ ≈ 77% adherence at typical adherence per step. A 1-call composite costs ~100 tokens loaded and has ~95% adherence. The math always favors migration when the steps are deterministic.

---

## Why this matters: the math

LLM-driven multi-step workflows have **compound failure**. Per-step adherence is typically 90-97% for instructions buried in context. For an N-step procedural batch:

| N (steps) | P(success) at p=0.95 | P(success) at p=0.90 |
|---:|---:|---:|
| 1 | 95% | 90% |
| 3 | 86% | 73% |
| 5 | 77% | 59% |
| 7 | 70% | 48% |

This is why L5 dogfood reproduces "skipped step" failures. The skill says "do X, Y, Z" and at runtime the LLM does X, Y, drops Z. Not because it's broken — because that's the noise floor of long procedural prose.

Atomic composites collapse N → 1: one call decision, deterministic execution. Same pre-LLM 95% adherence applies, but only to one event. Empirically, migration of multi-step batches to composites raises L5 flow pass rate from ~60-77% to ~95% per flow.

---

## TMB-specific applications (current state, 2026-05)

### Already migrated

- **Stack detection** (was: bash probe block in `tmb_planning-difficult` SKILL.md → now: `project_metadata_detect` MCP tool with hybrid enry/file-presence). Mechanism 1+ (deterministic operation persisted to DB).
- **`emit_planning_complete=true`** flag on `task_create_batch` (was: prose in skills "remember to also call audit_log(planning_complete)" → now: server-side audit emission inside the same transaction). Mechanism 2.
- **`parent_branch_id` default** in `task_create_batch` (was: prose "remember to read pr_target" → now: server reads `config('pr_target')` when omitted). Mechanism 1.
- **Architect role doctrine** (was: skill prose "Tools bro must NEVER call" → now: `requireRoles` rejects on the wire regardless of prompt). Mechanism 6.
- **Push gate** (was: skill prose → now: pre-push hook blocks unsigned commits). Mechanism 3.
- **No source edit from main** (was: skill prose → now: PreToolUse hook). Mechanism 3.
- **Worktree creation** (was: skill prose → now: WorktreeCreate hook routes to right repo). Mechanism 3.
- **Atomic close-batch validation** (file_registry freshness gate before `task_update_status(closed)`). Mechanism 3.
- **Naming conventions** (was: `tmb_naming-conventions` skill prose → now: `scripts/hooks/naming-lint.sh` PreToolUse on Edit/Write/MultiEdit). Mechanism 3.
- **Git conventions** (was: `tmb_git-conventions` skill prose → now: `scripts/hooks/commit-msg-lint.sh` PreToolUse on Bash + existing `git-push-guard.sh` + `git-guards.sh`). Mechanism 3.
- **Mechanical code-quality patterns** (was: half of `tmb_code-quality` prose → now: `scripts/hooks/code-quality-lint.sh` PreToolUse on Edit/Write — qualitative criteria stay in the skill). Mechanism 3.
- **Project prescan inventory** (was: `tmb_project-prescan` Phases 1–4 prose → now: `scripts/hooks/session-start-prescan.sh` SessionStart hook injects inventory as `additionalContext`). Mechanism 4 (SessionStart hook).
- **Lazy-regen drift detection** (was: `tmb_lazy-regen-check` skill prose → now: `scripts/hooks/lazy-regen-postcheck.sh` PostToolUse on `file_registry_update_summaries` + existing `session-start-regen-check.sh`). Mechanism 4.
- **Roundtable cleanup verification** (was: `tmb_roundtable-cleanup` skill prose → now: `scripts/hooks/roundtable-cleanup-postcheck.sh` PostToolUse on `roundtable_close`). Mechanism 4.
- **Greenfield architecture_regen enforcement** (was: skill prose "remember to bootstrap arch docs first" → now: `scripts/hooks/greenfield-arch-required.sh` PreToolUse on `task_create_batch`). Mechanism 3.
- **Consultant spawn hint** (was: prompt prose "consider spawning a consultant" → now: `scripts/hooks/consultant-spawn-required.sh` UserPromptSubmit injects advisory `additionalContext` on domain-expert keywords). Mechanism 5.
- **branch_id derivation** (was: `tmb_branch-id-proposal` Step 1 mapping table → now: `branch_id_propose` MCP composite returns `{ branch_id, triage, confidence }` from free-text intent). Mechanism 2.
- **SWE retry composite** (was: 5-step prose recipe in `tmb_feedback-loop` → now: `task_retry_batch(failed_task_id, ...)` MCP composite — one transaction for rationale append + new task insert + audit). Mechanism 2.
- **Bro atomic close** (was: prose 4-call V3 batch → now: `bro_atomic_close(task_id, sha, summaries, ...)` MCP composite — one transaction for audit + summaries + status flip + optional issue close). Mechanism 2.

### Irreducibly mechanism 7 (will always be skill prose)

- `tmb_planning-simple` triage decision (the *defaults table* is reference; the *picking* is judgment).
- `tmb_planning-difficult` Q+A loop and ADR drafting.
- `tmb_concerns-protocol` (when to disagree with the human).
- `tmb_roundtable` orchestration.
- `tmb_agent-creator` / `tmb_skill-creator` Q+A and approval flow.
- `tmb_review-protocol` qualitative diff assessment (PR Reviewer's judgment).
- `tmb_review-findings` pattern recognition during review.
- `tmb_code-quality` qualitative criteria.
- `tmb_docs-conventions` prompt-editing discipline.
- `tmb_headless-fallback` "when to fall back" judgment.
- `tmb_recovery` failure-mode classification (AUQ-error / MCP is_error / trajectory-server-down — each with a documented default + audit + degraded-mode script).
- `tmb_review` pr-reviewer's qualitative phases + bro's push-gate orchestration + bro's PR-comment triage.
- `tmb_planning` triage classification + cold-start deep-scan judgment + branch-id confirmation + spec authoring (simple defaults vs difficult Q+A + ADR) + V1/V2/V3 verification + retry-on-fail + architecture refresh.
- `tmb_swe-checklist` SWE's self-review judgment (SWE-bound).
- `tmb_concerns-protocol` (when to disagree with the human).
- `tmb_agent-creator` / `tmb_skill-creator` Q+A + draft + approval flow.
- `tmb_docs-conventions` prompt-edit discipline (loaded by SWE when the spec names a markdown file).
- `/roundtable` slash command (Human-triggered multi-agent deliberation; the procedural body lives in `commands/roundtable.md`, not as a skill).
- `/onboard` slash command (Human-triggered policy ceremony; replaces the prior `tmb_reonboard` skill).

---

## Trajectory of the skill set

| Snapshot | Skill count | Approx skill prose lines | Notes |
|---|---:|---:|---|
| 2026-05-04 (pre-PR #179) | 28 | ~2000 | Many skills encode determinism alongside judgment; L5 = 10/19 reproducibly |
| 2026-05-05 (PR #179) | 28 | ~1700 | Stack detection, planning_complete, pr_target, architect doctrine migrated |
| 2026-05-05 (PR #181) | 23 | ~1700 | 5 skills deleted (`naming-conventions`, `git-conventions`, `create-hook`, `lazy-regen-check`, `roundtable-cleanup`); 9 skills shrunk to judgment-only; 3 new MCP composites (`branch_id_propose`, `task_retry_batch`, `bro_atomic_close`); 8 new hooks (`naming-lint`, `commit-msg-lint`, `code-quality-lint`, `session-start-prescan`, `consultant-spawn-required`, `greenfield-arch-required`, `lazy-regen-postcheck`, `roundtable-cleanup-postcheck`). |
| 2026-05-05 (PR #181, consolidation) | 10 | 1263 | 13 skills merged into 3 (`tmb_planning` absorbs 7 bro-flow skills; `tmb_review` absorbs 3 review-surface skills; `tmb_recovery` absorbs 3 failure-mode skills). `tmb_code-quality` + `tmb_review-findings` reference content moved to `docs/contributing/`. |
| 2026-05-05 (PR #181, slash-command + Anthropic split) | 8 | 803 (trigger) / 813 (on-demand) | `tmb_roundtable` → `commands/roundtable.md`, `tmb_reonboard` → `commands/onboard.md` (Human-triggered → slash command). Remaining skills adopt Anthropic SKILL.md + reference.md + forms.md + scripts/ pattern: trigger surface (803 lines, loads on every match) is separated from on-demand reference (813 lines, loads when SKILL.md cross-refs it). `docs/contributing/{CODE_QUALITY,REVIEW_FINDINGS,CREATOR_GUIDE}.md` reabsorbed back into the owning skill's `reference.md` (orphan-doc bug fix). Bundled scripts: `tmb_recovery/scripts/bro-sqlite-readonly.sh`, `tmb_*-creator/scripts/prompt-author-lint.sh`. |
| 2026-05-05 (PR #181, flat-skill revert) | 8 | 974 (flat) | Anthropic-style split reverted: companion files (`reference.md`, `forms.md`) folded back into a single flat `SKILL.md` per skill. In headless L5 runs bro was burning ~150s/180s reading companion files via Read+Grep before producing any output, leaving no budget for the actual task — collapsing back to one file restored speed. Skill *count* (8) and bundled scripts unchanged. Per-file totals: `tmb_planning` 282, `tmb_review` 219, `tmb_agent-creator` 132, `tmb_recovery` 109, `tmb_skill-creator` 102, `tmb_docs-conventions` 53, `tmb_concerns-protocol` 50, `tmb_swe-checklist` 27. |

The skill *count* doesn't drop drastically — judgment skills survive. The *line count* drops because each skill becomes a thin caller of deterministic infrastructure, not a re-implementation of it.

---

## Authoring checklist (apply when adding or editing any skill)

Before merging a skill change, verify each procedural sentence answers **yes** to at least one:

- [ ] This sentence describes a *judgment* the LLM must make on novel input
- [ ] The LLM dropping this sentence cannot break the workflow (some other layer enforces)
- [ ] No deterministic mechanism (1–6) can encode this constraint

If any procedural sentence answers **no** to all three, file a follow-up issue to migrate it to the appropriate mechanism. Don't ship the skill prose as the safety net.

---

## See also

- `plugin/docs/architecture/RESPONSIBILITIES.md` — agent layer model + role boundaries
- `plugin/docs/architecture/ENFORCEMENT.md` — hook + MCP enforcement matrix
- `plugin/docs/architecture/UI.md` — interactive UI primitives (AskUserQuestion modes)
- `plugin/docs/AGENTS.md` — agent file conventions
