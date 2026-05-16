# Enforcement layers

How TMB doctrine is enforced at runtime — what is structurally guaranteed by code, what depends on prompt discipline, which mechanism covers which interaction.

> **Why this doc matters.** A/B scenarios proved that prompt-only doctrine has a hard compliance ceiling (0/10 in both wording arms for the activation routine). Anything load-bearing should sit on a hard layer; soft prompts are for judgment, style, and rare-fire instructions.

## The 6 layers (hardest → softest)

| # | Layer | Mechanism | LLM-bypassable? |
|---|---|---|---|
| 1 | **MCP server** | `requireRoles` middleware + tool-handler validation + DB CHECK constraints. Server returns `is_error: true` on violation regardless of prompt content. | No — wire-level rejection. |
| 2 | **Hooks** | Shell scripts under `scripts/hooks/` fired by CC on lifecycle events (Pre/PostToolUse, UserPromptSubmit, SessionStart, SubagentStop, WorktreeCreate). Can `permissionDecision: deny` or inject `additionalContext`. | No — runs outside the LLM's context. |
| 3 | **Frontmatter** | `tools:`, `disallowedTools:`, `isolation: worktree` in agent `.md` files. CC enforces structurally at spawn. | No — host-enforced. |
| 4 | **Schema CHECK** | DB constraints (`CHECK`, `UNIQUE`, `NOT NULL`, FK). Reject malformed writes including raw-SQL bypasses of MCP handlers. | No — bypass-proof at the storage layer. |
| 5 | **Skill `paths:`** | Skill auto-loads when matching files are in the active context; reduces prompt noise. | Soft — model can still ignore loaded content. |
| 6 | **Prompts** | CLAUDE.md, agent prompts, skill SKILL.md prose. | Yes — accept the compliance ceiling. |

**Doctrine: prefer the hardest layer that fits.** Promote a constraint up the stack as soon as the soft layer below misses it.

## Coverage matrix

The "Layer" column names the **strongest currently deployed** for each interaction. `Layer 6 only` means prompt-only — relies on LLM compliance.

### bro

