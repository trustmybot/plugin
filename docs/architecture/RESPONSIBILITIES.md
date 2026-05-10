# Agent responsibilities

What each plugin-shipped agent is **actually** instructed to do, derived from the agent prompt files + their server-enforced role boundaries. Source of truth for "if it's not here and not in a hook/skill, the agent isn't doing it."

## Design philosophy

Three roles split by what each can be trusted to do without making its own homework, and which one stays alive when something unexpected fires:

- **bro** — persona on main Claude. Holds most permissions and the full picture (system design + alignment with Human). Bro does everything except coding. Only agent that talks to the Human; only one with the full `requireRoles` matrix unlocked.
- **swe** — codes. Three reasons coding splits out:
  1. **Token-heavy** — letting bro do it pollutes bro's strategic memory with diff noise.
  2. **No self-homework** — bro re-runs verification on SWE's output. Same agent can't write + sign off.
  3. **Subagents are fragile** — SWE runs as a CC subagent with narrowed `tools:` allowlist, frontmatter `disallowedTools`, fresh context. Hook denies / MCP errors mid-task can abort it. Critical state writes (workflow status, summaries, audit) stay with bro — the most permissioned + most resilient layer.
- **pr-reviewer** — independent 3rd party at push gate. Read-only on files (no Edit/Write tool). The only agent allowed to call `validation_record` — the formal sign-off the push gate consumes.

---

## bro

Source: `CLAUDE.md` (no `agents/bro.md` — bro is a persona on main Claude).

### Persistent persona behaviors

- **Activation routine** — `activation-routine.sh` UserPromptSubmit hook reads identity + pending issue from the trajectory DB and injects them as `additionalContext`. Bro consumes the injected data; doesn't redundantly call those MCP tools.
- **First-contact auto-fire** — when the hook reports `onboarded=no`, bro fires `/onboard` immediately before any reply.
- **Welcome banner** on first activation in a session.
- **Verify context before answering** — query trajectory DB first; branch by git-clean state; web for upstream specs; flag training-data fallbacks.
- **Pre-authorized destructive cleanup** — when the Human's prompt names what to delete (branches, temp files, etc.), bro executes in one Bash command with no AUQ.
- **MCP `agent: 'bro'`** on every MCP call — server rejects mismatches.

### Code-touching chain

1. `session-start-prescan.sh` (auto hook — inventory) → `session-start-regen-check.sh` (auto hook — drift) → triage
2. `branch_id_propose` MCP composite (open MCP issue + propose `branch_id`)
3. `tmb_planning` skill — triage classification + cold-start judgment + spec authoring (simple defaults vs difficult Q+A + ADR for arch-touching changes)
4. **bro pre-creates the task branch** from `origin/<pr_target>` — `git fetch origin && git branch <task.branch_id> origin/<pr_target>`
5. `task_create_batch(emit_planning_complete=true)` + spawn SWE [batched]
6. SWE returns
7. **bro verification (V1/V2/V3)**:
   - V1 — files match the spec's `## Files`
   - V2 — re-run the spec's `## Verification` commands inside the worktree
   - V3 — each `## Success Criteria` bullet visibly met by the diff
8. `bro_atomic_close` MCP composite — single transaction: `bro_verification_pass` audit + `last_verified_sha` advance + `file_registry` summaries + status `closed` + optional issue close.

### Server-enforced privileges (Layer 1)

Bro is the only agent allowed to call:
- `task_create_batch`
- `task_update_status` (shared with SWE; bro writes `closed`, SWE writes `completed`/`failed`)
- `issue_create`, `issue_close`, `issue_resume`
- `file_registry_update_summaries`
- `identity_set`, `identity_reset`
- `discussion_append` for `kind='intent'`
- `regen_state_set` (shared with consultants and pr-reviewer)
- `roundtable_create`, `roundtable_vote`, `roundtable_close`, `roundtable_finalize_decisions`, `roundtable_summarize`
- `pr_comments_get` (shared with pr-reviewer)
- `issue_sync_retry`
- `onboard_state_get`, `onboard_get_questions`, `onboard_apply`

### Hooks fired on bro's behalf

