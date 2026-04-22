---
name: phase-1-rename-paths-docs
branch_id: refactor/phase-1-rename-paths-docs
status: pending
authorized_by: architect
depends_on: []
estimated_minutes: 30
---

# Goal

Update top-level user-facing documentation — `CLAUDE.md` and `README.md` —
to reflect the `bro/` → `docs/trustmybot/` rename. The README's "Workflow
contract" diagram is the most user-visible change.

# Context

`CLAUDE.md` is loaded automatically by Claude Code when the plugin is enabled
in a project. Its workflow-files table is the authoritative map between agents
and the files they read/write.

`README.md` is the public marketing/intro doc. The "Workflow contract" section
shows a tree diagram of the `bro/` directory.

Neither file describes the Phase 2 changes (markdown specs, conversation-based
GOALS/DISCUSSION). Phase 1 only updates path strings — the workflow conceptual
model and the file-by-file responsibility table stay intact.

`docs/v0.3-blueprint.md` is the source-of-truth for the multi-phase plan;
do **not** edit it (it documents the plan, not the current state).

# Files to change

`/Users/Zax/Git/GitHub/TMB/plugin/CLAUDE.md`:
- Lines ~53-56: workflow-files table. `bro/GOALS.md` → `docs/trustmybot/GOALS.md`, etc. — every entry gets the prefix swap. Format/writer/purpose columns stay identical.
- Line ~71: "What the architect CAN edit" list: `bro/` → `docs/trustmybot/`.
- Line ~79: Workflow Mode trigger: `bro/GOALS.md has unclosed goals` → `docs/trustmybot/GOALS.md has unclosed goals`.

`/Users/Zax/Git/GitHub/TMB/plugin/README.md`:
- Line ~54: "Your project's `bro/` directory becomes the workflow state:" → "Your project's `docs/trustmybot/` directory becomes the workflow state:"
- Lines ~56-63: code-fenced tree diagram. Replace the root `bro/` with `docs/trustmybot/`. Inner files (GOALS.md, DISCUSSION.md, BLUEPRINT.md, tasks/*.xml) stay named as today (Phase 2 changes those).
- Anywhere else in the README that mentions `bro/`, swap it. (The `bro/GOALS.md` mention in the "Info isolation" cell of the comparison table — verify by grep.)

# Success criteria

- `grep -n "bro/" CLAUDE.md README.md` returns zero matches.
- The CLAUDE.md workflow-files table preserves four rows; only the file paths in column 1 change.
- The README.md tree diagram has `docs/trustmybot/` as its root and is still a valid markdown code block.
- No content is added or removed beyond path-string substitutions (no rewriting of explanations).

# Out of scope

- `docs/v0.3-blueprint.md` — leave untouched. It describes the plan, not current
  state, and it intentionally references the old `bro/` paths in historical
  context.
- Anything inside the workspace-level `/Users/Zax/Git/GitHub/TMB/CLAUDE.md` —
  not part of this repo (commits to plugin only).
- Editing `agents/`, `skills/`, `templates/`, hooks (other tasks own those).

# Verification

```bash
cd /Users/Zax/Git/GitHub/TMB/plugin
! grep -n "bro/" CLAUDE.md && echo "OK: CLAUDE.md clean"
! grep -n "bro/" README.md && echo "OK: README.md clean"
grep -c "docs/trustmybot/" CLAUDE.md  # expect ≥6
grep -c "docs/trustmybot/" README.md  # expect ≥2
# Sanity: blueprint untouched (still references bro/ in its historical text)
grep -q "bro/" docs/v0.3-blueprint.md && echo "OK: blueprint preserved"
```

Both not-matched checks must print OK; counts must meet minimums.
