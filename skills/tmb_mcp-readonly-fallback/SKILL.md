---
name: tmb_mcp-readonly-fallback
description: Readonly sqlite3 fallback for the 7 most-used trajectory-server read tools when MCP is dead. Load ONLY when an mcp__plugin_tmb_* tool returns is_error=true with content matching "no matching deferred tools" OR "trajectory-server" is identified as unreachable by tmb_mcp-error-handling. Do NOT load on unrelated MCP errors (forbidden, validation, constraint).
allowed-tools: Bash(plugin/scripts/bro-sqlite-readonly.sh:*)
---

# mcp-readonly-fallback

## When to load

This skill activates in exactly two situations:

1. An `mcp__plugin_tmb_*` tool call returns `is_error: true` and the content matches the shape `"no matching deferred tools"` — indicating the MCP trajectory-server child process is not running.
2. The `tmb_mcp-error-handling` skill has already identified the trajectory-server as unreachable in this session.

Do NOT load for:
- `{"error": "forbidden"}` — that's a role-scope violation; use `tmb_mcp-error-handling`
- `{"error": "validation"}` or constraint failures — those mean the MCP server IS running but rejected bad input
- Errors from other MCP servers (not `mcp__plugin_tmb_*`)

## Degraded-mode notice (mandatory)

Before using any fallback, surface to the Human:

> **MCP trajectory-server is unreachable.** Falling back to direct sqlite3 reads. Writes are blocked in degraded mode. To restore full functionality: kill any zombie node process (`pkill -f 'trajectory-server/dist/index.js'`) then restart Claude Code. See skill `tmb_mcp-error-handling` for the full procedure.

Only surface this once per session — not on every fallback call.

## Supported read tools (fallbacks available)

| MCP tool | Bash invocation |
|---|---|
| `issue_resume` | `bro-sqlite-readonly.sh issue_resume '{"issue_id":"<N>"}'` |
| `issue_get` | `bro-sqlite-readonly.sh issue_get '{"issue_id":"<N>"}'` |
| `issue_get_phase` | `bro-sqlite-readonly.sh issue_get_phase '{"issue_id":"<N>"}'` |
| `task_get` | `bro-sqlite-readonly.sh task_get '{"task_id":"<N>"}'` |
| `task_first_actionable` | `bro-sqlite-readonly.sh task_first_actionable '{"issue_id":"<N>"}'` |
| `config_get` | `bro-sqlite-readonly.sh config_get '{"key":"<key>"}'` |
| `config_list` | `bro-sqlite-readonly.sh config_list '{}'` |

## How bro invokes the fallback

```bash
plugin/scripts/bro-sqlite-readonly.sh <tool_name> '<json_args>'
```

Parse the stdout as JSON. Treat it as if it came from the MCP tool — same keys, same field types. If the script exits non-zero, surface the error JSON to the Human.

Examples:

```bash
plugin/scripts/bro-sqlite-readonly.sh issue_resume '{"issue_id":"88"}'
plugin/scripts/bro-sqlite-readonly.sh task_get '{"task_id":"7"}'
plugin/scripts/bro-sqlite-readonly.sh config_get '{"key":"branching_model"}'
plugin/scripts/bro-sqlite-readonly.sh config_list '{}'
```

## Logging

Every fallback fire appends a JSONL line to `~/.claude/tmb/logs/mcp-health.log` (the user's home log dir):

```json
{"ts":"<ISO8601>","kind":"fallback","tool":"<tool_name>","agent":"bro"}
```

The script handles this automatically when the log directory exists. Bro does not need to write the log entry manually.

## Write tools — refuse immediately

Any tool not in the supported list above MUST be refused. The script returns:

```json
{
  "error": "degraded-mode-readonly",
  "requested": "<tool_name>",
  "recovery": "MCP is dead. Kill zombie: pkill -f 'trajectory-server/dist/index.js' then restart Claude Code."
}
```

Do NOT attempt to implement writes via direct sqlite3. Writes require the MCP server's transaction guarantees and role enforcement. Surface the refusal to the Human and direct them to restore MCP.

## Recovery guidance

Degraded mode is not steady state. After every fallback use, remind the Human:

1. `pkill -f 'trajectory-server/dist/index.js'` — kill zombie node process
2. Restart Claude Code — MCP server re-spawns on fresh session
3. Verify: first `mcp__plugin_tmb_*` call should succeed (no `is_error`)

Full doctrine: skill `tmb_mcp-error-handling`.
