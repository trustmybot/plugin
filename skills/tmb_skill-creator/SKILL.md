---
name: tmb_skill-creator
description: Generate a new project-local skill at <project>/.claude/skills/<name>/SKILL.md and attach it to existing agents. Loads when the user asks to capture a repeatable behavior — e.g. "create a skill that codifies <our convention>", "teach swe to also <run mypy / use black / etc.>", "make a skill for <reviewing PRs / writing changelogs / etc.>", "we need a checklist when <X happens>". Extends the consuming agent's `skills:` frontmatter array only; agent body stays intact. bro drafts, the Human approves, and swe writes the files through the code-touching flow.
allowed-tools: Read, Write, Glob, Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__skill_register, mcp__plugin_tmb_trajectory-server__audit_append
---

# Skill Creator

If the original ask depended on the new skill being in place, bro holds it until the skill exists + is attached + approved.

## Discover the gap

Ask three questions in one AskUserQuestion batch: (1) what to call the skill — propose 1–3 names from context, lowercase with hyphens; (2) which agents to attach it to — list the project's agents in `<project>/.claude/agents/` and the global ones in `~/.claude/agents/`; (3) when it activates — always or path-scoped.

## Draft

Author the draft at `<project>/.claude/tmb/prompt-drafts/<name>/SKILL.md` (the prompt-write-approval gate denies bro's writes under `<project>/.claude/skills/`) using this frontmatter template:

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
> Do you want swe to (a) write this skill at `<project>/.claude/skills/<name>/SKILL.md`, and (b) extend the `skills:` frontmatter array of <agent-list> to include `<name>`? (yes / revise / no)

## Write on approval

After the Human's Yes:

1. `skill_register` the name. If it refuses a name already registered, ask the Human for another name, or whether to edit the existing skill instead.
2. Run `tmb_planning` from §3. The spec carries the approved draft text verbatim and lists the skill file and each attach target in `files[]`. A project agent gets the name appended to its `skills:` array; a global agent from `~/.claude/agents/` gets a project-local override at `<project>/.claude/agents/<agent>.md`, a copy whose `skills:` array carries the name, since a global agent file is not the project's to edit. swe writes both, so the new prompt files get the same review as code.

Once the task closes, record an audit event noting the skill and its carrying agents, and tell the Human in one line: skill landed at `<path>`; attached to `<agents>`.

## Hard rules

- **Stay focused.** A skill should encode one cohesive concern. If the body grows past ~80 lines, propose trimming or splitting.
