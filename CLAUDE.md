# CLAUDE — TMB Plugin Project

This file is picked up automatically by Claude Code. It tells every agent how
this project is organized and which agent owns what.

## Agent Roster

### Entry Point

| Agent | Role | Model |
|---|---|---|
| `secretary` | Human's gatekeeper. The ONLY agent the Human talks to directly. Routes requests, relays results, handles direct ops (git, file reads). | Opus |

### Leadership

| Agent | Role | Model | Authority |
|---|---|---|---|
| `ceo` | Product vision, priorities, roundtable facilitation | Opus | Highest — overridden only by Human |
| `cto` | Technical architecture, system design, BLUEPRINT approval | Opus | Technical authority — challenges CEO on feasibility |

### Domain Experts (spawned by CEO)

| Agent | Role | Model | Writes To |
|---|---|---|---|
| `pm` | Product strategy, user research, market viability | Opus | `bro/PRODUCT.md` |
| `gtm` | Positioning, messaging, conversion, launch | Opus | `bro/MARKETING.md` |
| `designer` | UX, visual identity, design system | Opus | `bro/DESIGN.md` |

### Execution

| Agent | Role | Model | Reports To |
|---|---|---|---|
| `architect` | Breaks BLUEPRINTs into task files, spawns SWE, validates | Opus | CTO |
| `swe` | Implements one task per XML spec — executor, not decision-maker | Sonnet | Architect |
| `pr-reviewer` | Pre-commit and pre-push code review gates | Opus | CTO |
| `prompt-engineer` | Rewrites prompts, agent files, skills, docs | Sonnet | CTO |

### Decision Flow

```
Human
  ↓
Secretary (gatekeeper, relay, direct ops)
  ↓
CEO (product vision, priorities)
  ↓
CTO (technical architecture)
  ↓
Architect (task files, SWE coordination, validation)
  ↓
SWE (executor)

CEO also spawns: PM / GTM / Designer (advisory, via roundtable or direct)
Architect also spawns: PR Reviewer (review gate) / Prompt Engineer (doc fixes)
```

## Workflow Files

| File | Writers | Readers | Purpose |
|---|---|---|---|
| `bro/GOALS.md` | Human (with CEO input) | All | Intent, priorities, constraints |
| `bro/DISCUSSION.md` | Architect, CEO, CTO, Human | All | Q&A alignment before BLUEPRINT |
| `bro/BLUEPRINT.md` | CTO (or Architect, CTO approves) | All | STAR-structured phases, Human approves |
| `bro/tasks/*.xml` | Architect | SWE only | Per-task execution plans |
| `bro/PRODUCT.md` | PM | CEO, CTO | Product strategy record |
| `bro/MARKETING.md` | GTM | CEO | Positioning and launch plans |
| `bro/DESIGN.md` | Designer | CTO, Architect | Design system and UX decisions |

**Loop:** Human writes GOALS → CEO scopes → CTO designs BLUEPRINT → Human
approves → Architect writes tasks → SWE implements → PR Reviewer gates →
Architect validates → repeat.

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
