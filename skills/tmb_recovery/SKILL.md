---
name: tmb_recovery
description: Bro's response when something fails — AskUserQuestion errors / TMB_HEADLESS=1 (use the documented per-skill default + audit), MCP tool returns is_error=true (halt + surface, don't silently proceed), or the trajectory-server is unreachable (degraded sqlite3 readonly fallback). Loaded reactively on the first failure of a session. Self-contained — defaults table + tool list inline.
allowed-tools: Bash(skills/tmb_recovery/scripts/bro-sqlite-readonly.sh:*), mcp__plugin_tmb_trajectory-server__audit_log, mcp__plugin_tmb_trajectory-server__discussion_append
---

# Recovery — three failure modes, three responses

Bro never halts the user-visible flow on a recoverable error. Each failure class has a deterministic fallback path; the judgment is *which class applies* and *what default to pick* per skill.

The bundled script `scripts/bro-sqlite-readonly.sh` is for §C (trajectory-server unreachable). The LLM never reads it directly; it's invoked via Bash.

## A. AskUserQuestion error / TMB_HEADLESS=1

`AskUserQuestion` is the only tool bro uses to consult the Human. When the call returns an error OR `TMB_HEADLESS=1` is set, there's no Human in the loop. **Bro halting here is a bug** — produce an audit trail with the documented default instead.

### Protocol

1. **Look up the documented default** for that question (table below). If the calling skill has no documented default, that's a doctrine bug — log it and halt that specific skill (not bro overall).
2. **Record both writes** — required, not optional:
   ```
   audit_log(agent='bro', kind='event', event_type='headless_fallback', summary='<skill_name>: <question_short> → <chosen_default>')
   discussion_append(agent='bro', kind='note', body='Headless fallback: <skill> asked "<question>", no Human in loop, defaulted to <default>. Reason: <one-line>.')
   ```
   For `issue_id`: use the parent issue of the calling skill when one exists; otherwise use the system issue (`issue_id='-1'`, seeded for system-level events that have no parent issue). Never invent a placeholder string — `audit` and `discussions` enforce a FK to `issues`.
3. **Continue the skill's flow** with the default as if the Human typed it.

### Per-skill defaults

| Skill / form | Default | Reason |
|---|---|---|
| `tmb_planning` cold-start AUQ | Lazy fill | Cold-start scan is token-heavy; lazy is safer in CI. |
| `tmb_planning` base-branch AUQ | `${pr_target}` | Matches the project's configured branching model. |
| `tmb_planning` branch-id confirm | "Yes, proceed" | Bro already chose intelligently from project context. |
| `tmb_planning` difficult Q+A | "proceed as proposed" | ADR is still authored; the deliberate-decision marker survives. |
| `tmb_review` push-fail resolution | "Abort push" | Half-fixed work shouldn't ship without Human review. |
| `tmb_review` PR/MR resolution | (halt — error out cleanly) | No safe default for "which PR?" |

### Exception — file-writing skills

`tmb_skill-creator` and `tmb_agent-creator` (from-scratch mode) HALT in headless mode rather than apply a default. Silent skill/agent generation in CI is the foot-gun this rule guards against:

```
audit_log(agent='bro', kind='event', event_type='headless_creator_blocked',
          summary='<creator>: cannot create <name> without Human approval in headless mode.')
```

Plus a clear surface message: "Cannot create skill/agent in headless mode. Re-run interactively, or write the file directly if you know what you want."

## B. MCP tool returns is_error=true

When any MCP call result has `is_error: true` or content includes `{"error": ...}`, the call was wrong — not the doctrine.

### Protocol

1. **Halt the current flow immediately.** Don't chain subsequent calls as if the failed one succeeded.
2. **Pick one path** based on the error class:
   - **Surface verbatim** to the Human and ask how to proceed, OR
   - **If recoverable AND you know the corrected call**, write `discussion_append(kind='note', body='Recovered from MCP error: <error_text>. Retrying with <corrected_call>.')` and retry.

### Error classification

| Error shape | Meaning | Right response |
|---|---|---|
| `forbidden` | Bro called a tool scoped to another role. | Reconsider whether the action is bro's responsibility. Don't retry the same call signature. |
| `validation` | Input didn't match the schema (e.g. malformed branch_id). | Fix the input. Retry with the corrected payload. |
| Constraint failure | DB integrity violation (foreign key, unique). | Surface to Human; usually means a stale or duplicate write attempt. |
| `no matching deferred tools` | The MCP child process is dead. | Switch to degraded mode (§C). |

