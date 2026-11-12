# Enforcement layers

How TMB doctrine is enforced at runtime — what is structurally guaranteed by code, what depends on prompt discipline, which layer covers which interaction — and how to decide where a new rule belongs.

> **If a step could fail because the LLM forgot, misordered, or misunderstood it, that step does not belong in a prompt. It belongs in a deterministic layer.**

Skills, CLAUDE.md, and agent files are reserved for the irreducibly judgment-bound parts of the workflow. Everything else sits on one of the harder layers below.

## The 6 layers (hardest → softest)

| # | Layer | What it is for | What it guarantees |
|---|---|---|---|
| 1 | **MCP server** | Role-bound tool access, input validation, server-side defaults for omitted args, and atomic composite tools that run a multi-step workflow as one call in one DB transaction. | Wire-level rejection (`is_error: true`) regardless of prompt content; a composite's steps land together or not at all. |
| 2 | **Hooks** | Gates fired by the host on lifecycle events: PreToolUse blocks a call until its prerequisite holds; PostToolUse emits follow-up side effects; SessionStart and UserPromptSubmit inject context. | A block or side effect runs outside the LLM's context and cannot be skipped. Injected context is advisory: it reaches the model but compliance stays at layer 6. |
| 3 | **Frontmatter** | `tools:`, `disallowedTools:`, `isolation:` in agent `.md` files. | Host-enforced at spawn. |
| 4 | **Schema constraints** | `CHECK`, `UNIQUE`, `NOT NULL`, FK on the trajectory DB. | Rejects malformed writes at the storage layer, including raw-SQL bypasses of MCP handlers. |
| 5 | **Skill `paths:`** | Skill auto-loads when matching files are in the active context. | Soft — reduces prompt noise; the model can still ignore loaded content. |
| 6 | **Prompts** | CLAUDE.md, agent prompts, skill prose. | None — accept the compliance ceiling. |

**Doctrine: prefer the hardest layer that fits.** Layer 6 is the fallback, not the default. Promote a constraint up the stack as soon as the soft layer below misses it.

The layers stack: a rule a prompt states should also be caught by a harder layer, so a dropped prompt line fails loudly (a block, a rejection) instead of silently. Layers 1 and 4 hold in every host configuration; layer 2 depends on the host firing the plugin's hooks.

Source of truth for each layer's implementation: hooks under `mcp/trajectory-server/src/hooks/` (registered in `registry.ts`), MCP tools and middleware under `mcp/trajectory-server/src/`, constraints in `mcp/trajectory-server/src/schema.sql`, plugin settings in [`CONFIG_KEYS.md`](../reference/CONFIG_KEYS.md).

## What stays in layer 6

Recognizable by the verb. **Anything that is *classifying*, *composing*, or *weighing novel context*.**

| Verb class | TMB examples |
|---|---|
| **Classify / decide** | "Is this an architectural change?" "Is this scope creep?" |
| **Draft / compose** | Spec body, commit messages, issue descriptions, Q+A wording, discussion notes |
| **Weigh / trade off** | "Should I raise this concern with the human?" "Is the simpler alternative acceptable?" "Should the scope split into multiple tasks?" |
| **Synthesize from novel context** | Roundtable participant arguments, code review qualitative assessment, consultant-style analysis |
| **Recognize patterns in unfamiliar input** | "Does this diff match the spec?" "Is this a regression in the diff?" |

These have no deterministic substitute: the criteria require contextual judgment over an open-ended input space.

## What migrates out of layer 6

Recognizable by mechanism. **Anything that is *sequencing*, *defaulting*, *constraining*, or *measuring* against a stable specification.**

| Pattern in prompt prose | Migrates to |
|---|---|
| "Then call X with Y" (multi-step) | Layer 1 atomic composite |
| "If config has X, use it; otherwise default Y" | Layer 1 server-side default |
| "Tool X is forbidden for role Y" | Layer 1 role check |
| "Validate input matches schema" | Layer 1 input validation, or a layer 4 constraint |
| "Probe the environment for X, Y, Z" | Layer 1 tool that runs deterministic code |
| "Don't proceed until Z has happened" | Layer 2 PreToolUse block |
| "After A, also do B" | Layer 2 PostToolUse side effect |
| "Enforce file naming / commit format" | Layer 2 lint hook |

## The boundary test (apply this to any prompt line)

For every numbered step or imperative in a skill, agent file, or CLAUDE.md:

1. **Strike the verb.** Is what remains a *fact about the world* (file exists, role has access, value is X)? → migrate. Is it a *judgment* (is this good, what should I write)? → keep.
2. **Imagine the LLM dropping this line.** Does the workflow break in a deterministic way (test fails, hook blocks, server rejects)? If not, determinism is missing — build the safety net so the prose isn't the safety net.
3. **Count the steps.** Multi-step workflows have compound failure: at per-step adherence p, an N-step procedure succeeds with probability pᴺ.

| N (steps) | P(success) at p=0.95 | P(success) at p=0.90 |
|---:|---:|---:|
| 1 | 95% | 90% |
| 3 | 86% | 73% |
| 5 | 77% | 59% |
| 7 | 70% | 48% |

