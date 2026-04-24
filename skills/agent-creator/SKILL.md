---
name: agent-creator
description: Interactively propose and create a new domain agent in the user's workspace. Always requires explicit user approval before writing.
agent: architect
allowed-tools: Read, Glob, Grep, Write
---

# agent-creator

## A. Purpose

On-demand agent generation for domain roles not covered by the existing core
roster. Preserves the plugin's agent-factory nature: the plugin ships a
backbone, users extend it. Every creation requires explicit user approval —
auto-creation is never permitted.

## B. When Invoked

Bro (routing-time) or architect (task-breakdown-time) invokes this
skill when ALL of the following hold:

1. The user's request cannot be served by the 4 global workflow agents
   (bro, architect, swe, pr-reviewer) or any user-created agent
   already present in the project's `.claude/agents/`.
2. The user explicitly wants a **named, persistent role** — not an ad-hoc
   Task spawn.
3. The role does not already exist in `.claude/agents/`.

Do NOT invoke for one-off sub-tasks that a Task tool spawn can handle.

## C. Reserved Names

The following agent names are reserved for the plugin core and MUST NOT be
used for new domain agents. If the user requests one of these names, refuse
immediately and ask for a different name:

- `bro`
- `architect`
- `swe`
- `pr-reviewer`

## D. Execution Steps

### Step 1 — Discover the gap

Ask the user at most **3 clarifying questions** in a single message:

1. What role/title should this agent have?
2. What are its core responsibilities? (What should it do that no existing
   agent covers?)
3. Which existing agent is closest, and what gap does the new agent fill?

Wait for answers before proceeding. Do NOT draft a proposal until you have
answers to all three.

### Step 2 — Read the context

After the user answers:

1. Glob `.claude/agents/` to list all existing agent files. If the directory
   does not exist, note that it will be created on write.
2. Check for a name collision: if `.claude/agents/<proposed-name>.md` already
   exists, pause and proceed to the overwrite flow in Section E.
3. Glob the project's top-level files (e.g. `package.json`, `pyproject.toml`,
   `Cargo.toml`, `go.mod`, `*.md`) to understand the stack and domain.

### Step 3 — Draft a proposal

Produce a complete agent file using the schema below. Every field is required
unless marked optional.

```
---
name: <snake_case>
description: <one sentence: role and primary capability>
model: sonnet                          # default; use opus only for reasoning-heavy roles
tools: <comma-separated allowlist>     # minimum viable set for the role
memory: false                          # true only if the agent needs cross-session context; justify in body
---

# <Title — Human-Readable Name>

[Role description: who this agent is, what it owns, what it does NOT do]

## Responsibilities

[Bulleted list of concrete responsibilities]

## Reporting / Collaboration

[Who spawns this agent, who it reports to, which other agents it coordinates with]

## Constraints

[What this agent must never do — especially around source code access]
```

Field guidance:

- `name`: snake_case, no hyphens in the agent identity (hyphens allowed in
  filename only).
- `model`: default `sonnet`. Use `opus` only for roles that require deep
  multi-step reasoning (e.g. legal-reviewer analyzing full contracts). Justify
  in a comment.
- `tools`: minimum viable set. Start from `Read, Glob, Grep`. Add `Write`
  only if the agent produces output files. Add `Bash` only if the agent needs
  to run commands. Add `Edit` only if the agent modifies existing files.
- `memory`: default `false`. Set `true` only if the agent needs cross-session
  context; if set, add a brief justification in the body.
- Do NOT add `isolation` or `disallowedTools` fields unless the agent writes
  source code (see edge case in Section F).

### Step 4 — Show and ask (mandatory)

Present the full drafted file in a fenced code block, then ask verbatim:

> "Do you want me to create this agent? It will be written to
> `.claude/agents/<name>.md` and available in future sessions. (yes/no)"

Do NOT write anything until the user responds.

### Step 5 — Write on approval

- On explicit **"yes"** (or equivalent clear affirmative: "go ahead", "do it",
  "approved"): proceed to Step 6.
- On **"no"**, silence, or anything ambiguous: abort. Inform the user that no
  file was written and offer to revise the proposal if they want.

### Step 6 — Write the file

1. If `.claude/agents/` does not exist, create it as part of the Write
   (the Write tool creates intermediate directories automatically — confirm
   the full path resolves correctly).
2. Write the file to `.claude/agents/<name>.md`.
3. NEVER write to `plugin/agents/` or any path inside the plugin install
   directory. The plugin is read-only at runtime.

### Step 7 — Verify

After the write, confirm the file exists by reading its first 5 lines. Print
the final absolute path so the user knows exactly where the agent lives.

## E. Error Handling

| Trigger | Response |
|---|---|
| User answer is ambiguous (can't determine role/name) | Do NOT proceed. Ask again with a concrete yes/no or fill-in-the-blank prompt. |
| Target `.claude/agents/<name>.md` already exists | Read the existing file. Show a unified diff of proposed vs existing content. Ask: "This agent already exists. Do you want to overwrite it? (yes/no)" |
| Workspace has no `.claude/agents/` directory | Create the directory as part of the Write step. Note this in the confirmation message. |
| User requests a reserved core name | Refuse: "The name `<name>` is reserved for a plugin core agent. Please choose a different name." Then re-ask Step 1 question 1. |
| User attempts to skip Step 4 (proposal + approval) | Refuse: "Explicit approval is required before writing any agent file. I cannot skip this step." |

## F. Edge Cases

**User wants a code-writing agent (e.g. `backend-swe`, `ml-engineer`)**

Propose with these additional fields in the frontmatter:

```
isolation: worktree
```

Explain to the user: "This agent will write source code, so it needs worktree
isolation (same as the core SWE agent). I've added the `isolation: worktree`
field." Require explicit approval as normal.

**User wants an agent with broader cross-session context**

Propose with `memory: true`. Warn the user: "Setting `memory: true` gives this
agent broader context than SWE-level agents. It will be able to read and
retain cross-session information. Is that intentional?"

**User wants to skip the proposal step**

Refuse. State: "The proposal and explicit approval step is non-negotiable. It
ensures you always know exactly what will be written to your workspace before
it happens."

**User wants to overwrite an existing agent without reviewing the diff**

Always show the diff first. Do not allow blind overwrites.
