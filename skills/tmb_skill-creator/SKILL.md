---
name: tmb_skill-creator
description: Generate a new project-local skill at <project>/.claude/skills/<name>/SKILL.md and attach it to existing agents. Loads when the user asks to capture a repeatable behavior — e.g. "create a skill that codifies <our convention>", "teach swe to also <run mypy / use black / etc.>", "make a skill for <reviewing PRs / writing changelogs / etc.>", "we need a checklist when <X happens>". Extends the consuming agent's `skills:` frontmatter array only; agent body stays intact. Always Human-approved.
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__skill_register, mcp__plugin_tmb_trajectory-server__audit_append, mcp__plugin_tmb_trajectory-server__issue_create
---

# Skill Creator

If the original ask depended on the new skill being in place, bro holds it until the skill exists + is attached + approved.

## Discover the gap

Ask three questions in one AskUserQuestion batch: (1) what to call the skill — propose 1–3 names from context, lowercase with hyphens; (2) which agents to attach it to — list from `<project>/.claude/agents/`; (3) when it activates — always or path-scoped.

## Draft

Author the draft at `<project>/.claude/tmb/prompt-drafts/<name>/SKILL.md` (the prompt-write-approval gate denies writes under `<project>/.claude/skills/` before approval) using this frontmatter template:

```markdown
---
name: <name>
description: <one sentence — when this skill auto-loads. Be specific so the harness picks it up reliably; CC matches descriptions to context.>
allowed-tools: <optional, comma-separated — restricts tools the skill can invoke>
---

# <Title — Human-Readable>

[Body — concrete rules, checks, or patterns the agent should apply when this skill is loaded. Keep it focused.]
```

**Skill structure**: keep everything in one flat SKILL.md. Inline lookup tables and AUQ shapes; bundle scripts only when truly executable.

Then run `node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" prompt-author-lint <project>/.claude/tmb/prompt-drafts/<name>/SKILL.md`, surface findings via AUQ (user picks accept/decline per finding), and present the full drafted file in a fenced code block. Ask:
> Do you want me to (a) write this skill at `<project>/.claude/skills/<name>/SKILL.md`, AND (b) extend the `skills:` frontmatter array of <agent-list> to include `<name>`? (yes / revise / no)

## Write on approval

After the Human's Yes, in this order:

1. If there's no open issue (free-floating skill creation — common), `issue_create` one scoping it.
2. `skill_register` the name. If it refuses a name already registered, ask the Human for another name, or whether to edit the existing skill instead.
3. Before any write, record the Human's approval once per file, keyed by its absolute canonical path (symlinks resolved, spelled as you will write it): `audit_append(agent='bro', from_node='bro', issue_id=<issue>, event_type='prompt_write_approved', summary=<what the Human approved>, content_json='{"path":"<path>","scope":"<scope>"}')`, with scope `full` for the skill file and `skills-array` for each attach-list agent file. An approval holds for 30 minutes.
4. Write the approved content to `<project>/.claude/skills/<name>/SKILL.md` (for example by copying the draft with Write, since a Bash copy into `<project>/.claude/skills/` is denied; the draft may then be removed), and append the new name to each attach-list agent's `skills:` array.

Record an audit event noting the skill and its carrying agents, and tell the Human in one line: skill landed at `<path>`; attached to `<agents>`.

## Hard rules

- **Stay focused.** A skill should encode one cohesive concern. If the body grows past ~80 lines, propose trimming or splitting.
