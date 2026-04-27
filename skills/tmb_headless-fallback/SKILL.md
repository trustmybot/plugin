---
name: tmb_headless-fallback
description: How bro handles AskUserQuestion errors and TMB_HEADLESS=1 mode — use documented per-skill defaults, audit every fallback to ledger + discussion, never silently accept and never halt. Loaded reactively the first time AskUserQuestion errors in a session.
agent: bro
allowed-tools: mcp__plugin_tmb_trajectory-server__ledger_log, mcp__plugin_tmb_trajectory-server__discussion_append
---

# headless-fallback

## Purpose

`AskUserQuestion` is the only tool bro uses to consult the Human directly. In headless contexts (`claude -p`, CI runs, automated agents) there is no Human in the loop — the call returns an error. This skill defines the protocol bro must follow when that happens.

**Bro must never halt on an `AskUserQuestion` error.** A halted bro produces no audit trail and no result; an autonomous bro using a documented default produces both.

## When to apply

Either condition triggers the fallback path:

- The `AskUserQuestion` call itself returns an error (e.g. "tool errored on both attempts")
- The env var `TMB_HEADLESS=1` is set (skip the call entirely, go straight to fallback)

## Protocol

For every `AskUserQuestion` call in any skill:

1. **Look up the documented default** for that question. Every skill that calls `AskUserQuestion` MUST list defaults under its own `## Headless fallback` section. If the calling skill has no documented default for a question, that's a doctrine bug — log it and halt that specific skill (not bro overall).

2. **Record the fallback to the trajectory DB with TWO writes** — both are required:

   ```
   ledger_log(
     agent='bro',
     event_type='headless_fallback',
     summary='<skill_name>: <question_short> → <chosen_default>'
   )

   discussion_append(
     agent='bro',
     kind='note',
     body='Headless fallback: <skill> asked "<question>", no Human in loop, defaulted to <default>. Reason: <one-line>.'
   )
   ```

3. **Continue the skill's flow** with the default value as if the Human had typed it.

## Why both writes

- `ledger.event_type='headless_fallback'` — searchable evidence trail. `SELECT * FROM ledger WHERE event_type='headless_fallback'` reconstructs every autonomous decision.
- `discussions` entry — human-readable narrative for post-mortem.

A fallback without both writes is a bug. The audit trail is non-negotiable.

## Exception — file-writing skills

`tmb_skill-creator` and `tmb_agent-creator` write new files into the project tree. Auto-approving silent skill/agent generation in CI is the foot-gun this rule guards against. They MUST halt with:

```
ledger_log(
  agent='bro',
  event_type='headless_creator_blocked',
  summary='<creator>: cannot create <name> without Human approval in headless mode.'
)
```

…and a clear surface message: "Cannot create skill/agent in headless mode. Re-run interactively, or write the file directly if you know what you want."

## Never

- Silently fall back without the ledger + discussion writes.
- Halt the whole bro flow on a single `AskUserQuestion` error — only the calling skill halts (creator skills) or proceeds with a default (everything else).
- Use a default for a question that has no documented fallback in the calling skill.
