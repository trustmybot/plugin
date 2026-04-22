---
name: phase-1-rename-paths-agents
branch_id: refactor/phase-1-rename-paths-agents
status: pending
authorized_by: architect
depends_on: []
estimated_minutes: 50
---

# Goal

Rewrite every `bro/` path reference inside the global agent prompts
(`agents/gatekeeper.md`, `agents/prompt-engineer.md`) and the project-level
agent templates (`templates/agents/architect.md`, `templates/agents/swe.md`,
`templates/agents/pr-reviewer.md`, plus `ceo.md` and `cto.md` if they contain
any references) to use `docs/trustmybot/`.

This is a path-string change only. **Do not rewrite agent workflow logic** —
that is Phase 3 work (changes #G and #I, two-path workflow).

# Context

The two-tier roster is:
- Global agents in `/Users/Zax/Git/GitHub/TMB/plugin/agents/` (gatekeeper, prompt-engineer).
- Project-level templates in `/Users/Zax/Git/GitHub/TMB/plugin/templates/agents/` (ceo, cto, architect, swe, pr-reviewer) — these are seeded into target projects on activation.

A grep showed roughly 30 `bro/` references across these files; see the
"Files to change" section for the full inventory. SWE must update every one
mechanically.

The agent prompts also reference `bro/tasks/*.xml`. Per Phase 1 scope, the file
location moves but the format stays XML this phase — so the file extension
stays `.xml` and the path becomes `docs/trustmybot/tasks/*.xml`. The XML-to-md
migration is Phase 2.

# Files to change

For each file, replace **every** occurrence of `bro/` with `docs/trustmybot/`,
**preserving the rest of the path**. The list below is the exhaustive map from
the current grep — SWE must verify each line and update it. If anything new
appears (e.g. inside code-fenced examples), update it too.

`/Users/Zax/Git/GitHub/TMB/plugin/agents/gatekeeper.md`:
- Line ~69: glob `bro/*.md` → `docs/trustmybot/*.md`
- Line ~76: `bro/GOALS.md` → `docs/trustmybot/GOALS.md`
- Line ~77: `bro/BLUEPRINT.md` → `docs/trustmybot/BLUEPRINT.md`
- Line ~78: `bro/tasks/*.xml` → `docs/trustmybot/tasks/*.xml`
- Line ~91: `bro/ files:` inventory label → `docs/trustmybot/ files:`

`/Users/Zax/Git/GitHub/TMB/plugin/agents/prompt-engineer.md`:
- Line ~20: `bro/*.md` and `bro/tasks/` references in narrative — update to `docs/trustmybot/...`
- Line ~40: table cell `bro/*.md` and `bro/tasks/` → `docs/trustmybot/*.md` and `docs/trustmybot/tasks/`

`/Users/Zax/Git/GitHub/TMB/plugin/templates/agents/architect.md`:
- Line ~38-40: skill loader paths (`bro/.claude/skills/...`) — these are WRONG today (they reference `bro/.claude/`, which never existed; should be `.claude/skills/...`). Fix to plain `.claude/skills/architect-workflow.md`, `.claude/skills/swe-spawn-workflow.md`, `.claude/skills/validate-swe-output.md`. (Architect note: this is a latent bug — the prefix `bro/` was wrong even pre-Phase-1. Fix it now while we're touching the line.)
- Line ~48: `What you CAN write/edit:` list — `bro/` → `docs/trustmybot/`
- Line ~71: `bro/GOALS.md has unclosed goals` → `docs/trustmybot/GOALS.md has unclosed goals`
- Line ~86: `See bro/.claude/skills/architect-workflow.md` → `See .claude/skills/architect-workflow.md` (same latent-bug fix)
- Line ~95: `Document in bro/BLUEPRINT.md` → `Document in docs/trustmybot/BLUEPRINT.md`

`/Users/Zax/Git/GitHub/TMB/plugin/templates/agents/swe.md`:
- Line ~3: description string mentions `bro/tasks/*.xml` → `docs/trustmybot/tasks/*.xml`
- Line ~23: instruction text — `bro/tasks/*.xml` → `docs/trustmybot/tasks/*.xml`
- Lines ~42-46: NEVER-read list with `bro/GOALS.md`, `bro/BLUEPRINT.md`, `bro/DISCUSSION.md`, `bro/PRODUCT.md`, `bro/MARKETING.md`, `bro/DESIGN.md`, `bro/tasks/*.xml` — every entry gets the prefix swap.
- Lines ~71-73: MUST NOT read block — same swap.

`/Users/Zax/Git/GitHub/TMB/plugin/templates/agents/pr-reviewer.md`:
- Line ~112: `Edit is permitted ONLY on bro/tasks/*.xml` → `docs/trustmybot/tasks/*.xml`
- Line ~118: `Any markdown file outside bro/tasks/` → `docs/trustmybot/tasks/`
- Line ~154: `Diff touches only bro/tasks/*.xml` → `docs/trustmybot/tasks/*.xml`

`/Users/Zax/Git/GitHub/TMB/plugin/templates/agents/ceo.md` and `cto.md`:
- Run grep first; if any `bro/` references appear, swap them. If none, no change.

# Success criteria

- Zero occurrences of `bro/` in any of: `agents/*.md`, `templates/agents/*.md`.
- Zero occurrences of `bro/.claude/` anywhere in the repo (latent-bug fix).
- All `docs/trustmybot/` substitutions preserve the suffix correctly (e.g. `bro/tasks/*.xml` becomes `docs/trustmybot/tasks/*.xml`, NOT `docs/trustmybot/tasks*.xml` or any malformed result).
- No semantic change to agent workflow — only paths. SWE must NOT rewrite descriptions, role statements, or routing tables. (PR Reviewer will diff for unauthorized scope creep.)

# Out of scope

- Two-path workflow rewrite (gatekeeper triage logic) — Phase 3.
- Identity/onboarding flow — Phase 4.
- Format change from XML to markdown for task specs — Phase 2.
- Editing files under `skills/` (handled by `phase-1-rename-paths-skills`).
- Editing CLAUDE.md or README.md (handled by `phase-1-rename-paths-docs`).

# Verification

```bash
cd /Users/Zax/Git/GitHub/TMB/plugin
! grep -rn "bro/" agents/ templates/agents/ && echo "OK: no stale bro/ in agents"
! grep -rn "bro/\.claude" agents/ templates/agents/ && echo "OK: no bro/.claude latent bug"
grep -c "docs/trustmybot/" agents/gatekeeper.md  # expect ≥4
grep -c "docs/trustmybot/" templates/agents/swe.md  # expect ≥7
grep -c "docs/trustmybot/" templates/agents/architect.md  # expect ≥3
grep -c "docs/trustmybot/" templates/agents/pr-reviewer.md  # expect ≥3
```

All grep-not-matched checks must print OK; the `grep -c` counts must meet or
exceed the listed numbers.
