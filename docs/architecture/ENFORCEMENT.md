# Enforcement layers

How TMB doctrine is enforced at runtime — what is structurally guaranteed by code, what depends on prompt discipline, and which mechanism covers which interaction.

> **Why this doc matters.** The h3 + h4 A/B scenarios proved that prompt-only doctrine has a hard compliance ceiling (0/10 in both wording arms for the activation routine, 0/5 in both for Direct Mode). Anything load-bearing should sit on a hard layer; soft prompts are for judgment, style, and rare-fire instructions.

## The 6 layers (hardest → softest)

| # | Layer | Mechanism | LLM-bypassable? | Cost to add |
|---|---|---|---|---|
| **1** | **MCP server middleware** | `requireRoles` in `mcp/trajectory-server/src/middleware/agent-scope.ts` rejects MCP calls violating role/scope at the wire | **No** — server-side, returns `is_error: true` | TS handler addition |
| **2** | **Hooks** | Shell scripts under `scripts/hooks/` fired by CC on lifecycle events (Pre/PostToolUse, UserPromptSubmit, SessionStart, Stop, WorktreeCreate, …); can `permissionDecision: deny` or inject `additionalContext` | **No** — runs outside the LLM's context | New `.sh` + `hooks.json` entry |
| **3** | **Frontmatter directives** | `disallowedTools`, `isolation: worktree`, `memory: false` in agent `.md` files; CC enforces structurally for subagents | **No** — host-enforced at spawn | YAML edit |
| **4** | **Tool-handler validation** | The MCP tool handler itself rejects malformed input (e.g. `task_create_batch` requires non-empty body, `requireRoles` wrappers) | **No** — handler returns error result | TS handler change |
| **5** | **Skill `paths:` auto-load** | Skill auto-loads when matching files are in the active context; reduces prompt noise | Soft — model can ignore the loaded skill | `paths:` in skill frontmatter |
| **6** | **Prompts** | CLAUDE.md, agent prompts, skill SKILL.md prose | **Yes** — h3/h4 ceiling | Markdown edit |

**Doctrine: prefer the hardest layer that fits.** When designing a new constraint:

1. Can the MCP server reject the call? → Layer 1.
2. Can a hook block / inject deterministically? → Layer 2.
3. Can the agent file's frontmatter close the door for subagents? → Layer 3.
4. Can the tool handler validate? → Layer 4.
5. Can a skill load only when relevant? → Layer 5.
6. Otherwise: prompt it. → Layer 6 (and accept the compliance ceiling).

## Coverage matrix — agent × interaction × enforcement

The "enforcement" column names the **strongest layer currently deployed** for each interaction. `Layer 6 only` means "prompt-only — relies on LLM compliance and may need promotion to a harder layer if it fails to fire reliably."

### bro

