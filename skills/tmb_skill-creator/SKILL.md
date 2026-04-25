---
name: tmb_skill-creator
description: Generate a new project-local skill and attach it to one or more existing agents by extending their `skills:` frontmatter array. Never edits the agent body. Always asks Human approval before writing.
agent: bro
allowed-tools: Read, Write, Edit, Glob, AskUserQuestion, mcp__plugin_tmb_trajectory-server__ledger_log
---

# tmb_skill-creator

## Purpose

Add a new capability to a project's agents without editing their body. The Lego rule: **agent files are immutable identity; skills are additive capabilities.** This skill is the only mechanism allowed to extend a project agent — it adds a row to the agent's `skills:` array, never touches the body.

## When invoked

- Bro detects a project needs a new skill (e.g. Python-stack swe needs a Python-specific verification checklist that the default `swe-checklist` doesn't cover).
- Human asks bro to teach an agent a specific behavior (`@bro teach swe to also run mypy as part of verification`).
- A consultant flagged that the project lacks a skill needed for a domain (e.g. cto says "you should have a perf-budget skill on swe").

## Hold-and-resume

If the original ask depended on the new skill being in place, bro holds it until the skill exists + is attached + approved.

## Step 1 — Discover the gap

Ask the Human at most 3 questions in one batch:

```
AskUserQuestion({
  questions: [
    {
      question: "What should this skill be called? (lowercase, hyphens; will land at .claude/skills/<name>/SKILL.md)",
      header: "Skill name",
      multiSelect: false,
      options: [
        // Bro proposes 1-3 names based on context. NO synonym-of-Other placeholder; AskUserQuestion auto-renders Other for free-text.
      ]
    },
    {
      question: "Which agents should load this skill?",
      header: "Attach to",
      multiSelect: true,
      options: [
        // Bro lists existing project agents from .claude/agents/ as options. NO "all agents" or "none" placeholder.
      ]
    },
    {
      question: "When should this skill activate? (always, or only on certain file paths?)",
      header: "Activation",
      multiSelect: false,
      options: [
        { label: "Always — load every spawn of the attached agents" },
        { label: "Path-scoped — set `paths:` in frontmatter, only loads when the spawn touches matching files" },
      ]
    }
  ]
})
```

Wait for answers. Validate the name matches `^[a-z][a-z0-9-]{0,63}$`. Reserved names (`tmb_*`) are forbidden — those are plugin-protocol skills.

## Step 2 — Draft the skill

Author the file at `<project>/.claude/skills/<name>/SKILL.md`. Standard frontmatter:

```markdown
---
name: <name>
description: <one sentence — when to invoke, what it covers>
agent: <comma-separated agent names from Step 1, or omit for any-agent>
paths: ["<glob>", ...]   # only if Path-scoped was chosen
---

# <Title — Human-Readable>

[Body — concrete rules, checks, or patterns the agent should apply when this skill is loaded. Keep it focused; if this skill grows over 50 lines, propose splitting.]
```

## Step 3 — Show + ask

Present the full drafted file in a fenced code block. Then ask verbatim:

> "Do you want me to (a) write this skill at `.claude/skills/<name>/SKILL.md`, AND (b) extend the `skills:` frontmatter array of <agent-list> to include `<name>`? (yes / revise / no)"

Wait for the answer.

## Step 4 — Write on approval

On **yes**:
1. Write the skill file. If `<project>/.claude/skills/<name>/` exists, refuse — name collision means the Human resolves.
2. For each agent in the attach list, **edit only the `skills:` frontmatter array** to append the new name. Use the `Edit` tool with a precise old_string that includes the existing `skills:` block + the closing `---` so the diff is unambiguous. **Do not touch any other line of the agent file.**
3. Verify the writes by re-reading both the skill file and each agent's frontmatter.

On **revise**: ask what to change, redraft, re-show.
On **no** / silence / ambiguous: abort, write nothing.

## Step 5 — Log + report

```
ledger_log(
  agent='bro',
  event_type='tmb_skill_created',
  summary='Authored skill <name>; attached to <agents>.',
  content_json='{"name": "<name>", "agents": [...], "paths": [...] | null}',
)
```

Tell the Human in one line: skill landed at `<path>`; attached to `<agents>`. Return control.

## Hard rules

- **Never edit the body of a project agent file.** The only allowed edit to a project agent is appending to its `skills:` frontmatter array. If you find yourself wanting to edit the body, stop — that's a Lego violation, propose a different skill instead.
- **Never use a `tmb_` prefix on a project skill name.** Those are reserved for plugin-shipped protocol skills. Project-local skills use plain names.
- **Never overwrite an existing project skill.** Name collision = Human resolves.
- **Approval is non-negotiable.** Write nothing without an explicit Yes.
- **Stay focused.** A skill should encode one cohesive concern (e.g. "python verification checks", not "python rules + js rules + go rules"). Propose splitting if the body grows past ~50 lines.
