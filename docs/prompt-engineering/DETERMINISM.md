# Determinism vs. Judgment — Layering Rules

The architectural rule for every line of every skill, agent prompt, hook, and MCP tool in this plugin:

> **If a step could fail because the LLM forgot, misordered, or misunderstood it, that step does not belong in a prompt. It belongs in a deterministic layer.**

Skills, CLAUDE.md, and agent files are reserved for the irreducibly judgment-bound parts of the workflow. Everything else migrates to one of the deterministic layers below.

---

## The seven mechanisms (ordered by enforcement strength)

| # | Mechanism | What it does | Right shape for |
|---|---|---|---|
| 1 | **Server-side defaults** | LLM omits an arg; server fills it from policy state | Per-arg defaults: `parent_branch_id` ← `config('pr_target')`; `repo` ← the sole registered repo (single-repo fallback; see [`REPO_RESOLUTION.md`](../architecture/REPO_RESOLUTION.md)) |
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

This is why L5 reproduces "skipped step" failures. The skill says "do X, Y, Z" and at runtime the LLM does X, Y, drops Z. Not because it's broken — because that's the noise floor of long procedural prose.

Atomic composites collapse N → 1: one call decision, deterministic execution. Same pre-LLM 95% adherence applies, but only to one event. Empirically, migration of multi-step batches to composites raises L5 flow pass rate from ~60-77% to ~95% per flow.

---

## Authoring checklist (apply when adding or editing any skill)

Before merging a skill change, verify each procedural sentence answers **yes** to at least one:

- [ ] This sentence describes a *judgment* the LLM must make on novel input
- [ ] The LLM dropping this sentence cannot break the workflow (some other layer enforces)
- [ ] No deterministic mechanism (1–6) can encode this constraint
- [ ] This sentence directs an action — a judgment, a call, or a constraint — not exposition explaining why the skill exists or restating its description

If any procedural sentence answers **no** to all three, file a follow-up issue to migrate it to the appropriate mechanism. Don't ship the skill prose as the safety net.

---

## Size discipline

A single skill SKILL.md should stay under **200 LOC**. The number is a soft ceiling on cognitive load, not a hard limit — but breaching it is a signal that the skill is doing too much. The doctrine's math (5-step procedural prose ≈ 77% adherence at p=0.95) compounds with size: longer skills carry more procedural sentences and more compound-failure surface.

LOC under the ceiling is necessary, not sufficient. A 37-line skill that spends a third of its lines selling the concept or narrating itself fails the **(F) load-bearing** test as surely as a 250-line one breaches the size ceiling. Measure density, not just length.

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

The canonical fix lives in `scripts/hooks/lib/normalize-role.sh` — source it and call `tmb_normalize_role` on any role-bearing string before comparison. The `tests/l1-lint/no-bare-role-compare.sh` lint catches the bare-compare regression at L1.

---

## Grading doctrine — scoring a prompt surface

Use these six tests to grade every line in an agent file, skill, or CLAUDE.md.

### The six tests

| Test | Pass condition |
|---|---|
| **(A) Mechanism test** | Sequencing, defaulting, constraining, or measuring migrates to mechanisms 1–6. Only judgment stays. |
| **(B) If/else test** | Anything you can write as an if/else statement must live in hooks/MCP, never in prompt prose. |
| **(C) Natural-language test** | LLMs are built on natural language: if the Human cannot read a prompt line as natural language, it is machine-spec in disguise — migrate it or rewrite it. |
| **(D) Placement test** | 100%-required judgment belongs in the always-loaded body; optional judgment in trigger-loaded skills; deterministic logic in code. CLAUDE.md is the reference implementation. |
| **(E) Persona test** | Every agent opens with a plain-language identity sentence ("You are a senior software engineer. You execute tasks assigned by bro."). |
| **(F) Load-bearing test** | Every line drives a judgment, names a call, or states a constraint the reader acts on. No line sells the concept, narrates the skill's own purpose, restates the frontmatter, or repeats a point for emphasis. |

### Every line earns its place

A prompt is not documentation. It loads into the agent's context every time its trigger fires, so every line is a recurring tax — and a line that doesn't direct an action isn't paying for itself. Four exposition patterns, cut on sight:

- **Concept-selling** — "Sometimes the smart play is to stop grinding and grab a cheatcode… reaching for it beats reinventing it." The agent already loaded the skill; it doesn't need persuading the skill is worth using.
- **Self-narration** — "This skill carries the one call that has no deterministic substitute…" A skill describing what kind of skill it is is README voice. Do the thing; don't annotate its shape.
- **Frontmatter restatement** — the body re-explaining the when/why already in the `description`. Say it once, in the description.
- **Rhetorical repetition** — one point stretched across three sentences for emphasis. State it once, plainly.

Strike all four and what's left is the load-bearing skill: the judgments, the calls, the constraints. If that's most of what was there, the prompt was already concise. If it's a fraction, it was a README.

### Four-way line disposition

| What the line does | Action |
|---|---|
| Encodeable as if/else AND enforced by a gate | **DELETE** — the gate already guarantees the behavior. |
| Encodeable as if/else, NOT yet enforced | **KEEP** as readable prose, rewrite naturally, file a migration issue. |
| Required judgment (100% of runs) | **BODY** — move to the always-loaded agent file. |
| Optional/situational judgment | **SKILL** — trigger-loaded, not burned on every turn. |
| Explains, motivates, or restates rather than directing (README-voice) | **DELETE** — exposition, not judgment. The reader loaded the skill; it doesn't need selling. |

### A–F rubric

| Grade | What it means |
|---|---|
| **A** | Every line passes all six tests. Each line drives a judgment, names a call, or states a constraint — no machine-spec, no exposition, no duplication. |
| **B** | Compliant architecture, but carries residual machine-spec, exposition (concept-selling / self-narration / frontmatter restatement), or minor duplication. A README wearing a skill's frontmatter lands here. |
| **C** | Procedures wearing a prompt costume — readable but enforceable; or so padded with exposition the judgment core is buried. |
| **D** | Prompt is doing enforcement's job for at least one workflow step. |
| **F** | Agent can act against policy before any gate fires. |

### The gate-strength principle

**A prompt line is only deletable when its gate actually guarantees the behavior — grade the system, not the prose.**

If deleting a line would let an agent act before any gate catches it, the gate is too weak. Strengthen the gate first, then delete the line. Prompts must never be the load-bearing patch for a weak gate, and gates must teach their recovery in the deny message.

### Worked example

The swe.md file once carried a "load task_brief before proceeding" instruction. The gate at the time blocked only trajectory-server MCP calls, so an SWE could Read and Edit files before calling task_brief — implementing blind. The prompt line was load-bearing because the gate was weak. Fix: extend the gate to also deny Edit/Write pre-brief (with recovery instruction in the deny message). Once the gate guarantees the behavior, the prompt line becomes redundant and is deletable.

---

## See also

- `plugin/docs/architecture/RESPONSIBILITIES.md` — agent layer model + role boundaries
- `plugin/docs/prompt-engineering/ENFORCEMENT.md` — hook + MCP enforcement matrix
- `plugin/docs/architecture/UI.md` — interactive UI primitives (AskUserQuestion modes)
- `plugin/docs/architecture/RESPONSIBILITIES.md` — agent layer model + role boundaries
