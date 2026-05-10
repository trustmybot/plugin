# TMB Workflows

The decision chain is **Human → bro → SWE** with two distinct gates:
- **bro is the task gate** — closes after SWE returns + verifies.
- **pr-reviewer is the push gate** — fires only at `git push` over a batch of unsigned commits.

All consultants (architect, cto, ceo, pm, project-local) advise but never write workflow state. The full role × tool matrix lives in [`RESPONSIBILITIES.md`](RESPONSIBILITIES.md); enforcement layers in [`ENFORCEMENT.md`](ENFORCEMENT.md); schema in [`ERD.md`](ERD.md).

## Quick index

| # | Flow | Trigger | Agents | DB tables touched | Distinguishing hooks |
|---|---|---|---|---|---|
| 1 | First contact | `identity_get().onboarded === false` | bro | `plugin_config`, `identity`, `audit` | `activation-routine` (auto-fire trigger) |
| 2 | **Code-touching task** (canonical) | Code change ask | bro → swe; pr-reviewer at push | `issues`, `tasks`, `discussions`, `audit` (+ `validation_attempts` at push) | `require-task-spec`, `git-push-guard`, `git-guards`, `cleanup-worktree-on-task-close` |
| 3 | Difficult task (Δ vs 2) | Touches `docs/trustmybot/architecture/` | + alignment Q+A + ADR | + `discussions(kind='question'/'answer'/'decision')` | same |
| 4 | Agent-creator | Routing hits role not in `.claude/agents/` | bro | — (file-based outcome) | — |
| 5 | Skill creation | Recurring pattern needs encoding | bro | `skills` (optional tracking) | — |
| 6 | Push gate / PR review | `git push` to protected branch | bro → pr-reviewer (one per unsigned task, parallel) | `validation_attempts` | `git-push-guard` |
| 7 | Architecture regen | First code-touching ask of session OR `/tmb refresh-architecture` | bro | `regen_state`, `file_registry` | `session-start-regen-check`, `lazy-regen-postcheck` |
| 8 | SWE retry / escalation | Bro verification or pr-reviewer verdict='fail' | bro ↔ swe (↔ pr-reviewer at push) | `validation_attempts` (multiple), `discussions` | `task_retry_batch` composite |
| 9 | Roundtable | Multi-consultant deliberation with AUQ ratification | bro orchestrates 2–4 consultants | `roundtables`, `roundtable_votes`, `discussions`, `audit` | `roundtable-auq-shape`, `roundtable-cleanup-postcheck` |
| 13 | Bulk cleanup | Human pre-authorizes a bulk delete | bro (direct Bash, no SWE spawn) | — | — |
| 33 | Multi-repo path discipline | `tmb_default_repo` set; bro indexes inner repo | bro | `file_registry` (repo-relative paths) | — |
| **C** | Consultant invocation | Human asks for second opinion | bro → consultant | `discussions(kind='analysis'/'concern')` | — |
| **M** | Monitor PR comments | `/monitor <PR_number>` | bro → pr-reviewer per actionable comment batch | `pr_review_runs`, `issues`, `tasks`, `audit` | — |

---

## 1. First contact (auto-fired `/onboard`)

Bro's `activation-routine.sh` UserPromptSubmit hook reads the identity row count. If the row is absent it injects a `FIRST CONTACT` directive. Bro reads the directive, fires `/onboard` immediately, and runs the slash command's branched ceremony before any reply.

**Round 1** asks the project shape (local-only vs remote-tracked). **Round 2** asks the per-shape question set:

| Shape | Round 2 questions | Persisted |
|---|---|---|
| Local-only | (none — github-flow defaulted silently) | `identity`, `branching_model`, derived `pr_target`, `remotes=[]`, `issue_sync='off'` |
| Remote-tracked | Branching, PR target, Remote (multiSelect) | + `remotes` array, then a Round 3 for `issue_sync` |

A **silent probe** (origin URL, gh/glab installed/authed) pre-selects defaults so most questions become 1-tap confirms. Local re-onboard adds the Branching question with a `Keep` option so the user can change models without first switching shape.

