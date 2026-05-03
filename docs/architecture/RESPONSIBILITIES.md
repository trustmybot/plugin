# Agent responsibilities — from the codebase

What each plugin-shipped agent is **actually** instructed to do, derived from the agent prompt files + the skills they're wired to. This is the **observable contract**, not the design intent: if it's not in this doc and not in a hook/skill, the agent isn't doing it.

## Design philosophy

The three roles split by **what each one can be trusted to do without making its own homework, and which one stays alive when something unexpected fires**:

- **bro** is the persona — the main agent, holding most permissions and the full picture (system design + requirement alignment with the Human). **Bro does everything except coding** — including all MCP / DB operations (issues, tasks, discussions, audit, file_registry summaries). Bro is the only agent that talks to the Human, and the only one with the full `requireRoles` matrix unlocked.
- **swe** does coding. Three reasons coding is split out:
  1. **Token-heavy** — letting bro do it would pollute bro's strategic memory with low-level diff noise.
  2. **No self-homework** — the whole point of separation is bro re-runs verification on SWE's output. The same agent that wrote the code can't be the one marking it.
  3. **Subagents are fragile** — SWE runs as a CC subagent with a narrowed `tools:` allowlist, frontmatter `disallowedTools`, and a fresh context. Hook denies, permission rejections, MCP errors mid-task can cause a subagent to abort or thrash. Critical state writes (workflow status, summaries, audit) stay with bro, which is the **most permissioned + most resilient** layer — bro can recover, retry, escalate to the Human. SWE is intentionally narrow: one task per spawn, isolated worktree, atomic close, zero spec authority.
- **pr-reviewer** is an **independent 3rd party**, more focused on git-diff against the spec than on the broader system. Can also pair with bro for integration testing — both have read access to `file_registry` and the whole codebase, so pr-reviewer can sanity-check claims about cross-cutting impact. pr-reviewer is structurally read-only on files (no Edit/Write tool) and is the only agent allowed to call `validation_record` — the formal sign-off the push gate consumes. Same subagent-fragility caveat as SWE: pr-reviewer doesn't own workflow state, only its own verdict.

Everything below is how that philosophy materializes in the prompts, skills, hooks, and `requireRoles` middleware.

## Sources scanned

- `CLAUDE.md` (bro persona, auto-loaded)
- `agents/swe.md` (SWE prompt)
- `agents/pr-reviewer.md` (pr-reviewer prompt)
- `skills/tmb_*/SKILL.md` (protocol skills bro/swe/pr-reviewer reactively load)
- `hooks/hooks.json` + `scripts/hooks/*.sh` (deterministic enforcement that fires regardless of prompt)

---

## bro

Source: **`CLAUDE.md`** (no `agents/bro.md` — bro is a persona on main Claude). Plus the `tmb_*` skills bro loads when triggered.

### Persistent persona behaviors (every bro-mode message)

- **Activation routine** — `identity_get` + `issue_resume` data is read by the `activation-routine.sh` UserPromptSubmit hook and injected into context. Bro consumes the injected data; does NOT call those MCP tools redundantly.
- **Welcome banner** — emitted on first activation in a session. Two variants: pending-work resume vs idle greeting.
- **Verify context before answering** — query trajectory DB first; branch by git-clean state; use `tmb_project-prescan` for first-time onboarding; web for upstream specs; flag training-data fallbacks.
- **Standards check** — propose `tmb_agent-creator` to spawn a domain specialist when the question is outside general SWE.
- **MCP `agent: 'bro'` parameter** on every MCP call — server rejects others.
- **Pre-authorized destructive cleanup** — when the Human's prompt already names what to delete (branches, temp files, etc.), bro executes in one Bash command with no AUQ and no re-confirmation. Defensive checks happen before authorization, not after.

### Routing (CLAUDE.md ## Routing table)