A composite collapses N → 1: one call decision, deterministic execution.

## Coverage matrix

The "Layer" column names the **strongest currently deployed** layer for each interaction. `6 only` means prompt-only — relies on LLM compliance. Which file implements a row lives in the sources named above.

### bro

| Interaction | Layer |
|---|---|
| Activation routine (onboarded marker + pending issue injection) | 2 |
| Bro never edits source code (every code change → SWE) | 2 |
| Project `.gitignore` excludes `.claude/` | 2 |
| Bro creates the task branch (SWE may not invent, abbreviate, or detach) | 2 |
| Branch up to date with the remote target branch before SWE attach | 2 |
| Worktree cleanup on task close | 2 |
| `task_create_batch` blocked until `/scan` has run (world-model-cold gate) | 1 |
| Decision-audit row required on every `task_create_batch` | 1 |
| MCP calls include `agent: 'bro'` | 1 |
| `validation_record` requires `subagent_session_id` | 1 |
| `discussion_append(author='human')` is refused; an agent quotes the Human under its own name | 1 |
| AUQ shape during roundtable `awaiting_human` | 2 |
| Roundtable state machine | 1 |
| Issue-sync default-off + env-var kill-switch | 1 |
| Architectural-intent and consultant routing hints | 2 (injection) |
| Welcome banner phrasing, verify-context before answering, voice | 6 only |

### SWE

