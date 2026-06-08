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
| **Classify / decide** | "Is this an architectural change that warrants an ADR?" "Is this scope creep?" "Is this an emergent ADR or routine task?" |
| **Draft / compose** | Spec body, ADR prose, commit messages, issue descriptions, Q+A wording, discussion notes |
| **Weigh / trade off** | "Should I raise this concern with the human?" "Is the simpler alternative acceptable?" "Should the scope split into multiple tasks?" |
| **Synthesize from novel context** | Roundtable participant arguments, code review qualitative assessment, consultant-style analysis |
| **Recognize patterns in unfamiliar input** | Codebase memory verify, "does this diff match the spec?", "is this a regression in the diff?" |

These have no deterministic substitute. Code cannot classify "is this architectural" universally because the criteria require contextual judgment over an open-ended input space.

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
| "Probe the environment for X, Y, Z" | MCP composite tool that forks a deterministic shell script (cf. `scan_run` → `scripts/scan.sh`) |
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

## Authoring checklist (apply when adding or editing any skill)

Before merging a skill change, verify each procedural sentence answers **yes** to at least one:

- [ ] This sentence describes a *judgment* the LLM must make on novel input
- [ ] The LLM dropping this sentence cannot break the workflow (some other layer enforces)
- [ ] No deterministic mechanism (1–6) can encode this constraint

If any procedural sentence answers **no** to all three, file a follow-up issue to migrate it to the appropriate mechanism. Don't ship the skill prose as the safety net.

---

## Size discipline

A single skill SKILL.md should stay under **200 LOC**. The number is a soft ceiling on cognitive load, not a hard limit — but breaching it is a signal that the skill is doing too much. The doctrine's math (5-step procedural prose ≈ 77% adherence at p=0.95) compounds with size: longer skills carry more procedural sentences and more compound-failure surface.

When a skill exceeds 200 LOC, the standard moves are, in order:

1. **Apply the boundary test** to every procedural sentence. DETERMINISM-classified sentences migrate to mechanisms 1–6 (usually a composite or a hook). The body shrinks naturally.
2. **Split by Efficiency-of-JUDGMENT tier** if migration alone doesn't get under 200:
   - ~100% per-run usage → bake into the agent prompt body (CLAUDE.md or per-agent file)
   - <100% per-run usage → keep in a skill (loaded on description-match)
3. **Only split into multiple SKILL.md files when neither (1) nor (2) suffices.** Skill files are loaded as units; splitting fragments JUDGMENT context and increases the description-matching surface that bro has to navigate.

When in doubt, refactor toward fewer, smaller skills with sharper descriptions rather than more skills with overlapping triggers. Description-match drift is itself a token-burn vector.

---

## Role identifiers — strip the plugin prefix before comparing

CC passes role names with or without a `<plugin>:` prefix depending on context (project-local override vs global plugin agent vs slash-command vs direct invocation). Hooks that compare raw `subagent_type` / `tool_input.skill` / similar against bare role names ("swe", "pr-reviewer", "tmb_planning") silently skip on prefixed input. **Hooks that silently skip are safety gates being silently disabled.**

The canonical fix lives in `scripts/hooks/lib/normalize-role.sh` — source it and call `tmb_normalize_role` on any role-bearing string before comparison. The `tests/lint/no-bare-role-compare.sh` lint catches the bare-compare regression at L1.

---

## See also

- `plugin/docs/architecture/RESPONSIBILITIES.md` — agent layer model + role boundaries
- `plugin/docs/prompt-engineering/ENFORCEMENT.md` — hook + MCP enforcement matrix
- `plugin/docs/architecture/UI.md` — interactive UI primitives (AskUserQuestion modes)
- `plugin/docs/architecture/RESPONSIBILITIES.md` — agent layer model + role boundaries