```mermaid
sequenceDiagram
    participant H as Human
    participant G as Bro
    participant DB as SQLite

    Note over G,DB: activation-routine.sh injects "onboarded=no — FIRST CONTACT"

    G->>G: silent probe (git remote -v, gh/glab auth)
    G->>H: AUQ Round 1 — Local-only or Remote-tracked?
    H-->>G: shape

    alt Local-only
        H-->>G: (Round 2 skipped on first-run)
        G->>DB: onboard_apply(shape='local')
    else Remote-tracked
        G->>H: AUQ Round 2 — Branching + PR target + Remote
        H-->>G: answers
        G->>H: AUQ Round 3 — issue_sync auto/off
        H-->>G: answer
        G->>DB: onboard_apply(shape='remote', ...)
    end

    G->>H: "Done. Settings updated: ..."
```

`/onboard` re-runs on demand for later changes — same flow with `Keep "<current>"` pre-selects. Identity is a pure onboarded marker (no name or other fields stored).

---

## 2. Code-touching task (canonical chain)

Bro is both planner AND task gate. pr-reviewer is the push gate, NOT the task gate. Tasks close as soon as SWE returns + bro verifies.

```mermaid
sequenceDiagram
    participant H as Human
    participant B as Bro (planner + task gate)
    participant S as SWE (worktree)
    participant DB as SQLite

    H->>B: "implement X"
    B->>B: triage simple/difficult; tmb_planning skill on demand
    B->>DB: issue_create + discussion_append(kind='intent') + branch_id_propose
    B->>B: pre-create branch from origin/<pr_target>; author spec_body

    Note over B,DB: BATCHED — one response, three tool_use blocks
    par
        B->>DB: task_create_batch(emit_planning_complete=true)
    and
        B->>S: spawn Task(swe, task_id=N) [hook: require-task-spec verifies]
    and
        B->>DB: audit_log(event_type='planning_complete')
    end

    Note over S: BATCHED — first SWE response
    par
        S->>DB: task_get(task_id=N)
    and
        S->>S: git worktree add <path> <branch>  (attached, no --detach)
    end
    S->>S: implement per spec; run ## Verification commands
    S->>S: git commit (## Commit message from spec)
    S->>DB: task_update_status(status='completed', commit_sha)

    B->>B: V1/V2/V3 verify (files, verification commands, success criteria)
    B->>DB: bro_atomic_close (audit + summaries + status='closed' + optional issue close)
    B-->>H: "task closed — push when ready"
```

**Notes**
- `require-task-spec.sh` blocks SWE spawn unless `tasks` row has `status IN (pending, open)` AND non-empty `spec_body`.
- `no-worktree-branch-create.sh` blocks `-b/-B/--create-branch/--detach` — bro pre-creates the branch; the worktree attaches to it directly.
- `git-push-guard.sh` blocks the eventual push if any pushed commit's task lacks a passing `validation_attempts` row.

---

## 3. Difficult task (Δ vs flow 2)

Same chain as flow 2, plus: between triage and `task_create_batch`, bro runs an alignment Q+A loop + writes an ADR.

- Skills: `tmb_planning` enters the difficult sub-flow when the change touches `docs/trustmybot/architecture/`.
- Sequential `AskUserQuestion` (one question at a time, not batched) — better UX than a tabbed AUQ for long deliberations.
- Each round writes `discussion_append(kind='question')` + `discussion_append(kind='answer')`.
- Final `discussion_append(kind='decision')` + ADR file at `docs/trustmybot/architecture/manual/decisions/N-*.md`.
- Bro's V1/V2/V3 verification after SWE returns is unchanged — never skipped, even when difficult-triaged.

---

## 4. Agent-creator

```mermaid
flowchart TD
    A[Human asks for role X] --> B{Role X exists in<br/>.claude/agents/?}
    B -->|yes| C[Route to existing agent]
    B -->|no| D[Bro loads tmb_agent-creator]
    D --> E[Skill: ≤3 clarifying Qs]
    E --> F[Skill: draft tailored prompt]
    F --> G[Show prompt to Human]
    G --> H{Human approves?}
    H -->|no| F
    H -->|yes| I[Write .claude/agents/x.md + agent_register]
    I --> J[Subsequent sessions: bro routes to X]
```

Reserved names — `bro`, `architect`, `swe`, `pr-reviewer` — are refused. New agent files commit to the project; every dev gets it on next pull.

---

## 5. Skill creation

Same shape as flow 4 — bro drafts via `tmb_skill-creator`, Human approves, file lands at `<project>/.claude/skills/<name>/SKILL.md`. Bro never edits agent body files; instead writes a project-local override agent file that extends `skills:`.

---

## 6. Push gate / PR review

