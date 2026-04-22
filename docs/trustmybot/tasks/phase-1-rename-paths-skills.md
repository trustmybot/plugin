---
name: phase-1-rename-paths-skills
branch_id: refactor/phase-1-rename-paths-skills
status: pending
authorized_by: architect
depends_on: []
estimated_minutes: 35
---

# Goal

Rewrite every `bro/` path reference inside skill files (`skills/**/*.md`) to
use `docs/trustmybot/`. Update the `seed-project-agents` skill so it copies the
relocated template directory to the new project-level path on first activation.

This is a path-string change. Skill workflow logic stays the same.

# Context

A grep returned `bro/` references in:
- `skills/agent-creator.md`
- `skills/swe-spawn-workflow/SKILL.md`
- `skills/git-conventions/SKILL.md`
- `skills/create-hook/SKILL.md`
- `skills/architect-workflow/SKILL.md`
- `skills/roundtable-cleanup/SKILL.md`

The `seed-project-agents` skill (file: `skills/seed-project-agents/SKILL.md`)
is what physically copies template content into target projects. After Phase 1,
it must:
1. Copy `templates/agents/*.md` into `<target>/.claude/agents/` (unchanged behavior).
2. Copy `templates/docs-trustmybot/` into `<target>/docs/trustmybot/` (renamed source dir + renamed destination dir).

If `skills/seed-project-agents/SKILL.md` references `bro-template/` or `bro/`
in its body, update those to the new locations. SWE must read the file first
to determine the exact extent of edits.

# Files to change

- `/Users/Zax/Git/GitHub/TMB/plugin/skills/agent-creator.md` — line ~165 disallowedTools list with `bro/GOALS.md, bro/BLUEPRINT.md, bro/DISCUSSION.md`. Swap each path.
- `/Users/Zax/Git/GitHub/TMB/plugin/skills/swe-spawn-workflow/SKILL.md` — line ~29 naming convention `bro/tasks/<...>.xml`. Swap path. (XML extension stays — Phase 2 changes that.)
- `/Users/Zax/Git/GitHub/TMB/plugin/skills/git-conventions/SKILL.md` — line ~48 `bro/tasks/*.xml`. Swap path.
- `/Users/Zax/Git/GitHub/TMB/plugin/skills/create-hook/SKILL.md` — line ~18 `bro/tasks/`. Swap path.
- `/Users/Zax/Git/GitHub/TMB/plugin/skills/architect-workflow/SKILL.md` — lines ~8, 14-17, 23-27, 50. The whole "workflow files live in bro/" table block. Swap every path. The format/extension columns stay as-is for Phase 1.
- `/Users/Zax/Git/GitHub/TMB/plugin/skills/roundtable-cleanup/SKILL.md` — line ~11 `bro/roundtable/`. Swap path.
- `/Users/Zax/Git/GitHub/TMB/plugin/skills/seed-project-agents/SKILL.md` — read full file; replace any `bro-template` references with `templates/docs-trustmybot`, and any `bro/` destination paths in the target project with `docs/trustmybot/`.

# Success criteria

- `grep -rn "bro/" skills/` returns zero matches.
- `grep -rn "bro-template" skills/` returns zero matches.
- The seed-project-agents skill, when read end-to-end, produces a valid copy
  recipe: source `templates/docs-trustmybot/` → destination
  `<project>/docs/trustmybot/`.
- Every skill's `description` frontmatter (used for skill auto-invocation
  matching) stays semantically intact — paths in descriptions get swapped but
  intent does not change.

# Out of scope

- Editing agent prompts (handled by `phase-1-rename-paths-agents`).
- Editing CLAUDE.md / README.md / docs (handled by `phase-1-rename-paths-docs`).
- Renaming the `bro-template/` directory itself (handled by `phase-1-rename-template-dir`).
- Hook script changes (handled by `phase-1-rename-task-hook`).

# Verification

```bash
cd /Users/Zax/Git/GitHub/TMB/plugin
! grep -rn "bro/" skills/ && echo "OK: no stale bro/ in skills"
! grep -rn "bro-template" skills/ && echo "OK: no stale bro-template ref in skills"
grep -rn "docs/trustmybot/" skills/ | wc -l  # expect ≥10 (counting all the swapped lines)
grep -n "templates/docs-trustmybot" skills/seed-project-agents/SKILL.md && echo "OK: seed skill points at new template"
```

All not-matched checks must print OK; the count must be ≥10.
