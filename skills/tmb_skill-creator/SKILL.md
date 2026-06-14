---
name: tmb_skill-creator
description: Generate a new project-local skill at .claude/skills/<name>/SKILL.md and attach it to existing agents. Loads when the user asks to capture a repeatable behavior — e.g. "create a skill that codifies <our convention>", "teach swe to also <run mypy / use black / etc.>", "make a skill for <reviewing PRs / writing changelogs / etc.>", "we need a checklist when <X happens>". Extends the consuming agent's `skills:` frontmatter array only; agent body stays intact. Always Human-approved.
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__skill_register, mcp__plugin_tmb_trajectory-server__audit_log, mcp__plugin_tmb_trajectory-server__issue_create
---

# Skill Creator

Add a new capability to a project's agents without editing their body. **Lego rule**: agent files are immutable identity; skills are additive capabilities. This skill is the only mechanism that extends a project agent — it appends to the agent's `skills:` array and leaves the body intact.

## When to invoke

- Bro detects a project needs a new skill (e.g. Python-stack swe needs a Python-specific verification checklist that the default `tmb_swe-checklist` doesn't cover).
- Human asks bro to teach an agent a behavior (`@bro teach swe to also run mypy as part of verification`).
- A consultant flagged a project lacks a skill needed for a domain.

If the original ask depended on the new skill being in place, bro holds it until the skill exists + is attached + approved.

## Step 1 — Discover the gap

Ask three questions in one AskUserQuestion batch: (1) what to call the skill — propose 1–3 names from context, lowercase with hyphens; (2) which agents to attach it to — list from `.claude/agents/`; (3) when it activates — always or path-scoped.

## Step 2 — Draft

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

**Skill structure**: keep flat (single SKILL.md). Anthropic-style splits (SKILL.md + reference.md + forms.md + scripts/) sound clean but tax bro in headless mode — every extra file is another Read when bro can't ask the Human. Inline lookup tables and AUQ shapes; bundle scripts only when truly executable.

## Step 3 — Pre-write lint

Run `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-author-lint.sh <draft-path>`. Surface findings via AUQ; the user picks accept/decline per finding.

## Step 4 — Show and ask

Present the full drafted file in a fenced code block. Ask:
> Do you want me to (a) write this skill at `.claude/skills/<name>/SKILL.md`, AND (b) extend the `skills:` frontmatter array of <agent-list> to include `<name>`? (yes / revise / no)

## Step 5 — Write on approval

Register the name first with `skill_register` — the server validates and reserves it, surfacing collisions (see **Hard rules**) before anything lands on disk. Then write the skill file at `<project>/.claude/skills/<name>/SKILL.md`, append the new name to each attach-list agent's `skills:` array (and only that array), and re-read both the skill file and the touched frontmatter to confirm the edits landed.

## Step 6 — Log + report

If there's no open issue (free-floating skill creation — common), create one with `issue_create` scoping the creation. Then record an audit event noting the skill was created and which agents carry it, and tell the Human in one line: skill landed at `<path>`; attached to `<agents>`.

## Hard rules

<!-- LOAD-BEARING-SAFETY: agent body is identity — only skills: array edits are allowed; body edits are a hard violation -->
- **Agent body is off-limits.** The only allowed edit is appending to its `skills:` array.
<!-- LOAD-BEARING-SAFETY: existing project skills must not be silently overwritten — Human resolves name collisions -->
- **Existing project skills require name collision resolution.** Name collision = Human resolves.
- **Approval is non-negotiable.** Write nothing without an explicit Yes.
- **Stay focused.** A skill should encode one cohesive concern. If the body grows past ~80 lines, propose trimming or splitting.

## Headless mode — HALT

Skill creation is interactive by definition. On `AskUserQuestion` error or `TMB_HEADLESS=1`:

1. Halt immediately. Leave all files unwritten.
2. Create a scoping issue via `issue_create`, then log `event_type='headless_creator_blocked'` naming the proposed skill.
3. Surface: "Cannot create skill in headless mode — file writes require Human approval. Re-run interactively."

A skill is a behavior change to the agent ecosystem. CI-time generation requires Human review before any file is written.
