---
name: tmb_recovery
description: Bro's response when something fails — AskUserQuestion errors / TMB_HEADLESS=1 (use the documented per-skill default + audit), MCP tool returns is_error=true (halt + surface, don't silently proceed), or the trajectory-server is unreachable (degraded sqlite3 readonly fallback). Loaded reactively on the first failure of a session. Self-contained — defaults table + tool list inline.
allowed-tools: Bash(skills/tmb_recovery/scripts/bro-sqlite-readonly.sh:*), mcp__plugin_tmb_trajectory-server__headless_fallback_record, mcp__plugin_tmb_trajectory-server__audit_log, mcp__plugin_tmb_trajectory-server__discussion_append
---

# Recovery — three failure modes, three responses

Bro keeps the user-visible flow moving on recoverable errors. Each failure class has a deterministic fallback path; the judgment is *which class applies* and *what default to pick* per skill.

The bundled script `scripts/bro-sqlite-readonly.sh` is for §C (trajectory-server unreachable). Invoke it via Bash — use it as a black box, not by reading its source directly.

## A. AskUserQuestion error / TMB_HEADLESS=1

`AskUserQuestion` is the only tool bro uses to consult the Human. When the call returns an error OR `TMB_HEADLESS=1` is set, there's no Human in the loop. **Bro halting here is a bug** — produce an audit trail with the documented default instead.

### Protocol

1. **Look up the documented default** for that question (table below). If the calling skill has no documented default, that's a doctrine bug — log it and halt that specific skill (not bro overall).
2. **Record the fallback** — call `headless_fallback_record` with the skill, the question, and the default you chose. It writes the audit event and the discussion note atomically, and the deny hook names it on failure.
3. **Continue the skill's flow** with the default as if the Human typed it.

### Per-skill defaults

| Skill / form | Default | Reason |
|---|---|---|
| `tmb_planning` base-branch AUQ | `${pr_target}` | Matches the project's configured branching model. |
| `tmb_planning` branch-id confirm | "Yes, proceed" | Bro already chose intelligently from project context. |
| `tmb_planning` difficult Q+A | "proceed as proposed" | ADR is still authored; the deliberate-decision marker survives. |
| `tmb_review` push-fail resolution | "Abort push" | Half-fixed work shouldn't ship without Human review. |
| `tmb_review` PR/MR resolution | (halt — error out cleanly) | No safe default for "which PR?" |
| `roundtable` agreements ratification | Ratify all agreements | Unanimous + uncontested; safe to proceed. |
| `roundtable` disagreements resolution | Skip + file follow-up issue | No Human → no safe casting vote; log and continue. |
| `roundtable` follow-up questions | Skip (no issue created) | Headless mode cannot scope new work interactively. |

### Exception — file-writing skills

`tmb_skill-creator` and `/tmb:agent-create` (from-scratch mode) HALT in headless mode rather than apply a default. Silent skill/agent generation in CI is the foot-gun this rule guards against:

Record an audit event noting which creator was blocked and the proposed name, then surface: "Cannot create skill/agent in headless mode — re-run interactively."

## B. MCP tool returns is_error=true

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
| `no matching deferred tools` | The MCP child process is dead. | Switch to degraded mode (§C). |

## C. Trajectory-server unreachable

Two distinct failure modes — `mcp-health-check.sh` writes `"mode":"A"` or `"mode":"B"` into `~/.claude/tmb/logs/mcp-health.log` and emits a mode-specific `additionalContext` warning so the surface message tells you which one you have.

### C.1 — MCP absent this session (Mode A)

The plugin's MCP server is missing from CC's resolved-plugin list — `/reload-plugins` and full quit + relaunch won't fix it because CC persists the cached config to disk. The `additionalContext` warning injected by `mcp-health-check.sh` at session start tells you if you're in Mode A.

<!-- LOAD-BEARING-SAFETY: halt-on-Mode-A is mandatory — state-writing tools are unreachable and silent degradation corrupts the audit trail -->
**During the failure, bro halts.** State-writing tools are unreachable; halt to avoid corrupting the audit trail. Read-only sqlite3 fallback (`bro-sqlite-readonly.sh`) is still available for emergency reads.

Recovery escalation — try IN ORDER, stop at the first that brings MCP back:

1. `claude --plugin-dir <plugin-source>` — re-resolves the MCP config from disk with the plugin cache cleared.
2. `/plugin uninstall tmb@trustmybot-rc`, quit CC fully, reinstall via `/plugin install tmb@trustmybot-rc`.
3. `scripts/maintenance/heal-mcp-cache.sh` — interactive cache nuke with dry-run preview.

### C.2 — MCP died mid-session (Mode B)

The MCP child process was alive at session start but is now gone. Distinct from Mode A: CC's plugin list is correct; the process just needs to be re-spawned. The `additionalContext` from `mcp-health-check.sh` distinguishes Mode B from Mode A and from §B errors (forbidden/validation/constraint — those mean the server IS running and rejected bad input).

**Read fallback:** `${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh <tool_name> [json_args]`. Run `--list` to see supported tools. Parse stdout as JSON — same shape as the corresponding MCP tool. Write tools are refused with a structured error; surface the refusal to the Human.

**Recovery:**

1. `pkill -f 'trajectory-server/dist/index.js'` — kill zombie node.
2. Restart Claude Code — server re-spawns on fresh session.
3. If the first `mcp__plugin_tmb_*` call still fails, the failure has escalated into Mode A — follow C.1.