## C. Trajectory-server unreachable

Two distinct failure modes — `mcp-health-check.sh` writes `"mode":"A"` or `"mode":"B"` into `~/.claude/tmb/logs/mcp-health.log` and emits a mode-specific `additionalContext` warning so the surface message tells you which one you have.

### C.1 — MCP never spawned this session (Mode A, issue #2888)

CC's plugin MCP-config cache wasn't invalidated after `/plugin disable` → re-enable or auto-update. The plugin's hooks/skills/agents load fine, but the MCP server is missing from CC's resolved-plugin list entirely — `/reload-plugins` does not fix it, and full quit + relaunch does not fix it either. CC persists the cached config to disk somewhere that survives process restart.

**Detection signal:** `mcp-health-check.sh` log line has `"event":"SessionStart","mcp_alive":false,"mode":"A"`, or any subsequent UserPromptSubmit in the same session keeps reporting `"mode":"A"`.

**Recovery escalation — try IN ORDER, stop at the first that brings MCP back:**

1. `claude --plugin-dir <plugin-source>` — forces `clearPluginCache: ... preAction: --plugin-dir inline plugins` and re-resolves the MCP config from disk.
2. `/plugin uninstall tmb@trustmybot-rc`, quit CC fully, reinstall via `/plugin install tmb@trustmybot-rc`.
3. Manual cache nuke: `rm -rf ~/.claude/plugins/cache/trustmybot-rc/` + remove the `tmb@trustmybot-rc` entry from `~/.claude/plugins/installed_plugins.json`, relaunch, reinstall. The `scripts/maintenance/heal-mcp-cache.sh` helper does this interactively with a dry-run preview.

**During the failure, bro MUST halt.** State-writing tools are unreachable; silent degradation would corrupt the audit trail. Read-only sqlite3 fallback (`bro-sqlite-readonly.sh`) is still available for emergency reads but write attempts will silently fail.

### C.2 — MCP died mid-session (Mode B, GL #22)

The MCP child process was alive at SessionStart but is now gone — crashed, OOM-killed, or `pkill`ed. Distinct from Mode A in that CC's resolved-plugin list is correct; the process just needs to be re-spawned.

**Detection signal:** an `mcp__plugin_tmb_*` tool returns `is_error: true` with content matching `"no matching deferred tools"`, OR `mcp-health-check.sh` log shows `"event":"UserPromptSubmit","mcp_alive":false,"mode":"B"`. This is distinct from `forbidden` / `validation` / constraint errors — those mean the server IS running and rejected bad input (use §B).

**Degraded-mode notice (mandatory, once per session):**

> **MCP trajectory-server is unreachable.** Falling back to direct sqlite3 reads. Writes are blocked. To restore: kill any zombie node process (`pkill -f 'trajectory-server/dist/index.js'`) then restart Claude Code. If a fresh restart doesn't recover MCP, you've crossed into Mode A — see C.1.

**Read fallback:** `${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh`. Parse stdout as JSON — same shape as the corresponding MCP tool.

| MCP tool | Bash invocation |
|---|---|
| `issue_resume` | `bro-sqlite-readonly.sh issue_resume '{"issue_id":"<N>"}'` |
| `issue_get` | `bro-sqlite-readonly.sh issue_get '{"issue_id":"<N>"}'` |
| `issue_get_phase` | `bro-sqlite-readonly.sh issue_get_phase '{"issue_id":"<N>"}'` |
| `task_get` | `bro-sqlite-readonly.sh task_get '{"task_id":"<N>"}'` |
| `task_first_actionable` | `bro-sqlite-readonly.sh task_first_actionable '{"issue_id":"<N>"}'` |
| `config_get` | `bro-sqlite-readonly.sh config_get '{"key":"<key>"}'` |
| `config_list` | `bro-sqlite-readonly.sh config_list '{}'` |

**Write tools — refused in degraded mode.** Any tool not in the read list returns:

```json
{
  "error": "degraded-mode-readonly",
  "requested": "<tool_name>",
  "recovery": "MCP is dead. Kill zombie: pkill -f 'trajectory-server/dist/index.js' then restart Claude Code."
}
```

Writes need MCP transaction guarantees + role enforcement. Surface the refusal to the Human.

**Recovery:**

1. `pkill -f 'trajectory-server/dist/index.js'` — kill zombie node.
2. Restart Claude Code — server re-spawns on fresh session.
3. Verify: first `mcp__plugin_tmb_*` call should succeed. If it doesn't, the failure has escalated into Mode A — follow C.1.