| Interaction | Layer | Where |
|---|---|---|
| Activation routine (onboarded marker + pending issue injection) | 2 | `scripts/hooks/activation-routine.sh` |
| Auto-fire `/onboard` on first contact | 2 | hook-injected `additionalContext` directs bro |
| Bro never edits source code (every code change → SWE) | 2 | `scripts/hooks/no-source-edit-from-main.sh` |
| Project `.gitignore` excludes `.claude/` | 2 | `scripts/hooks/ensure-gitignore.sh` |
| Bro creates the task branch (SWE may not invent / abbreviate) | 2 | `scripts/hooks/no-worktree-branch-create.sh` (also blocks `--detach`) |
| Branch up-to-date with `origin/<pr_target>` before SWE attach | 2 | `scripts/hooks/branch-up-to-date-with-remote.sh` |
| Worktree cleanup on task close | 2 | `scripts/hooks/cleanup-worktree-on-task-close.sh` |
| Bro updates `file_registry` summaries before closing the task | 1 + 2 | `requireRoles('file_registry_update_summaries', ['bro'])` + `scripts/hooks/require-summaries-before-task-close.sh` |
| `task_create_batch` blocked until `/scan` has run (registry-cold gate) | 1 | server gate in `tools/tasks.ts` rejects unless `audit` has a `deep_scan_completed` row OR `waive_registry_gate=true` + reason ≥10 chars |
| `file_registry` auto-refresh after `bro_atomic_close` (md5-driven drift) | 4 | `scripts/hooks/post-task-close-rescan.sh` PostToolUse on `bro_atomic_close` backgrounds `scripts/maintenance/run-scan.mjs` |
| MCP calls include `agent: 'bro'` | 1 | `mcp/.../middleware/agent-scope.ts` |
| `validation_record` requires `subagent_session_id` (#144) | 1 | `mcp/.../tools/validation.ts` |
| `validation_record.feedback` MCP-availability prefix (#97) | 4 | schema CHECK on `validation_attempts.feedback` |
| `discussion_append(author='human')` requires `verified_human=true` | 1 | `mcp/.../tools/discussions.ts` |
| AUQ shape during roundtable `awaiting_human` | 2 | `scripts/hooks/roundtable-auq-shape.sh` |
| Issue-sync default-off + env-var kill-switch | 1 | schema seed + `TMB_DISABLE_REMOTE_SYNC` short-circuit in `sync/backend.ts` |
| Roundtable state machine | 1 | server rejects state-transition violations |
| Welcome banner phrasing | 6 only | CLAUDE.md |
| Decision-audit row required on every `task_create_batch` | 1 | `mcp/.../tools/tasks.ts` decision_gate |
| ADR-required hint (architectural intent → advisory injection) | 3 | `scripts/hooks/adr-required-hint.sh` |
| Verify-context check before answering | 6 only | CLAUDE.md |
| Voice / tone | 6 only | CLAUDE.md |

### SWE

| Interaction | Layer | Where |
|---|---|---|
| Spawned only with valid `task_id` referencing pending/open task with non-empty `spec_body` | 2 | `scripts/hooks/require-task-spec.sh` |
| Runs in isolated worktree | 2 | worktree Bash hooks |
| Cannot create branches (must attach to bro-pre-created branch; no `--detach`) | 2 | `scripts/hooks/no-worktree-branch-create.sh` |
| Cannot write `file_registry` summaries | 1 | `requireRoles('file_registry_update_summaries', ['bro'])` |
| Worktree branch must descend from `origin/<pr_target>` | 2 | `scripts/hooks/branch-up-to-date-with-remote.sh` |
| Scope-limited `tools:` keeps SWE off bro-only MCP writes | 1 + 3 | server `requireRoles` + `agents/swe.md` `tools:` list |
| MCP calls include `agent: 'swe'`, scope-restricted | 1 | server middleware |
| Atomic close — never self-validation_record | 1 | `requireRoles` rejects bro/swe writing pr-reviewer-only tools |
| Task spec compliance (only edits `## Files`) | 6 only | `agents/swe.md` |

### pr-reviewer

| Interaction | Layer | Where |
|---|---|---|
| Push to protected branch blocked unless every unsigned commit has passing `validation_attempts` row | 2 | `scripts/hooks/git-push-guard.sh` |
| MCP calls include `agent: 'pr-reviewer'`, scope-restricted | 1 | server middleware |
| `validation_record` is pr-reviewer-only | 1 | `requireRoles` |
| Cannot edit code (read-only review) | 3 | `agents/pr-reviewer.md` `tools:` excludes Edit/Write |
| Review output format | 6 only | skill |

### Consultants

| Interaction | Layer | Where |
|---|---|---|
| Cannot write workflow state (task_*, validation_record, issue_*, file_registry_update_summaries) | 1 | server middleware |
| Spawned only by bro, never by Human directly | 6 only | CLAUDE.md routing |
| Return analyses, never decisions | 6 only | consultant agent prompts |

### git operations (universal)

| Interaction | Layer | Where |
|---|---|---|
| Force-push to protected branches blocked | 2 | `scripts/hooks/git-guards.sh` |
| Direct commits to `dev`/`main` outside the dev→main PR flow blocked | 2 | `scripts/hooks/git-guards.sh` |
| Push gate (see pr-reviewer) | 2 | `scripts/hooks/git-push-guard.sh` |
| Naming conventions (file/identifier kebab/snake/Pascal per language) | 2 | `scripts/hooks/naming-lint.sh` |
| Conventional-commit subject format | 2 | `scripts/hooks/commit-msg-lint.sh` |
| Mechanical code-quality patterns (bare except, mutable defaults, missing timeout, f-string SQL, etc.) | 2 | `scripts/hooks/code-quality-lint.sh` |
| Project inventory at session start | 2 | `scripts/hooks/session-start-prescan.sh` (reports `file_registry: cold`/`warm`; bulk population belongs to `/scan`) |
| Domain-expert prompt → suggest spawning consultant | 5 (UserPromptSubmit injection) | `scripts/hooks/consultant-spawn-required.sh` |
| Roundtable capture-surface verification on `roundtable_close` | 2 | `scripts/hooks/roundtable-cleanup-postcheck.sh` |
| Bro task-close atomic invariants (audit + summaries + status + issue close in one txn) | 1 (composite) | `mcp/.../tools/composites.ts:bro_atomic_close` |
| SWE retry composite (rationale + new task + audit in one txn) | 1 (composite) | `mcp/.../tools/composites.ts:task_retry_batch` |
| `branch_id` derivation from intent | 1 (composite) | `mcp/.../tools/composites.ts:branch_id_propose` |

## How to add a new enforcement

1. Identify the failure mode. What's the bad thing if the LLM doesn't comply?
2. Pick the strongest layer that fits (table at top).
3. Implement:
   - **Layer 1**: `requireRoles` wrapper / handler validation / schema CHECK; add MCP-integration test.
   - **Layer 2**: write the hook under `scripts/hooks/`, register in `hooks/hooks.json`, add `tests/hooks/<name>.test.sh`.
   - **Layer 3**: edit agent's `.md` frontmatter; verify with subagent spawn.
   - **Layer 4**: schema CHECK in `mcp/.../schema.sql` (and migration in `db.ts` if existing DBs need rebuild).
   - **Layer 5**: add `paths:` to skill frontmatter.
   - **Layer 6**: edit prose; **note in this matrix that the item is Layer-6-only and may need promotion**.
4. Update this matrix with the new row.
5. **If demoting from a harder layer to a softer one, justify in the PR**.

## Positive prompts as the floor

Layer 6 (prompt) is the floor of TMB's enforcement stack. Negative directives (`don't X`, `never Y`) are anti-pattern: they force the model to first process the forbidden concept (Pink Elephant Problem). Phrase the canonical positive form; if the constraint is load-bearing, promote to a deterministic layer instead of bracing the prompt.

Research basis: pink elephant problem (arxiv 2503.22395), NeQA inverse scaling (Jang 2023, MLR), compliance gap analysis (Gadlet 2026).

## See also

- [`FLOWS.md`](FLOWS.md) — workflows; cross-references which hook fires when in each flow.
- [`FILES.md`](FILES.md) — file-by-file map of `scripts/hooks/`, `hooks/hooks.json`, the MCP middleware.
- [`ERD.md`](ERD.md) — schema; the role-by-tool matrix at the bottom is the source of truth for Layer 1's coverage.
