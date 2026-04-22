---
name: phase-1-rename-template-dir
branch_id: refactor/phase-1-rename-template-dir
status: pending
authorized_by: architect
depends_on: []
estimated_minutes: 45
---

# Goal

Rename the seed template directory from `bro-template/` to `templates/docs-trustmybot/`,
and rename the inner `tasks/` subdirectory's contents to use markdown task-spec
naming conventions (the spec format change itself is Phase 2 work — here we only
move and rename the directory).

# Context

Per `docs/v0.3-blueprint.md` Phase 1, the per-project workflow directory `bro/`
is being renamed to `docs/trustmybot/` everywhere. The plugin ships a seed
template (currently `bro-template/`) that gets copied into target projects on
first activation by the `seed-project-agents` skill. That template needs to be
relocated to mirror the new layout.

`templates/agents/` already exists as a sibling for project-agent placeholders,
so `templates/docs-trustmybot/` slots in naturally.

There is **no backwards compatibility**. Old paths simply stop working. No
deprecation aliases, no symlinks.

# Files to change

Move:
- `/Users/Zax/Git/GitHub/TMB/plugin/bro-template/` → `/Users/Zax/Git/GitHub/TMB/plugin/templates/docs-trustmybot/`

Inside the relocated directory, edit text content (do not rename the inner
`tasks/` directory — that name stays) so any in-template path strings reference
`docs/trustmybot/...` rather than `bro/...`:
- `templates/docs-trustmybot/GOALS.md` — currently mentions `bro/DISCUSSION.md`; change to `docs/trustmybot/DISCUSSION.md`.
- `templates/docs-trustmybot/tasks/README.md` — currently titled `bro/tasks/`; rewrite header and body to refer to `docs/trustmybot/tasks/`. Note the task-spec format itself stays XML for Phase 1; the markdown migration is Phase 2.

Update the `provides.workflow` field in `/Users/Zax/Git/GitHub/TMB/plugin/.claude-plugin/plugin.json` from `"bro/"` to `"docs/trustmybot/"`.

# Success criteria

- `bro-template/` directory no longer exists at `/Users/Zax/Git/GitHub/TMB/plugin/`.
- `/Users/Zax/Git/GitHub/TMB/plugin/templates/docs-trustmybot/` exists and contains the previous contents of `bro-template/` (i.e. `GOALS.md` + `tasks/README.md`).
- `git mv` is used so history is preserved (verify with `git log --follow templates/docs-trustmybot/GOALS.md`).
- Every occurrence of `bro/` or `bro-template` inside the relocated files is replaced with `docs/trustmybot/` or removed if no longer relevant.
- `plugin.json` `provides.workflow` field equals `"docs/trustmybot/"`.
- `grep -r "bro-template" /Users/Zax/Git/GitHub/TMB/plugin/` returns zero matches across the entire repo (callers in `seed-project-agents` skill should be picked up by the `phase-1-rename-paths-skills-agents` task; if not flagged there, raise it).

# Out of scope

- Changing the task-spec format from XML to markdown (Phase 2, change #B).
- Editing `seed-project-agents` skill itself (handled by `phase-1-rename-paths-skills-agents`).
- Updating hooks (handled by `phase-1-rename-task-hook`).
- Updating CLAUDE.md / README.md (handled by `phase-1-rename-paths-docs`).

# Verification

Run from `/Users/Zax/Git/GitHub/TMB/plugin/`:

```bash
test ! -d bro-template && echo "OK: bro-template removed"
test -d templates/docs-trustmybot && echo "OK: new dir present"
test -f templates/docs-trustmybot/GOALS.md && echo "OK: GOALS.md present"
test -f templates/docs-trustmybot/tasks/README.md && echo "OK: tasks README present"
grep -rn "bro-template\|bro/" templates/docs-trustmybot/ && echo "FAIL: stale refs" || echo "OK: no stale refs in template"
grep -E '"workflow"\s*:\s*"docs/trustmybot/"' .claude-plugin/plugin.json && echo "OK: plugin.json updated"
```

All five checks must print OK.