| Ask shape | bro's action |
|---|---|
| "Implement this" / any code change | Code-touching chain (planning → SWE spawn → bro verify → close) |
| "Review before push" / `git push` blocked | `tmb_push-gate` |
| "Get architect's / cto's / pm's opinion" | Check local agent file; spawn or `tmb_agent-creator` |
| Domain role with no shipped template | `tmb_agent-creator` from-scratch + Human approval |
| Configure / change settings | `tmb_reonboard` |
| `refresh architecture docs` | `tmb_refresh-architecture` |
| Disagree with Human's plan | `tmb_concerns-protocol` |
| File reads / searches / git status | Direct (Read, Glob, Grep, Bash) |
| `/roundtable <topic>` | `tmb_roundtable` (explicit-trigger entry; see `docs/commands/`) |
| `/monitor <PR_number>` | `tmb_pr-review-handler` (explicit-trigger entry; see `docs/commands/`) |

### Code-touching chain (single source of truth: `tmb_planning-simple` / `tmb_planning-difficult`)

1. `tmb_project-prescan` → `tmb_lazy-regen-check` → triage
2. `tmb_branch-id-proposal` (open MCP issue + propose branch_id)
3. `tmb_planning-simple` OR `tmb_planning-difficult` — specs that introduce external side effects (network calls, API mutations) get a blast-radius review before finalizing
4. **bro pre-creates the task branch from `origin/<pr_target>`** (after fetching) — `git fetch origin && git branch <task.branch_id> origin/<pr_target>`
5. `task_create_batch` + spawn SWE with `task_id=<N>` + `audit_log(kind='event', event_type='planning_complete')` [batched]
6. SWE returns
7. **bro verification (V1/V2/V3)**:
   - V1 — files match the spec's `## Files`
   - V2 — re-run the spec's `## Verification` commands inside the worktree
   - V3 — each `## Success Criteria` bullet visibly met by the diff
8. **bro updates file_registry summaries** — `file_registry_update_summaries(updates=[{path, summary, ...}], advance_verified_sha=<commit_sha>)`. Server-enforced bro-only; a PreToolUse hook denies the next step if summaries are missing/stale.
9. `task_update_status(status='closed')` + `issue_close` (if last task on issue)

### Reactive skills (loaded on trigger only)

| Trigger | Skill |
|---|---|
| AskUserQuestion errors / `TMB_HEADLESS=1` | `tmb_headless-fallback` |
| MCP `is_error: true` | `tmb_mcp-error-handling` |
| Push gate | `tmb_push-gate` |
| Re-onboarding | `tmb_reonboard` |
| Refresh arch docs | `tmb_refresh-architecture` |
| Disagreement | `tmb_concerns-protocol` |
| `/roundtable <topic>` | `tmb_roundtable` |
| `/monitor <PR_number>` | `tmb_pr-review-handler` |

### Server-enforced bro privileges (Layer 1)

Bro is the only agent allowed to call:

- `task_create_batch`
- `task_update_status` (shared with swe; bro for `closed`, swe for `completed`/`failed`)
- `issue_create`, `issue_close`, `issue_resume`
- `file_registry_update_summaries`
- `identity_set`, `identity_reset`
- `discussion_append` for `kind='intent'/'note'`
- `regen_state_set` (shared with architect, pr-reviewer)
- `roundtable_create`, `roundtable_vote`, `roundtable_close`, `roundtable_finalize_decisions`, `roundtable_summarize`
- `pr_comments_get` (shared with pr-reviewer)
- `issue_sync_retry`

### Hooks fired on bro's behalf

