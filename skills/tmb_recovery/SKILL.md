---
name: tmb_recovery
description: Bro's response when something fails — an MCP tool returns is_error=true (halt + surface, don't silently proceed), or the trajectory-server is unreachable (degraded sqlite3 readonly fallback). Loaded reactively on the first failure of a session.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh:*), mcp__plugin_tmb_trajectory-server__discussion_append
---

# Recovery — two failure modes, two responses

Bro keeps the user-visible flow moving on recoverable errors. Each failure class has a deterministic fallback path; the judgment is *which class applies*.

The bundled script `${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh` is for §B (trajectory-server unreachable). Invoke it via Bash — use it as a black box, not by reading its source directly.

## A. MCP tool returns is_error=true

When any MCP call result has `is_error: true` or content includes `{"error": ...}`, the call was wrong — not the doctrine.

### Protocol

1. **Halt the current flow immediately.** Treat the failed call as the chain's last.
2. **Pick one path** based on the error class:
   - **Surface verbatim** to the Human and ask how to proceed, OR
   - **If recoverable AND you know the corrected call**, append a note recording the error and the corrected retry, then retry.

### Error classification

| Error shape | Meaning | Right response |
|---|---|---|
| `forbidden` | Bro called a tool scoped to another role. | Reconsider whether the action is bro's responsibility. Change the call signature before retrying. |
| `validation` | Input didn't match the schema (e.g. malformed branch_id). | Fix the input. Retry with the corrected payload. |
| Constraint failure | DB integrity violation (foreign key, unique). | Surface to Human; usually means a stale or duplicate write attempt. |
| `no matching deferred tools` | The MCP child process is dead. | Switch to degraded mode (§B). |

## B. Trajectory-server unreachable

Two distinct sub-cases — read the `additionalContext` warning from `mcp-health-check.sh` at session start to tell which one you have.

### B.1 — MCP absent this session

The plugin's MCP server is missing from CC's resolved-plugin list — `/reload-plugins` and full quit + relaunch won't fix it because CC persists the cached config to disk.

<!-- LOAD-BEARING-SAFETY: halt-on-B.1 (MCP absent) is mandatory — state-writing tools are unreachable and silent degradation corrupts the audit trail -->
**During the failure, bro halts.** State-writing tools are unreachable; halt to avoid corrupting the audit trail. Read-only sqlite3 fallback (`${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh`) is still available for emergency reads.

Recovery escalation — try IN ORDER, stop at the first that brings MCP back:

1. `/plugin uninstall tmb@<your-marketplace>`, quit CC fully, then reinstall from your marketplace via `/plugin install tmb@<your-marketplace>` — the marketplace-valid remedy (a standard install has only `~/.claude/plugins/cache/`, no plugin source on disk).
2. Dev-only: if you have the plugin source checked out, `claude --plugin-dir <plugin-source>` re-resolves the MCP config from disk with the plugin cache cleared.

### B.2 — MCP died mid-session

The MCP child process was alive at session start but is now gone — CC's plugin list is correct; the process just needs to be re-spawned. (`forbidden`/`validation`/`constraint` errors are §A, not this — they mean the server IS running and rejected bad input.)

**Read fallback:** `${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh <tool_name> [json_args]`. Run `--list` to see supported tools. Parse stdout as JSON — same shape as the corresponding MCP tool. Write tools are refused with a structured error; surface the refusal to the Human.

**Recovery:**

1. Kill only THIS project's zombie server — identify it by the `trajectory.db` it holds open, never a machine-wide match that would take down every project's server:
   ```bash
   DB=$(${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh --dry-run \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["db_path"])')
   PIDS=$(lsof -t "$DB" 2>/dev/null); [ -n "$PIDS" ] && kill $PIDS
   ```
2. Restart Claude Code — server re-spawns on fresh session.
3. If the first `mcp__plugin_tmb_*` call still fails, the failure has escalated into the MCP-absent case — follow B.1.
