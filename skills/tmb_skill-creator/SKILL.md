---
name: tmb_skill-creator
description: Generate a new project-local skill at .claude/skills/<name>/SKILL.md and attach it to existing agents. Loads when the user asks to capture a repeatable behavior — e.g. "create a skill that codifies <our convention>", "teach swe to also <run mypy / use black / etc.>", "make a skill for <reviewing PRs / writing changelogs / etc.>", "we need a checklist when <X happens>". Extends the consuming agent's `skills:` frontmatter array only; agent body stays intact. Always Human-approved.
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__skill_register, mcp__plugin_tmb_trajectory-server__audit_log, mcp__plugin_tmb_trajectory-server__issue_create
---

# Skill Creator

If the original ask depended on the new skill being in place, bro holds it until the skill exists + is attached + approved.

## Discover the gap

Ask three questions in one AskUserQuestion batch: (1) what to call the skill — propose 1–3 names from context, lowercase with hyphens; (2) which agents to attach it to — list from `.claude/agents/`; (3) when it activates — always or path-scoped.

## Draft

Author at `<project>/.claude/skills/<name>/SKILL.md` using this frontmatter template:

```markdown
---
name: <name>
description: <one sentence — when this skill auto-loads. Be specific so the harness picks it up reliably; CC matches descriptions to context.>
allowed-tools: <optional, comma-separated — restricts tools the skill can invoke>
---

# <Title — Human-Readable>

[Body — concrete rules, checks, or patterns the agent should apply when this skill is loaded. Keep it focused.]
```

**Skill structure**: keep flat (single SKILL.md) — do not split into reference.md / forms.md / scripts/. Inline lookup tables and AUQ shapes; bundle scripts only when truly executable.

Then run `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-author-lint.sh <draft-path>`, surface findings via AUQ (user picks accept/decline per finding), and present the full drafted file in a fenced code block. Ask:
> Do you want me to (a) write this skill at `.claude/skills/<name>/SKILL.md`, AND (b) extend the `skills:` frontmatter array of <agent-list> to include `<name>`? (yes / revise / no)

## Write on approval

`skill_register` the name, then write the skill file, append the new name to each attach-list agent's `skills:` array (and only that array), and re-read both to confirm the edits landed. If there's no open issue (free-floating skill creation — common), `issue_create` one scoping it. Record an audit event noting the skill and its carrying agents, and tell the Human in one line: skill landed at `<path>`; attached to `<agents>`.

## Hard rules

<!-- LOAD-BEARING-SAFETY: agent body is identity — only skills: array edits are allowed; body edits are a hard violation -->
- **Agent body is off-limits.** The only allowed edit is appending to its `skills:` array.
<!-- LOAD-BEARING-SAFETY: existing project skills must not be silently overwritten — Human resolves name collisions -->
- **Existing project skills require name collision resolution.** Name collision = Human resolves.
- **Approval is non-negotiable.** Write nothing without an explicit Yes.
- **Stay focused.** A skill should encode one cohesive concern. If the body grows past ~80 lines, propose trimming or splitting.