| Hook | When | Effect |
|---|---|---|
| `activation-routine.sh` | UserPromptSubmit (bro mode) | Injects identity + pending issue as context |
| `session-start-regen-check.sh` | SessionStart | Nudges `tmb_refresh-architecture` if arch docs are stale |
| `ensure-gitignore.sh` | SessionStart | Ensures `.claude/` in project's `.gitignore` |
| `no-source-edit-from-main.sh` | PreToolUse Edit/Write | Denies bro source edits outside SWE worktree |
| `no-worktree-branch-create.sh` | PreToolUse Bash | Denies `git worktree add -b/-B` (branch authority is bro's pre-creation) |
| `branch-up-to-date-with-remote.sh` | PreToolUse Bash | Denies worktree-add to a branch behind `origin/<pr_target>` |
| `require-summaries-before-task-close.sh` | PreToolUse `task_update_status` | Denies bro's `closed` call when summaries are missing/stale |
| `cleanup-worktree-on-task-close.sh` | PostToolUse `task_update_status` | Removes worktree after bro closes task |

### Universal rules

- **Bro never edits source code** — every code change goes through SWE (Layer 2 hook enforces).
- **Voice**: relaxed tone, action-first, no padding.
- **Catchphrase**: "Trust me bro, it works." — only after the push gate passes (Layer 6 prompt rule, no enforcement).

---

## SWE (`agents/swe.md`)

Frontmatter: `model: sonnet`, `maxTurns: 55`, `tools: Read, Glob, Grep, Bash, Write, Edit, mcp__plugin_tmb_trajectory-server`, `isolation: worktree`, `skills: []`.

### Spawn contract

- Spawn input MUST include `task_id=<N>`. SWE rejects spawn if missing or task status isn't `pending`/`open` (Layer 2 hook `require-task-spec.sh` also enforces).
- **First response** (parallel batch): `task_get(agent='swe', task_id=N)` + `Bash(git worktree add .claude/worktrees/<slug> <branch>)`. The `<branch>` MUST be `tasks.branch_id` verbatim — bro pre-created it. **Never** `-b`/`-B` (Layer 2 hook denies).

### Work loop

- Work in the worktree per the spec's `## Files`, `## Success Criteria`, `## Verification`.
- Run verification commands **verbatim** from the spec — don't substitute.
- Optionally invoke `tmb_swe-checklist` skill when the spec's `## Verification` needs interpretation.

### Atomic close (`#W4`)

Batch in one response:
1. Commit (using the spec's `## Commit` message)
2. `task_update_status(agent='swe', status='completed', commit_sha)`

**SWE does NOT call `file_registry_update_summaries`** — that's bro's responsibility during verification (server-enforced).

### Forbidden

- Push (any `git push`)
- Commit secrets
- Edit outside the worktree
- Author the spec body (server enforces — bro-only on `task_create_batch`)
- Bypass any PreToolUse hook block (use `.git/HEAD` rewrites, fabricated refs, etc.) — STOP and surface the hook output to bro instead
- Read project-level `CLAUDE.md` (that's bro's persona, irrelevant here)

### Server-enforced SWE privileges (Layer 1)

SWE is allowed to call:
- `task_get` (shared with all agents)
- `task_update_status` for `completed` / `failed` (bro owns `closed`)
- `audit_log`
- `discussion_append` for `kind='note'/'concern'`

### Hooks fired against SWE actions

| Hook | When | Effect |
|---|---|---|
| `require-task-spec.sh` | PreToolUse Agent | Denies SWE spawn without valid `task_id` referencing a `pending`/`open` task with non-empty spec |
| `git-guards.sh`, `git-push-guard.sh` | PreToolUse Bash | Universal git safety (no force-push to protected branches, no push without signed validation_attempts) |
| `no-worktree-branch-create.sh` | PreToolUse Bash | Denies `git worktree add -b/-B` from anyone (SWE included) |
| `branch-up-to-date-with-remote.sh` | PreToolUse Bash | Denies SWE attaching worktree to a stale branch |

### Frontmatter constraints

- `isolation: worktree` — CC creates an isolated git worktree for the spawn
- `tools:` allowlist — explicit; no broad wildcards

---

## pr-reviewer (`agents/pr-reviewer.md`)

Frontmatter: `model: opus`, `tools: Read, Glob, Grep, Bash, Task, mcp__plugin_tmb_trajectory-server`, `skills: []` (no `Edit`/`Write` — read-only by design).

### Spawn contract

- Fires at **push time** over a batch of unsigned tasks, NOT at every individual task close.
- Bro spawns one pr-reviewer per unsigned `task_id=<N>` (parallel siblings when the push contains multiple).
- First action: `task_get(agent='pr-reviewer', task_id=N)`. Reject spawn if `task_id` missing.
- **MCP availability self-test** — first output line is `MCP available: yes` or `MCP available: no — honor-system fallback`. Bro greps the trajectory log for this line when making routing decisions. If `no`, pr-reviewer falls back to diff-only review without DB writes.

### Review work

For each task:
- Diff against the spec's `## Files`, `## Success Criteria`, `## Verification`
- Mechanical review — delegate to `pr-review-toolkit:review-pr` if installed
- Task-alignment checks:
  - **Scope** — changed files match `## Files`
  - **Success criteria** — met by the diff (not just claimed)
  - **Atomic-close discipline** (`#W4`) — task status was `completed` before bro flipped to `closed`
  - **No manual edits to `docs/trustmybot/architecture/auto/`** (those are regen output)

### Sign off

- `validation_record(agent='pr-reviewer', task_id, attempt_n, verdict='pass'|'fail', feedback)` — server enforces pr-reviewer-only.
- Return verdict to bro. Bro reports to Human; on pass the push proceeds; on fail bro re-spawns SWE with feedback.

### Server-enforced pr-reviewer privileges (Layer 1)

- **`validation_record`** — pr-reviewer is the ONLY agent allowed to write this. Bro/swe/consultants get rejected.
- `regen_state_set` (shared with architect, bro)
- `issue_snapshot_md` (shared with architect)
- `pr_comments_get` (shared with bro)
- `audit_log`, `discussion_append`

### Hooks fired against pr-reviewer actions

| Hook | When | Effect |
|---|---|---|
| `git-push-guard.sh` | PreToolUse Bash | Bro spawns pr-reviewer because this hook denied `git push` until every unsigned task has a passing `validation_attempts` row |

### Frontmatter constraints

- `tools:` excludes `Edit`/`Write` — pr-reviewer is structurally read-only on the codebase
- Can spawn subagents via `Task` (e.g., for parallel sibling reviews)

### Forbidden

- Authoring spec bodies
- Editing files (no Edit/Write tool)
- Reading `CLAUDE.md` (bro's persona, irrelevant)

---

## Consultants (`architect`, `cto`, `ceo`, `pm`, project-local custom)

These are **templates** in `templates/agents/<name>.md`, instantiated per-project on demand via `tmb_agent-creator`. Not plugin-resident agents.

### Universal consultant constraints (Layer 1, server-enforced)

Consultants **cannot write workflow state**:
- ❌ `task_create_batch`, `task_update_status`, `issue_create`, `issue_close`
- ❌ `validation_record`
- ❌ `file_registry_update_summaries`

They **can write analyses**:
- ✅ `discussion_append(kind='analysis'|'concern')`
- ✅ `audit_log(kind='event')`
- ✅ Some get `regen_state_set` and `issue_snapshot_md` (architect specifically)

### Spawn pattern

Bro spawns consultants for second opinions; consultants return their analysis as a `discussions` row; bro reports to Human; **the Human decides** — never the consultant.

---

## Quick role × tool matrix

The authoritative source is `mcp/trajectory-server/src/middleware/agent-scope.ts` `requireRoles` declarations. Highlights:

| Tool | bro | swe | pr-reviewer | consultants |
|---|---|---|---|---|
| `issue_create` / `issue_close` | ✓ | | | |
| `task_create_batch` | ✓ | | | |
| `task_update_status(closed)` | ✓ | | | |
| `task_update_status(completed/failed)` | ✓ | ✓ | | |
| `validation_record` | | | ✓ | |
| `file_registry_update_summaries` | ✓ | | | |
| `identity_set` / `identity_reset` | ✓ | | | |
| `discussion_append` | ✓ (any kind) | ✓ (note/concern) | ✓ (any) | ✓ (analysis/concern) |
| `audit_log`, `task_get` | ✓ | ✓ | ✓ | ✓ |

---

## How to keep this doc accurate

If you change an agent's prompt, the skill it loads, or the hook surface around it, **update the corresponding section here in the same PR**. The doc is the contract; if the contract drifts from the code, both are wrong.
