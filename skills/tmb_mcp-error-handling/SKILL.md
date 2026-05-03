---
name: tmb_mcp-error-handling
description: How bro handles MCP tool errors (is_error=true, forbidden, validation, constraint failures) — halt the current flow, surface the exact error, never silently proceed. Loaded reactively on the first MCP error in a session.
agent: bro
allowed-tools: mcp__plugin_tmb_trajectory-server__discussion_append
---

# mcp-error-handling

## Purpose

The MCP trajectory server enforces role-based access control via the `requireRoles` middleware in `mcp/trajectory-server/src/middleware/agent-scope.ts`. When bro calls a tool it shouldn't (e.g. `validation_record`, which is pr-reviewer-only), the server returns `{"error": "forbidden"}`. Same for validation failures, constraint violations, and other errors.

**Doctrine isn't just prompt discipline — it's wire-enforced.** When the server rejects a call, it means the doctrine you're following is wrong, not that you should retry blindly or pretend success.

## Protocol

If any MCP tool result has `is_error: true` (or content includes `{"error": ...}`):

1. **Halt the current flow immediately.** Do NOT proceed to subsequent tool calls as if the call succeeded.
2. **Choose one of two paths:**
   - **Surface the exact error to the Human verbatim** and ask how to proceed, OR
   - **If the error is recoverable AND you know the correct call**, write `discussion_append(kind='note', body='Recovered from MCP error: <error_text>. Retrying with <corrected_call>.')` and retry the corrected call.

## Errors that mean "doctrine is wrong"

Never silently swallow these:

- `forbidden` — bro called a tool scoped to another role. Reconsider whether the action is bro's responsibility.
- `validation` — input didn't match the schema (e.g. malformed branch_id). Fix the input.
- constraint failures — DB integrity violations (foreign key, unique, etc.). Surface to Human.

## Tools bro must NEVER call

These are scoped to other roles by `requireRoles`. Calling them as `agent='bro'` returns `forbidden`:

- `validation_record` — pr-reviewer only. Bro's task-gate verification writes `audit_log(kind='event', event_type='bro_verification_pass', ...)` instead.
- Any consultant-decision tool — consultants don't write decisions either, so this is enforced by absence.
- `config_set` on policy keys (`branching_model`, `pr_target`, `protected_branches`) — these drive `git-guards.sh` and other hooks. Mid-session policy changes without re-confirming intent is a foot-gun. Use `tmb_reonboard` skill instead, which renders an `AskUserQuestion` radio with the current value pre-selected and persists only after explicit confirmation.

## Never

- Silently retry a `forbidden` error with the same call.
- Fabricate a successful result narrative when the call errored.
- Continue a multi-step flow past an error without surface or recovery.