| Hook | When | Effect |
|---|---|---|
| `activation-routine.sh` | UserPromptSubmit | Inject onboarded marker + pending issue as context |
| `session-start-prescan.sh` | SessionStart | Inject project inventory (git state, stacks, registry warmth) |
| `session-start-regen-check.sh` | SessionStart | Nudge architecture refresh if docs are stale |
| `ensure-gitignore.sh` | SessionStart | Ensure `.claude/` is gitignored |
| `no-source-edit-from-main.sh` | PreToolUse Edit/Write | Deny bro source edits outside SWE worktree |
| `no-worktree-branch-create.sh` | PreToolUse Bash | Deny `git worktree add -b/-B/--detach` (branch authority is bro's pre-creation; attached worktrees only) |
| `branch-up-to-date-with-remote.sh` | PreToolUse Bash | Deny worktree-add to a branch behind `origin/<pr_target>` |
| `require-summaries-before-task-close.sh` | PreToolUse `task_update_status` | Deny `closed` when summaries are missing/stale |
| `cleanup-worktree-on-task-close.sh` | PostToolUse `task_update_status` | Remove worktree after bro closes task |

### Universal rules

- **Bro never edits source code** — every code change goes through SWE (Layer 2 hook enforces).
- **Voice**: relaxed tone, action-first, no padding.

---

## SWE (`agents/swe.md`)

Frontmatter: `model: sonnet`, `maxTurns: 55`, `tools: Read, Glob, Grep, Bash, Write, Edit, mcp__plugin_tmb_trajectory-server`, `isolation: worktree`, `skills: []`.

### Spawn contract

- Spawn input MUST include `task_id=<N>`. SWE rejects spawn if missing or task status isn't `pending`/`open` (Layer 2 hook `require-task-spec.sh` enforces).
- **First response** (parallel batch): `task_get(agent='swe', task_id=N)` + `Bash(git worktree add .claude/worktrees/<slug> <branch>)`. The `<branch>` MUST be `tasks.branch_id` verbatim — bro pre-created it.

### Work loop

- Work in the worktree per the spec's `## Files`, `## Success Criteria`, `## Verification`.
- Run verification commands **verbatim** from the spec.
- Optionally invoke `tmb_swe-checklist` skill when the spec's `## Verification` needs interpretation.

### Atomic close

Batch in one response:
1. Commit (using the spec's `## Commit` message)
2. `task_update_status(agent='swe', status='completed', commit_sha)`

SWE does **not** call `file_registry_update_summaries` — bro owns summaries (server-enforced).

### Server-enforced privileges (Layer 1)

- `task_get` (all agents)
- `task_update_status` for `completed`/`failed` (bro owns `closed`)
- `audit_log`
- `discussion_append` for `kind='note'/'concern'`

### Hooks fired against SWE actions

| Hook | When | Effect |
|---|---|---|
| `require-task-spec.sh` | PreToolUse Agent | Deny SWE spawn without valid `task_id` referencing a `pending`/`open` task with non-empty spec |
| `git-guards.sh`, `git-push-guard.sh` | PreToolUse Bash | Universal git safety (no force-push to protected branches; no push without signed `validation_attempts`) |
| `no-worktree-branch-create.sh` | PreToolUse Bash | Deny `git worktree add -b/-B/--detach` |
| `branch-up-to-date-with-remote.sh` | PreToolUse Bash | Deny SWE attaching worktree to a stale branch |

### Forbidden

- Push (any `git push`)
- Edit outside the worktree
- Author the spec body (server enforces — bro-only on `task_create_batch`)
- Bypass any PreToolUse hook block — STOP and surface the hook output to bro instead

---

## pr-reviewer (`agents/pr-reviewer.md`)

Frontmatter: `model: opus`, `tools: Read, Glob, Grep, Bash, Task, mcp__plugin_tmb_trajectory-server` (no Edit/Write — read-only by design).

### Spawn contract

- Fires at **push time** over a batch of unsigned tasks (NOT per individual task close).
- Bro spawns one pr-reviewer per unsigned `task_id=<N>` (parallel siblings when the push contains multiple).
- First action: `task_get(agent='pr-reviewer', task_id=N)`. Reject spawn if `task_id` missing.
- **MCP availability self-test** — first line of `validation_record.feedback` is `MCP available: yes` or `MCP available: no — honor-system fallback`. Schema CHECK enforces (`validation_attempts.feedback`); push-gate parses this prefix.

### Review work

For each task, diff against the spec's `## Files`, `## Success Criteria`, `## Verification`. Apply mechanical checks (delegate to `pr-review-toolkit:review-pr` if installed) + task-alignment checks (scope, success criteria met by diff, atomic-close discipline).

### Sign off

`validation_record(agent='pr-reviewer', task_id, attempt_n, verdict='pass'|'fail', feedback, subagent_session_id)`. Server enforces pr-reviewer-only.

### Server-enforced privileges (Layer 1)

- `validation_record` — pr-reviewer is the **only** writer
- `regen_state_set` (shared with bro and consultants)
- `issue_snapshot_md` (shared with consultants)
- `pr_comments_get` (shared with bro)
- `audit_log`, `discussion_append`

### Hooks fired against pr-reviewer actions

| Hook | When | Effect |
|---|---|---|
| `git-push-guard.sh` | PreToolUse Bash | Triggers pr-reviewer spawn — denies `git push` until every unsigned task has a passing `validation_attempts` row |

### Forbidden

- Authoring spec bodies
- Editing files (no Edit/Write tool — frontmatter)

---

## Consultants (`architect`, `cto`, `ceo`, `pm`, project-local custom)

Templates in `templates/agents/<name>.md`, instantiated per-project on demand via `tmb_agent-creator`. Not plugin-resident agents.

### Server-enforced constraints (Layer 1)

Consultants **cannot write workflow state**: `task_create_batch`, `task_update_status`, `issue_create`, `issue_close`, `validation_record`, `file_registry_update_summaries` all return `forbidden`.

They **can write analyses**: `discussion_append(kind='analysis'|'concern')`, `audit_log(kind='event')`. Architect specifically also gets `regen_state_set` and `issue_snapshot_md`.

### Spawn pattern

Bro spawns consultants for second opinions; consultants return analysis as a `discussions` row; bro reports to Human; **the Human decides** — never the consultant.

---

## Quick role × tool matrix

Source of truth: `mcp/trajectory-server/src/middleware/agent-scope.ts` `requireRoles` declarations.

| Tool | bro | swe | pr-reviewer | consultants |
|---|:---:|:---:|:---:|:---:|
| `issue_create` / `issue_close` | ✓ | | | |
| `task_create_batch` | ✓ | | | |
| `task_update_status(closed)` | ✓ | | | |
| `task_update_status(completed/failed)` | ✓ | ✓ | | |
| `validation_record` | | | ✓ | |
| `file_registry_update_summaries` | ✓ | | | |
| `identity_set` / `identity_reset` | ✓ | | | |
| `onboard_*` (state_get/get_questions/apply) | ✓ | | | |
| `discussion_append` | any kind | note/concern | any | analysis/concern |
| `audit_log`, `task_get` | ✓ | ✓ | ✓ | ✓ |
