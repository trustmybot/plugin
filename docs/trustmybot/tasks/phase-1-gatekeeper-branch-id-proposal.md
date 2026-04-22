---
name: phase-1-gatekeeper-branch-id-proposal
branch_id: feat/phase-1-gatekeeper-branch-id-proposal
status: pending
authorized_by: architect
depends_on:
  - feat/phase-1-branch-id-git-convention
estimated_minutes: 35
---

# Goal

Teach the `gatekeeper` agent prompt to propose a git-convention `branch_id`
from the Human's intent statement, surface it for confirmation, and pass it
explicitly to `architect` (who in turn uses it when calling
`task_create_batch`).

This is a prompt-only change. No code edits. The validation enforcement
already lives in the MCP server (the dependency task).

# Context

Today the gatekeeper prompt has no notion of branch_id. The architect would
have to invent one when creating a task. Per blueprint change #F,
**gatekeeper proposes from intent** so the Human sees and approves the branch
name early, before architect spawns SWE.

Format the proposal must follow (must match what the MCP server validates,
otherwise creation will fail):
`<type>/<slug>` where type ∈ {feat, fix, refactor, chore, docs, test, perf,
build, ci, style, revert} and slug is lowercase alnum + hyphens, max 63
chars.

Mapping heuristic (fold into the prompt as a small table):
- "add / implement / new feature" → `feat/`
- "fix / bug / broken / crash" → `fix/`
- "rename / extract / restructure / clean up" → `refactor/`
- "update docs / readme / comments" → `docs/`
- "add tests / coverage" → `test/`
- "speed up / optimize" → `perf/`
- "build script / dependency / ci pipeline" → `chore/` (or `build/` / `ci/` if specifically those areas)
- when uncertain → ask Human to disambiguate

# Files to change

`/Users/Zax/Git/GitHub/TMB/plugin/agents/gatekeeper.md`:

1. After Section "C. Routing Table" and before Section "D. Agent-Creator Flow",
   insert a new section titled "C.1 Branch ID Proposal" that:
   - Defines what a branch_id is (the working git branch name for the task).
   - Shows the validation regex literal.
   - Provides the heuristic table above.
   - States the protocol: when the Human's request crosses into a code change,
     gatekeeper proposes a branch_id BEFORE routing to architect, presents it
     to the Human as `Proposed branch_id: feat/foo-bar — proceed? (y / suggest different)`,
     and waits for confirmation. Pass the confirmed branch_id in the Task tool
     prompt to architect: `architect, please plan and execute on branch_id "feat/foo-bar"`.
   - Direct read-only ops do NOT require a branch_id (gatekeeper handles them
     itself; no task created).

2. Update the routing table in Section C: in the row for "'Implement this' /
   task breakdown → architect", append a parenthetical: "(after branch_id
   proposal in C.1)".

3. Update the inventory block in Section B if needed (no new field required,
   but adding "Proposed branch_id (if applicable)" as a footer line is fine
   when the trigger is a code-change ask).

# Success criteria

- A grep for `branch_id` in `agents/gatekeeper.md` returns ≥3 matches (section
  header, regex literal, protocol step).
- The new section sits between current Sections C and D, preserving the rest
  of the prompt's structure.
- The proposal protocol explicitly requires Human confirmation before routing
  to architect.
- The format guidance in the prompt matches the validation regex from the
  dependency task — if they ever diverge the test suite will catch it, but
  visual review must confirm parity.

# Out of scope

- Editing the architect agent prompt to consume the branch_id (architect
  prompt already accepts whatever the caller passes; no change needed for
  Phase 1; deeper integration is Phase 3).
- Persisting "preferred branch_id naming style" per project (Phase 4 onboarding).
- Auto-suggesting branch IDs without Human confirmation (would violate
  gatekeeper's "no auto-action" rule in Section E).

# Verification

```bash
cd /Users/Zax/Git/GitHub/TMB/plugin
grep -c "branch_id" agents/gatekeeper.md  # expect ≥3
grep -n "C.1 Branch ID Proposal" agents/gatekeeper.md  # expect 1 hit
grep -E "feat\|fix\|refactor\|chore\|docs\|test\|perf\|build\|ci\|style\|revert" agents/gatekeeper.md \
  && echo "OK: regex type list present"
```

All checks must pass.
