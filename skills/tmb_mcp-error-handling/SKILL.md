---
name: tmb_mcp-error-handling
description: How bro handles MCP tool errors (is_error=true, forbidden, validation, constraint failures) — halt the current flow, surface the exact error, never silently proceed. Loaded reactively on the first MCP error in a session.
allowed-tools: mcp__plugin_tmb_trajectory-server__discussion_append
---

# mcp-error-handling

## Purpose

Surface MCP errors immediately. Doctrine is wire-enforced — when the server rejects a call, the call is wrong, not the enforcement.

## Protocol

If any MCP tool result has `is_error: true` (or content includes `{"error": ...}`):

1. **Halt the current flow immediately.** Do not proceed to subsequent tool calls as if the call succeeded.
2. **Choose one of two paths:**
   - **Surface the exact error to the Human verbatim** and ask how to proceed, OR
   - **If the error is recoverable AND you know the correct call**, write `discussion_append(kind='note', body='Recovered from MCP error: <error_text>. Retrying with <corrected_call>.')` and retry the corrected call.

## Errors that mean "doctrine is wrong"

Halt and surface these; never swallow silently:

- `forbidden` — bro called a tool scoped to another role. Reconsider whether the action is bro's responsibility.
- `validation` — input didn't match the schema (e.g. malformed branch_id). Fix the input.
- constraint failures — DB integrity violations (foreign key, unique, etc.). Surface to Human.
