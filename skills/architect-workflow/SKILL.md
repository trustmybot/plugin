---
name: architect-workflow
description: Feature workflow protocol for Architect. Covers issue/discussion/task lifecycle, MCP state capture, and SWE coordination.
---

# Architect Workflow

Workflow artifacts live in MCP (SQLite) and `docs/trustmybot/` at the project root.

## File Format Rules

| Artifact | Format | Audience | Rationale |
|---|---|---|---|
| `tasks.spec_body` (SQLite row) | Markdown H2 sections stored as a string | Architect → SWE | Structured contract in DB; retrieved via `task_get(task_id)` |

---

## Workflow Steps

### 0. Triage Double-Check

Bro passes a `triage:` field in the spawn prompt (`simple` or
`difficult`). Before any other workflow step, re-evaluate the classification
using the heuristic:

> **Does this request require updates to `docs/trustmybot/architecture/`?**
> If yes → `difficult`. If no → `simple`.

Bro's classification is a proposal; architect's is binding. Record the
final classification (even when confirming bro's):

```
discussion_append(
  kind='note',
  body='Triage: <simple|difficult> (bro proposed <x>, architect <confirmed|overrode>)'
)
```

### 1–8. Main Sequence

1. Create or resume MCP issue (`issue_create` or `issue_resume`) to anchor the work item.
2. Discuss via `discussion_append` until aligned with the Human — append `kind='question'` entries, read replies, iterate.
3. **Difficult path only:** capture the architectural plan before writing any specs:
   ```
   discussion_append(
     kind='decision',
     body=<architectural plan: what changes, why, trade-offs, risks>
   )
   ```
4. Author the spec body markdown (`spec_body`) using the template size
   matched to the triage result (see "Template Selection" below). Required H2
   sections: Description, Files, Success Criteria, Verification, Out of Scope,
   Commit.
5. Call `task_create_batch` passing `spec_body` to insert rows in SQLite.
   The row columns (`issue_id`, `branch_id`, `title`, `status`, `created_at`)
   hold the structured fields; the body is the free-form contract SWE reads.
6. Spawn SWE per task (one worktree per task) using `task_id=<N>` in the
   Task-tool prompt.
7. Validate per `skills/validate-swe-output/SKILL.md`.
8. Spawn PR Reviewer before reporting phase complete.
9. Close tasks via `task_update_status(status='closed')` once review passes.

**Loops until all tasks are closed.** After step 8, check for remaining open
tasks → return to step 2.

### Intent Change Mid-Workflow

If the Human revises intent mid-workflow, append a new
`discussion_append(kind='intent')` entry; re-evaluate the open task batch and
split / cancel as needed via `task_update_status`. Optionally generate a
snapshot via `issue_snapshot_md` when the Human wants a doc to review.

---

## Discussion Phase

Triggers **in both simple and difficult triage** when the spec would have 2+ defensible interpretations. Triage decides template depth, NOT whether to align — any ambiguous scope needs the Human's explicit input before `kind='decision'`.

1. Call `issue_resume` or `issue_create` to load context.
2. **Environment probe** (see below) — detect language versions, package managers, linters, test runners on the local machine before offering any options.
3. Explore the codebase — identify affected modules, read existing code paths (error handling, validation, patterns).
4. Ask clarifying questions via **the Interactive Alignment pattern below** (max 3-4 questions per round). Every option in every radio form must be grounded in what the probe found — never offer generic "uv vs poetry vs pip" when only one is installed.
5. Wait for Human replies. Each reply is recorded via `discussion_append` so the alignment is auditable.
6. When aligned: **ALIGNED — PRODUCING TASK SPECS**

**Never skip discussion.** Explore code AND probe the environment BEFORE asking questions.

### Environment Probe

Before rendering AskUserQuestion, detect what the Human actually has locally. Use `Bash` (read-only). Examples — pick the ones relevant to the stack the ask implies:

```bash
# Language versions
python3 --version 2>&1 || echo "no python"
node --version 2>&1 || echo "no node"
go version 2>&1 || echo "no go"
rustc --version 2>&1 || echo "no rust"

# Python env/package managers
command -v uv && uv --version
command -v poetry && poetry --version
command -v pipenv && pipenv --version
command -v pip && pip --version

# Python project files
ls pyproject.toml requirements.txt setup.py Pipfile 2>/dev/null

# Node ecosystem
command -v bun && bun --version
command -v pnpm && pnpm --version
command -v npm && npm --version
ls package.json bun.lock pnpm-lock.yaml package-lock.json 2>/dev/null

# Linters / formatters
command -v ruff && ruff --version
command -v black && black --version
command -v biome && biome --version
command -v eslint && eslint --version

# Test runners
command -v pytest && pytest --version
command -v vitest && vitest --version

# Git state
git remote -v 2>/dev/null | head -2
```

**Use the results to build grounded AskUserQuestion options.** Example for the Python CLI todo case:

| If probe shows | Question | Options |
|---|---|---|
| `uv` installed + `python3` ≥ 3.11 | "Package manager?" | `uv (detected, v0.5.x) (Recommended)`, `pip + venv`, `poetry` |
| No package manager installed | "Install one?" | `Install uv (curl ...)`, `Use pip + venv (already available)`, `I'll handle it` |
| `pyproject.toml` exists | "Use existing pyproject.toml?" | `Yes (keep layout)`, `New project alongside`, `Scrap and restart` |
| `.python-version` file present | skip asking Python version; use the pinned version |

Never offer an option that can't be executed on the local machine. Never list a tool as `(Recommended)` unless it's detected AND fits the task.

**Persist the probe findings** — one `discussion_append(kind='note')` row summarizing what was detected, so future sessions can replay the environment context:

```
discussion_append(
  agent='architect',
  issue_id=<id>,
  kind='note',
  author='architect',
  body='Env probe: uv 0.5.11, Python 3.12.3, no existing pyproject.toml, git remote set.'
)
```

### Scope-ambiguity gate — structurally enforced by MCP

**`task_create_batch` now refuses to run if the issue has zero `kind='question'` rows in discussions.** This is an MCP-level check — the handler rejects the call before any tasks are inserted. Auto-mode cannot bypass it.

If your issue genuinely has no Q+A to record (typo fix, one-line doc change, truly trivial scope), pass a waiver:

```
task_create_batch(
  agent='architect',
  issue_id=<id>,
  waive_scope_gate=true,
  waive_scope_gate_reason='typo in README line 12; no interpretation needed',
  tasks=[...]
)
```

The waiver requires a reason ≥10 chars. The reason is logged to the `ledger` table as a `scope_gate_waived` event so pr-reviewer + Human reviewers can flag misuse.

**Default to not waiving.** The gate exists because auto-mode LLMs tend to skip asking questions even when scope is ambiguous. Asking is cheaper than re-doing. Use the waiver only when you genuinely have nothing to clarify.



**Before calling `discussion_append(kind='decision', ...)`, architect MUST have written at least one `kind='question'` + `kind='answer'` pair for this issue if ANY plan choice is in the ambiguous list below.**

Ambiguous choices that ALWAYS need an explicit Human `question` + `answer` pair before a decision:

- Storage backend (JSON vs SQLite vs in-memory vs external DB)
- Library choice (argparse vs click vs typer; pytest vs unittest; requests vs httpx)
- Command surface / CLI verbs ("What subcommands do you want?")
- Feature scope ("Do you want auth in this iteration, or skip it?")
- Persistence location (`./data/` vs `~/.myapp/` vs stdin/stdout)
- Runtime target (Python 3.10 vs 3.12, Node 18 vs 22, etc.)
- File layout for the new code (single file vs package vs module)

**Auto-mode does NOT waive this gate.** The gate exists precisely because auto-mode encourages shortcuts. If your response body would include phrases like "auto-mode defaults" or "defaulting to X since you didn't specify" — STOP. Ask the Human. Persist the Q+A. THEN decide.

**What it looks like when this gate fires correctly:**

```
discussions table (ordered):
  1. kind='intent',   author='human',     body='write a todo cli'
  2. kind='note',     author='architect', body='Triage: simple'
  3. kind='note',     author='architect', body='Env probe: uv, python 3.12, ...'
  4. kind='question', author='architect', body='CLI framework?\n1. argparse...'
  5. kind='answer',   author='human',     body='1'
  6. kind='question', author='architect', body='Storage?\n1. JSON file...'
  7. kind='answer',   author='human',     body='1'
  8. kind='decision', author='architect', body='## Plan\n- argparse\n- JSON in ~/...'
```

**What a gate violation looks like (to check during self-review):**

```
discussions table (ordered):
  1. kind='intent',   author='human',     body='write a todo cli'
  2. kind='note',     author='architect', body='Triage: simple'
  3. kind='note',     author='architect', body='Env probe: ...'
  4. kind='decision', author='architect', body='## Plan ... (auto-mode defaults)'
                                                                ^^^^^^^^^^^^^^^^
                                               RED FLAG — gate skipped, revert and ask
```

Before calling `task_create_batch`, re-read the discussion history via `discussion_list` or `issue_get_with_discussions`. If there's a `kind='decision'` with no preceding `kind='question'` — you violated the gate. Revert by NOT creating tasks, asking the missing question, persisting Q+A, then re-decide.

### Interactive Alignment — text Q + discussion_append persistence

`AskUserQuestion` is unavailable to plugin subagents (see [anthropics/claude-code#12890](https://github.com/anthropics/claude-code/issues/12890)). Architect must use **text questions** via regular chat output, then persist BOTH sides to `discussions` so the trajectory is replayable. Main Claude only hoists AskUserQuestion for `bro`'s onboarding form — not for architect mid-flow.

**Pattern — one round:**

```
# 1. Emit a plain-text question to the Human. Keep it scannable:
#    - One short lead sentence framing the choice.
#    - 2–4 numbered options with a one-liner each.
#    - Close with an explicit reply instruction.

Example output:

> I need to pick the CLI framework. Which fits?
>
> 1. **argparse** (stdlib, zero-install, verbose)
> 2. **click** (3rd-party, decorator DSL, prettier help)
> 3. **typer** (click + type hints, Python 3.10+)
>
> Reply with 1 / 2 / 3, or describe a different choice.

# 2. WAIT for the Human's reply in the next turn.

# 3. After reply, persist BOTH sides — question first, then answer. Chronological.
discussion_append(
  agent='architect',
  issue_id=<id>,
  kind='question',
  author='architect',
  body='<the question text + options verbatim>'
)
discussion_append(
  agent='architect',
  issue_id=<id>,
  kind='answer',
  author='human',
  body='<their reply verbatim>'
)
```

**When to batch multiple questions in one message:** when the answers are independent (scope, tech, priority can all be asked at once, numbered as a single list with sub-options).

**Persistence is non-negotiable.** Every alignment that affects the plan must land as a `question` + `answer` pair in `discussions`. If you ask but don't persist, the task spec loses its provenance and future sessions can't replay the reasoning.

### Closing the discussion

Once aligned, capture the final decision:

```
discussion_append(
  agent='architect',
  issue_id=<id>,
  kind='decision',
  author='architect',
  body='<architectural plan: what changes, why, trade-offs, risks>'
)
```

Then proceed to `task_create_batch`. The `discussions` table now contains
the full Q/A trail plus the final decision — `issue_report_md` and
`issue_snapshot_md` will render it chronologically for any reviewer.

---

## Template Selection

Both templates produce the same required H2 sections inside `spec_body`.
Choose based on triage result — the template size sets the depth of content
within those sections.

**simple triage → trivial template**
- Description: ≤ 3 sentences.
- Files: list affected paths.
- Success Criteria: 2–5 bullets; no validation matrix required.
- Verification: minimal commands sufficient to confirm the change.
- Commit: one-line message.
- Out of Scope and Results: may be empty placeholders.

**difficult triage → standard template**
- Description: full context, motivation, and constraints.
- Files: list with per-file description of what changes.
- Success Criteria: detailed, covering every error state, edge case, and
  input validation requirement; include a validation matrix where applicable.
- Verification: comprehensive commands covering happy path and failure modes.
- Out of Scope: explicit list of excluded concerns.
- Commit: one-line message.
- Results: empty placeholder (SWE fills on completion).

SWE must never guess. The required H2 headings are identical for both sizes;
only the content depth differs.

---

## Reasoning Process

**A. Requirement Alignment** — Load issue context, identify affected files,
separate explicit from implied, flag scope risks.

**B. Code Exploration** — Read actual code, not file names. For each area:
existing implementation, adjacent features (patterns), consumers of changed
functions, test files. Document findings as `file:line — [pattern]`.

**C. Solution Design** — Consider 2+ approaches. For each: error states,
edge cases, validation, state implications.

**D. Design Review** — Run quality criteria against each proposed task batch.

**E. Efficiency** — Minimize tasks. Group related changes. Mark parallelizable
tasks. Sequence by `depends_on`.

---

## BLUEPRINT Format — STAR

```markdown
## Phase N: [Title]
**Depends:** [none | phase_N]
**Situation:** Current state — what exists, what's broken. Cite file:line.
**Task:**      What and WHY (name the object, not the activity)
**Action:**    Ordered steps with file paths and commands
**Result:**    Acceptance criteria — exact verification commands
**Pitfalls:**  Specific failure modes to avoid
**Error Handling:** Error → response/behavior map
**Edge Cases:** Scenarios with expected behavior
**Checkpoint:** Falsification test before next phase
**Rollback:**  How to undo
```

---

> SWE spawn rules (worktree isolation, task spec template, parallel execution):
> `skills/swe-spawn-workflow/SKILL.md`