| Interaction | Enforcement | Where |
|---|---|---|
| Activation routine (`identity_get + issue_resume` data flow on every triggered message) | Layer 2 (UserPromptSubmit hook) | `scripts/hooks/activation-routine.sh` |
| Bro never edits source code directly (every code change goes through SWE) | Layer 2 (PreToolUse hook on Edit/Write/MultiEdit/NotebookEdit) | `scripts/hooks/no-source-edit-from-main.sh` |
| Architecture-doc regen lazy nudge | Layer 2 (SessionStart hook) | `scripts/hooks/session-start-regen-check.sh` |
| Project `.gitignore` excludes `.claude/` (so trajectory.db doesn't get committed and leak into worktrees, #171) | Layer 2 (SessionStart hook) | `scripts/hooks/ensure-gitignore.sh` |
| Bro creates the task branch (SWE may not invent / abbreviate the name, #170) | Layer 2 (PreToolUse hook on Bash blocking `git worktree add -b/-B/--create-branch`) | `scripts/hooks/no-worktree-branch-create.sh` |
| Branch is up-to-date with `origin/<pr_target>` before SWE attaches a worktree (no stale-local-main bug) | Layer 2 (PreToolUse hook on Bash, fetch + ancestry check) | `scripts/hooks/branch-up-to-date-with-remote.sh` |
| Worktree cleanup on task close (no stale `.claude/worktrees/` accumulation) | Layer 2 (PostToolUse hook on `task_update_status`) | `scripts/hooks/cleanup-worktree-on-task-close.sh` |
| **Bro must update file_registry summaries before closing the task** (#181 — bro has full task context, SWE doesn't) | Layer 1 (`requireRoles('file_registry_update_summaries', ['bro'])`) + Layer 2 (PreToolUse hook denies `task_update_status(closed)` when summaries are missing/stale) | `mcp/trajectory-server/src/tools/file-registry.ts` + `scripts/hooks/require-summaries-before-task-close.sh` |
| MCP calls must include `agent: 'bro'` | Layer 1 (server `requireRoles`) | `mcp/trajectory-server/src/middleware/agent-scope.ts` |
| `validation_record(agent='pr-reviewer')` requires `subagent_session_id` (#144) | Layer 1 (tool handler rejects missing `subagent_session_id` when agent='pr-reviewer') | `mcp/trajectory-server/src/tools/validation.ts` |
| `discussion_append(author='human')` requires `verified_human=true` (#145) | Layer 1 (tool handler rejects human-authored appends without the gate flag) | `mcp/trajectory-server/src/tools/discussions.ts` |
| AUQ shape during roundtable `awaiting_human` (#141) | Layer 2 (PreToolUse hook validates checkbox/radio structure before AUQ renders) | `scripts/hooks/roundtable-auq-shape.sh` |
| Issue-sync default-off + env-var kill-switch (#146) | Layer 1 (config default `issue_sync='off'` in schema seed) + env override (`TMB_DISABLE_REMOTE_SYNC=1` short-circuits `resolveBackend()` before any CLI spawn) | `mcp/trajectory-server/src/schema.sql` + `mcp/trajectory-server/src/sync/backend.ts` |
| Roundtable state machine (#141) | Layer 1 (server rejects state-transition violations — e.g. `roundtable_vote` on a closed roundtable returns `is_error: true`) | `mcp/trajectory-server/src/tools/roundtable.ts` |
| Welcome banner phrasing | Layer 6 only | CLAUDE.md `## Welcome banner` |
| Triage rule (`difficult` iff `docs/trustmybot/architecture/` touched) | Layer 6 only | CLAUDE.md `## Code-touching ask chain` |
| Verify-context check before answering | Layer 6 only | CLAUDE.md `## Before answering — verify context` |
| Standards check before recommending | Layer 6 only | CLAUDE.md `## Before answering — verify context` |
| Catchphrase rule ("Trust me bro" only after pass) | Layer 6 only | CLAUDE.md `## Catchphrase` |
| Voice / tone | Layer 6 only | CLAUDE.md `## Voice` |
| `file_registry` md5 + last-seen update on Read | Layer 6 only — **candidate for Layer 2** (PostToolUse hook, deferred pending `last_verified_at` schema column) | `tmb_project-prescan` skill |

### swe

| Interaction | Enforcement | Where |
|---|---|---|
| Spawned only with valid `task_id` referencing a `pending`/`open` task with non-empty `spec_body` | Layer 2 (PreToolUse hook on Task) | `scripts/hooks/require-task-spec.sh` |
| Runs in an isolated worktree | Layer 3 (`isolation: worktree` frontmatter) + Layer 2 (PreToolUse Bash hooks: `no-worktree-branch-create.sh`, `branch-up-to-date-with-remote.sh`) | `agents/swe.md` + the two Bash hooks |
| **Cannot create branches** — must attach worktree to bro-pre-created `<branch>` (#170) | Layer 2 (PreToolUse hook on Bash) | `scripts/hooks/no-worktree-branch-create.sh` |
| **Cannot write file_registry summaries** — bro owns summaries (#181). SWE just commits + status='completed' | Layer 1 (`requireRoles('file_registry_update_summaries', ['bro'])`) | `mcp/trajectory-server/src/tools/file-registry.ts` |
| **Cannot attach worktree to a stale branch** — branch must descend from `origin/<pr_target>` | Layer 2 (PreToolUse hook on Bash, fetch + ancestry) | `scripts/hooks/branch-up-to-date-with-remote.sh` |
| `disallowedTools` keeps SWE off MCP-write tools intended for bro | Layer 3 (frontmatter) | `agents/swe.md` |
| MCP calls must include `agent: 'swe'`, scope-restricted | Layer 1 (`requireRoles`) | `mcp/trajectory-server/src/middleware/agent-scope.ts` |
| Atomic close (`task_update_status` on return, never self-validation_record) | Layer 1 (`requireRoles` rejects bro/swe writing pr-reviewer-only tools) | server middleware |
| Task spec compliance (only edits `Files` listed in spec) | Layer 6 only | `agents/swe.md` + `tmb_swe-spawn-workflow` skill |

### pr-reviewer

| Interaction | Enforcement | Where |
|---|---|---|
| Push to protected branch blocked unless every unsigned commit has a passing `validation_attempts` row | Layer 2 (PreToolUse hook on Bash, parses `git push`) | `scripts/hooks/git-push-guard.sh` |
| MCP calls must include `agent: 'pr-reviewer'`, scope-restricted | Layer 1 (`requireRoles`) | server middleware |
| `validation_record(verdict='pass')` is the only way past the push gate | Layer 1 + Layer 2 (server requires `agent='pr-reviewer'`; hook checks the row exists) | both |
| Can't edit code (read-only review) | Layer 3 (frontmatter `tools:` allowlist excludes Edit/Write) | `agents/pr-reviewer.md` |
| Review output format (`tmb_review-findings`) | Layer 6 only | skill |

### Consultants (`architect`, `cto`, `ceo`, `pm`, project-local custom)

| Interaction | Enforcement | Where |
|---|---|---|
| Cannot write workflow state (`task_create_batch`, `validation_record`, `task_update_status`, `issue_create`) | Layer 1 (`requireRoles` rejects non-bro/non-pr-reviewer callers) | server middleware |
| Spawned only by bro, never by Human directly | Layer 6 only (CLAUDE.md routing rule) | CLAUDE.md `## Routing` |
| Return analyses, never decisions | Layer 6 only | consultant agent prompts |

### git operations (universal)

| Interaction | Enforcement | Where |
|---|---|---|
| Force-push to protected branches blocked | Layer 2 (PreToolUse hook on Bash) | `scripts/hooks/git-guards.sh` |
| Direct commits to `dev`/`main` from outside dev→main PR flow blocked | Layer 2 | `scripts/hooks/git-guards.sh` |
| Worktree branch creation safety | Layer 2 (PreToolUse Bash hooks) | `scripts/hooks/no-worktree-branch-create.sh`, `scripts/hooks/branch-up-to-date-with-remote.sh` |
| Push gate (see pr-reviewer section) | Layer 2 | `scripts/hooks/git-push-guard.sh` |
| Naming conventions (file/identifier kebab/snake/Pascal per language) | Layer 2 (PreToolUse on Edit/Write/MultiEdit) | `scripts/hooks/naming-lint.sh` |
| Conventional-commit subject format (`<emoji> <type>(<scope>): <subject>`) | Layer 2 (PreToolUse on Bash, intercepts `git commit -m`) | `scripts/hooks/commit-msg-lint.sh` |
| Mechanical code-quality patterns (bare except, mutable defaults, missing timeout, f-string SQL, etc.) | Layer 2 (PreToolUse on Edit/Write/MultiEdit) | `scripts/hooks/code-quality-lint.sh` |
| Project inventory at session start (git state, stacks, registry warmth) | Layer 2 (SessionStart hook) | `scripts/hooks/session-start-prescan.sh` |
| Greenfield project must run architecture_regen before task_create_batch | Layer 2 (PreToolUse on `mcp__*task_create_batch`) | `scripts/hooks/greenfield-arch-required.sh` |
| Domain-expert prompt → suggest spawning a consultant | Layer 5 (UserPromptSubmit injection) | `scripts/hooks/consultant-spawn-required.sh` |
| Lazy-regen drift warning after `file_registry_update_summaries` | Layer 2 (PostToolUse) | `scripts/hooks/lazy-regen-postcheck.sh` |
| Roundtable capture-surface verification on `roundtable_close` | Layer 2 (PostToolUse) | `scripts/hooks/roundtable-cleanup-postcheck.sh` |
| Bro task-close atomic invariants (audit + summaries + status + issue close in one txn) | Layer 4 (MCP composite) | `mcp/.../tools/composites.ts:bro_atomic_close` |
| SWE retry composite (rationale + new task + audit in one txn) | Layer 4 (MCP composite) | `mcp/.../tools/composites.ts:task_retry_batch` |
| branch_id derivation from intent (heuristic) | Layer 4 (MCP composite) | `mcp/.../tools/composites.ts:branch_id_propose` |

## Open Layer-6-only items — promotion candidates

These currently rely on prompt discipline. Each is a candidate for promotion to a harder layer. **Cost of leaving on Layer 6**: the same compliance ceiling that h3/h4 demonstrated (0% reliability for high-frequency operations).

| Item | Possible promotion | Notes |
|---|---|---|
| `file_registry` md5 + last-seen update on Read | Layer 2 (PostToolUse on Read → direct sqlite3 update of `content_md5`, `last_verified_at`) | Needs schema migration to add `last_verified_at` column. Filed as follow-up. |
| Catchphrase audit ("Trust me bro" without passing validation) | Layer 2 (Stop hook → grep transcript + check `validation_attempts`, write a soft warning row) | Needs a no-FK table to write warnings into; can use `debug_trajectory` or add `bro_warnings` table. Low priority (style enforcement). |
| Triage rule (`simple` triage that ends up writing arch docs) | Layer 2 (PostToolUse on Edit → if path matches `docs/trustmybot/architecture/` and current task is `simple`-triaged, flag inconsistency) | Detection only, not blocking. |
| Welcome banner mandatory | Layer 2 (Stop hook → check first response after `Entering bro mode.` contained banner pattern; inject correction next turn) | Banner phrasing is conversational; only the *presence* of a banner can be enforced. |
| Standards check / verify-context check / triage decision | Stays Layer 6 | Pure judgment — can't be deterministically encoded. |

## How to add a new enforcement

1. **Identify the failure mode.** What's the bad thing that happens if the LLM doesn't comply?
2. **Pick the strongest layer that fits** (table at top of this doc).
3. **Implement**:
   - Layer 1: add a `requireRoles` wrapper in the relevant tool handler; add MCP-integration test.
   - Layer 2: write the hook script under `scripts/hooks/`, register it in `hooks/hooks.json`, add `tests/hooks/<name>.test.sh`.
   - Layer 3: edit the agent's `.md` frontmatter; verify with subagent spawn.
   - Layer 4: tighten the tool handler's input validation; add unit test.
   - Layer 5: add `paths:` to the skill's SKILL.md frontmatter.
   - Layer 6: edit CLAUDE.md / agent prompt / SKILL.md prose; **note explicitly in this doc that the item is Layer-6-only and may need promotion**.
4. **Update this matrix** with the new row.
5. **If demoting from a harder layer to a softer one (e.g. removing a hook), justify in the PR**: what changed about the failure mode that makes the softer layer acceptable?

## Promotion path: positive prompts as the floor (#21)

Layer 6 (positive prompt) is the floor of TMB's enforcement stack. Negative directives (`don't X`, `never Y`) are anti-pattern: they force the model to first process the forbidden concept (Pink Elephant Problem).

When a behavior matters, promote it to a deterministic layer:
- **Layer 1** (lint): static check before commit
- **Layer 2** (hook): runtime gate at tool-use time
- **Layer 3** (MCP server): server-side validation with `requireRoles` / state machines
- **Layer 4** (schema): DB CHECK constraints
- **Layer 5** (CC native): permissions, sandbox, role enforcement
- **Layer 6** (prompt): positive directives as the soft floor

Research basis: pink elephant problem (arxiv 2503.22395), NeQA inverse scaling (Jang 2023, MLR), compliance gap analysis (Gadlet 2026).

## See also

- [`FLOWS.md`](FLOWS.md) — workflow flowcharts; cross-references which hook fires when in each flow.
- [`FILES.md`](FILES.md) — file-by-file map of `scripts/hooks/`, `hooks/hooks.json`, the MCP middleware.
- [`ERD.md`](ERD.md) — schema; the role-by-tool matrix at the bottom is the source of truth for Layer 1's coverage.
