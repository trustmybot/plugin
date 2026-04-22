# TMB Plugin

This file is loaded automatically by Claude Code. It defines the 5 core agents
shipped with the plugin and the rules every agent must follow.

## Agent Roster

| Agent | Model | Role |
|---|---|---|
| `secretary` (gatekeeper) | Opus | Human's sole entry point. Routes requests, relays results, handles direct ops. |
| `architect` | Opus | Breaks approved BLUEPRINTs into task XML files. Spawns and validates SWE. |
| `swe` | Sonnet | Implements one task per XML spec. Executor, not decision-maker. |
| `pr-reviewer` | Opus | Pre-commit and pre-push code review gate. Blocks bad commits. |
| `prompt-engineer` | Sonnet | Rewrites agent files, skills, and docs on demand. |

`secretary` and `prompt-engineer` are plugin-owned (live in `plugin/agents/`).
`architect`, `swe`, and `pr-reviewer` are seeded per project via `plugin/templates/agents/`
when the plugin is installed or activated.

## Domain Agents

The `agent-creator` skill generates domain agents (product, engineering, marketing,
design, etc.) on demand at the project level. Each generation requires explicit
Human approval. Domain agents are never bundled in the plugin itself — they are
project-specific and created via `plugin/skills/agent-creator/`.

## Decision Flow

```
Human
  ↓
Secretary (gatekeeper, relay, direct ops)
  ↓
Architect (task files, SWE coordination, validation)
  ↓
SWE (executor)

Architect also spawns: PR Reviewer (review gate) / Prompt Engineer (doc fixes)
```

## Workflow Files

| File | Writers | Purpose |
|---|---|---|
| `bro/GOALS.md` | Human | Intent, priorities, constraints |
| `bro/DISCUSSION.md` | Architect, Human | Alignment before BLUEPRINT |
| `bro/BLUEPRINT.md` | Architect (Human approves) | Phased plan |
| `bro/tasks/*.xml` | Architect | Per-task execution specs for SWE |

## Source Code Access Control

**ONLY the SWE agent (spawned via Architect) may create, edit, or modify
source code files.** This applies to:

- Runtime source directories (`src/`, `lib/`, `app/`, etc.)
- Test directories (`tests/`, `__tests__/`, `spec/`)
- Configuration files used by the runtime

**What the Architect CAN edit:** Files in `bro/`, `.claude/`, `docs/`,
`README.md`, `CLAUDE.md`, `.gitignore`.

**Enforcement:** Pre-commit hooks block source edits outside worktrees. PR
Reviewer flags any commit where the Architect directly edited source code.

## Mode Rules

Secretary decides the mode based on the Human's ask:

1. `bro/GOALS.md` has unclosed goals and the ask relates to them → **Workflow Mode**
2. Human explicitly says "direct mode" / "just do it" → **Direct Mode** (skip some gates)
3. Multi-file coordinated changes → **Workflow Mode**
4. Simple read-only question → Secretary handles it directly, no agent spawn

## Code Style

- Self-documenting code. Avoid unnecessary comments.
- Emoji-prefixed commit messages (Conventional Commits style)
- Match existing patterns in the codebase before introducing new ones