```mermaid
sequenceDiagram
    participant H as Human
    participant B as Bro
    participant P as pr-reviewer (subagents — parallel)
    participant DB as SQLite

    H->>B: git push origin <feature>
    Note over B: git-push-guard.sh denies if any unsigned commit exists
    B-->>H: surface deny message
    B->>B: list unsigned tasks for the push
    par one pr-reviewer per unsigned task
        B->>P: spawn Task(pr-reviewer, task_id=N)
        P->>DB: task_get(task_id=N) — read spec + commit_sha
        P->>P: diff against ## Files / ## Success Criteria / ## Verification
        P->>DB: validation_record(verdict='pass'|'fail', feedback)
    end

    alt all pass
        B->>B: re-run git push (push-guard now allows)
        B-->>H: pushed; MR opened
    else any fail
        B-->>H: surface failures verbatim → AUQ to spawn SWE retry or abort
    end
```

`validation_record.feedback` MUST start with `MCP available: yes` or `MCP available: no — honor-system fallback` (schema CHECK enforces; push-gate parses). Subagents that lack MCP access fall back to honor-system review with the `no` prefix.

---

## 7. Architecture regen

Bro-only. No SWE spawn. Triggered by `session-start-regen-check.sh` on first code-touching ask of a session, or by `/tmb refresh-architecture`.

- Reads `regen_state` per target (`file_registry`, `architecture/auto/*.md`)
- Calls `architecture_regen` MCP tool which walks git log since `last_seen_sha`, updates `file_registry`, regenerates `auto/*.md` outputs, advances cursor.
- `lazy-regen-postcheck.sh` verifies the regen actually advanced state; nudges bro if it didn't.

---

## 8. SWE retry / escalation

Triggered when bro V1/V2/V3 fails OR pr-reviewer verdict='fail'. Bro uses the `task_retry_batch` MCP composite — one transaction inserts: a `discussion_append(kind='note', body='retry rationale: ...')`, a new `tasks` row keyed off the failed task's branch, and an `audit_log(event_type='swe_retry_spawned')`. Then spawns SWE on the new task.

After 3 consecutive retries, bro flips status to `escalated` and surfaces to Human (CLAUDE.md routing — judgment-bound).

---

## 9. Roundtable

Multi-consultant deliberation. Bro orchestrates 2–4 consultants on a topic, then renders an AUQ for Human ratification.

- `roundtable_create` opens the table.
- Bro spawns each consultant via `Agent` with the shared topic; consultants write `discussion_append(kind='analysis'|'concern')`.
- Each consultant `roundtable_vote(participant=<role>, vote, rationale)`.
- `roundtable_close` flips state to `awaiting_human` + emits a `discussion_append(kind='decision', body=summary)`.
- `roundtable-auq-shape.sh` validates the ratification AUQ structure.
- After Human picks: `roundtable_finalize_decisions` + `roundtable_summarize`.
- `roundtable-cleanup-postcheck.sh` verifies the capture surface (audit + discussion rows) actually landed.

---

## 13. Bulk cleanup (pre-authorized destructive ops)

When the Human's prompt names what to delete (branches, temp files, etc.), bro executes in one Bash call with no AUQ and no re-confirmation. Defensive checks (which files match? any active worktrees?) belong *before* the Human authorizes. Re-asking treats a standing directive as a question — wastes time and ignores intent.

---

## 33. Multi-repo path discipline

When a workspace has multiple inner git repos (siblings or submodules), `tmb_default_repo` config or per-task `tasks.repo` names the active inner repo. `file_registry` paths are stored repo-relative — bro does NOT prepend the inner repo directory when writing rows.

The L5 fixture `tests/dogfood/flows/33-multirepo-commit/` catches regressions at the storage layer: `file_registry.path LIKE 'api/%' OR LIKE 'app/%'` returns ≥1 row only on a workspace-rooted path leak.

---

## C. Consultant invocation

Human asks "get the architect's read on X" (or any named role). Bro loads `tmb_agent-creator` (which calls `agent_list` first to find the role in the registry), then spawns the consultant via `Agent`. Consultant writes its analysis as `discussion_append(kind='analysis')`. Bro reports to Human; **the Human decides** — never the consultant.

`consultant-spawn-required.sh` UserPromptSubmit hook detects domain-keyword prompts and injects a routing hint (advisory; bro decides whether to spawn).

---

## M. Monitor PR comments

`/monitor <PR_number>` slash command. Bro fetches the PR's review comments via `pr_comments_get`, triages actionable ones, files them as new `issues` + `tasks`, and dispatches SWE per ratified comment batch. Run state lives in `pr_review_runs` so re-runs of the same PR start from the last fetched comment ID.