| Interaction | Layer |
|---|---|
| Spawned only with a valid `task_id` whose spec is non-empty and names a writer for each new schema item | 2 |
| Runs in an isolated worktree created at the canonical path at spawn | 2 |
| Task moved to `running` and its run row opened at spawn | 2 |
| Cannot create branches (attaches to bro's pre-created branch) | 2 |
| Worktree branch descends from the remote target branch | 2 |
| Scope-limited tools keep SWE off bro-only MCP writes | 1 + 3 |
| MCP calls include `agent: 'swe'`, scope-restricted | 1 |
| Never writes its own `validation_record` | 1 |
| Close runs the task's typed `verification[]` commands; denies on any failure | 2 |
| Edits stay inside the task's `files[]` | 2 (advisory note) + 1 (close-time scope check) |

### code-reviewer

| Interaction | Layer |
|---|---|
| Push to a protected branch blocked unless every unsigned commit has a passing validation row | 2 |
| MCP calls include `agent: 'code-reviewer'`, scope-restricted | 1 |
| `validation_record` is code-reviewer-only | 1 |
| Cannot edit code (read-only review) | 3 |
| Review output format | 6 only |

### Consultants

| Interaction | Layer |
|---|---|
| Cannot write workflow state (task_*, validation_record, issue_*) | 1 |
| Spawned only by bro, never by the Human directly | 6 only |
| Return analyses, never decisions | 6 only |

### Universal

| Interaction | Layer |
|---|---|
| Force-push and direct commits to protected branches blocked | 2 |
| Remote-write text citing a local issue id whose remote id differs blocked | 2 |
| Issue a merged PR resolved auto-closed on a successful merge | 2 (side effect) |
| Naming conventions, conventional-commit subjects, mechanical code-quality patterns | 2 |
| bro's persona injected in every session | 2 |
| Project inventory at session start | 2 |
| Roundtable capture-surface verification on close | 2 |
| Task close, SWE retry, and `branch_id` derivation as atomic composites | 1 |

## How to add a new enforcement

1. Identify the failure mode. What's the bad thing if the LLM doesn't comply?
2. Pick the hardest layer that fits (table at top).
3. Implement it in that layer's source (see above) with a test; a layer 4 change to an existing table also needs its migration.
4. If the guard covers version-control commands, match git, gh and glab at a command boundary — so `gh pr merge` and `glab mr merge` are both caught, while a match inside a quoted string or a longer word is not — and add a test case for each CLI.
5. Hooks that compare role names normalize them first: the host passes roles with or without a `<plugin>:` prefix, and a hook that silently skips a prefixed role is a disabled safety gate.
6. Update the coverage matrix. A layer 6 row notes that it may need promotion.
7. **If demoting from a harder layer to a softer one, justify in the PR.**

## Positive prompts as the floor

Layer 6 is the floor of the stack. State the action you want when a positive form exists. Keep a prohibition only when it is the clearest statement of a hard limit, pair it with what to do instead, and avoid naming a word or topic only to forbid it. If the constraint is load-bearing, promote it to a deterministic layer instead of bracing the prompt.

The evidence on negative instructions is mixed, and no controlled study supports a blanket ban on frontier models. The negation rule in [`PROMPT_ENGINEERING.md`](PROMPT_ENGINEERING.md) gives the sources.

## Grading a prompt surface

### The six tests

| Test | Pass condition |
|---|---|
| **(A) Mechanism test** | Sequencing, defaulting, constraining, or measuring migrates to layers 1–5. Only judgment stays. |
| **(B) If/else test** | Anything you can write as an if/else statement lives in hooks/MCP, never in prompt prose. |
| **(C) Natural-language test** | If the Human cannot read a prompt line as natural language, it is machine-spec in disguise — migrate it or rewrite it. |
| **(D) Placement test** | 100%-required judgment belongs in the always-loaded body; optional judgment in trigger-loaded skills; deterministic logic in code. |
| **(E) Persona test** | Every agent opens with a plain-language identity sentence ("You are a senior software engineer. You execute tasks assigned by bro."). |
| **(F) Load-bearing test** | Every line drives a judgment, names a call, or states a constraint the reader acts on. No line sells the concept, narrates the skill's own purpose, restates the frontmatter, or repeats a point for emphasis. |

### Every line earns its place

A prompt is not documentation. It loads into the agent's context every time its trigger fires, so every line is a recurring tax. Four exposition patterns, cut on sight:

- **Concept-selling** — persuading the agent a skill is worth using after it already loaded it.
- **Self-narration** — a skill describing what kind of skill it is. Do the thing; don't annotate its shape.
- **Frontmatter restatement** — the body re-explaining the when/why already in the `description`.
- **Rhetorical repetition** — one point stretched across three sentences for emphasis.

### Line disposition

| What the line does | Action |
|---|---|
| Encodeable as if/else AND enforced by a gate | **DELETE** — the gate already guarantees the behavior. |
| Encodeable as if/else, NOT yet enforced | **KEEP** as readable prose, rewrite naturally, file a migration issue. |
| Required judgment (100% of runs) | **BODY** — move to the always-loaded agent file. |
| Optional/situational judgment | **SKILL** — trigger-loaded, not burned on every turn. |
| Explains, motivates, or restates rather than directing | **DELETE** — exposition, not judgment. |

### A–F rubric

| Grade | What it means |
|---|---|
| **A** | Every line passes all six tests. |
| **B** | Compliant architecture, but carries residual machine-spec, exposition, or minor duplication. |
| **C** | Procedures wearing a prompt costume — readable but enforceable; or so padded with exposition the judgment core is buried. |
| **D** | Prompt is doing enforcement's job for at least one workflow step. |
| **F** | Agent can act against policy before any gate fires. |

### The gate-strength principle

**A prompt line is only deletable when its gate actually guarantees the behavior — grade the system, not the prose.** If deleting a line would let an agent act before any gate catches it, strengthen the gate first, then delete the line. Gates teach their recovery in the deny message.

### Size discipline

A skill over about 200 lines is a signal it is doing too much. In order: apply the boundary test and migrate what it flags; move judgment used on every run into the agent body and keep situational judgment in the skill; split into several skills only when neither suffices. Measure density, not just length.

## Core prompts stay minimal; depth is a cheatcode

Each shipped prompt (`CLAUDE.md`, an agent, a skill) carries the wiring that makes TMB work: who the agent is, what it does every turn, and pointers to the skills and commands that hold procedures. Rubrics, checklists, persona and style guidance, and domain heuristics arrive as cheatcodes ([`CHEATCODES.md`](../architecture/CHEATCODES.md)); a paragraph that teaches a technique instead of wiring a role belongs in one.

## Prompts fit their quality layer

Each prompt fits its agent's place in [`FLOWS.md`](../architecture/FLOWS.md) and its row of the Quality layers table. It asks only for the checks that layer owns, hands over that layer's stated contract, and never asks the agent to redo a check another layer owns: overlapping layers duplicate work and blur who owns a leak. Where the flow and a prompt disagree, fix one of them in the same change so they do not drift.

## Prompt cache zones

Claude Code's prompt cache matches from the start of the assembled prompt and stops at the first byte that differs. TMB orders its context in three zones so the stable prefix stays as long as possible:

| Zone | Content | Stability |
|------|---------|-----------|
| **A — stable identity** | Plugin persona (`CLAUDE.md`), MCP tool descriptions, fixed across all sessions and users | Stable |
| **B — semi-stable bodies** | Skill bodies and rule files, which change only on plugin upgrades | Semi-stable |
| **C — volatile hook tails** | Hook-injected context (counts, banners, branch, last commits), which changes every session or turn | Volatile |

**Contract for hook authors:** a hook that injects `additionalContext` puts its stable descriptive text first and its volatile fields at the tail of its own output, because a hook that opens with a volatile line breaks the cache for everything after it. Volatile fields include the branch name, commit and dirty-path counts, open-issue and pending-task counts, recent commit messages, the DB and plugin paths, and any timestamp or PID.

An L3 hook test checks this order for the activation-routine hook only; the other hooks are held to it by review.

## See also

- [`PROMPT_ENGINEERING.md`](PROMPT_ENGINEERING.md) — how we author personas, skills, and commands.
- [`RESPONSIBILITIES.md`](../architecture/RESPONSIBILITIES.md) — agent roles and boundaries.
- [`FLOWS.md`](../architecture/FLOWS.md) — workflows: who acts, what each step guarantees, and the state each flow leaves.
- [`ERD.md`](../architecture/ERD.md) — schema.
- [`agent-scope.ts`](../../mcp/trajectory-server/src/middleware/agent-scope.ts) — defines the `requireRoles` check behind layer 1; each tool's allowed roles are set at its `requireRoles(...)` call in [`tools/*.ts`](../../mcp/trajectory-server/src/tools/).
