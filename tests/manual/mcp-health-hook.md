# Manual test: mcp-health-check hook

Tests for `scripts/hooks/mcp-health-check.sh` (GL #22 + #25).

All commands run from the plugin repo root. The hook reads stdin for event metadata; pass `/dev/null` for direct execution to exercise the `"unknown"` fallback path.

---

## 1. Healthy MCP

**Precondition:** trajectory-server is running (normal bro session active).

```bash
bash scripts/hooks/mcp-health-check.sh </dev/null
echo "exit=$?"
tail -1 ~/.claude/tmb/logs/mcp-health.log
```

**Expected:**
- stdout: empty (no warning)
- exit: 0
- JSONL tail line: `mcp_alive:true`, `pgrep_count` >= 1

Sample:
```
{"ts":"2026-04-28T05:10:00Z","event":"unknown","mcp_alive":true,"pgrep_count":2,"db_path":"/Users/Zax/Git/GitHub/TMB/.claude/tmb/trajectory.db"}
```

---

## 2. Dead MCP

**Setup:** kill the trajectory-server process.

```bash
pkill -f 'trajectory-server/dist/index.js' || true
bash scripts/hooks/mcp-health-check.sh </dev/null
echo "exit=$?"
tail -1 ~/.claude/tmb/logs/mcp-health.log
```

**Expected:**
- stdout: valid JSON `additionalContext` warning containing "MCP trajectory-server appears disconnected"
- exit: 0
- JSONL tail line: `mcp_alive:false`, `pgrep_count:0`

Sample stdout:
```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"⚠️ MCP trajectory-server appears disconnected. State at /Users/Zax/Git/GitHub/TMB/.claude/tmb/trajectory.db is intact. Recovery: kill any zombie 'node ... trajectory-server' processes, then quit + relaunch Claude Code. See docs/SELF_DEV.md for full procedure."}}
```

**After confirming:** quit + relaunch Claude Code to restore MCP.

---

## 3. Missing `pgrep`

Strip `pgrep` from PATH and run the hook.

```bash
PATH=/usr/bin/printf bash scripts/hooks/mcp-health-check.sh </dev/null
echo "exit=$?"
tail -1 ~/.claude/tmb/logs/mcp-health.log
```

**Expected:**
- stdout: empty (silent no-op)
- exit: 0
- JSONL tail line: `mcp_alive:null`, `pgrep_count:-1`

Sample:
```
{"ts":"2026-04-28T05:10:02Z","event":"unknown","mcp_alive":null,"pgrep_count":-1,"db_path":"/Users/Zax/Git/GitHub/TMB/.claude/tmb/trajectory.db"}
```

---

## 4. Log content sample

After running cases 1 and 2, the last two lines of `~/.claude/tmb/logs/mcp-health.log` will look like:

**Case 1 (healthy MCP):**
```
{"ts":"2026-04-28T05:10:00Z","event":"unknown","mcp_alive":true,"pgrep_count":2,"db_path":"/Users/Zax/Git/GitHub/TMB/.claude/tmb/trajectory.db"}
```

**Case 2 (dead MCP):**
```
{"ts":"2026-04-28T05:10:01Z","event":"unknown","mcp_alive":false,"pgrep_count":0,"db_path":"/Users/Zax/Git/GitHub/TMB/.claude/tmb/trajectory.db"}
```

Fields present in every line:
- `ts` — ISO 8601 UTC timestamp
- `event` — hook event name (`SessionStart`, `UserPromptSubmit`, or `unknown` when stdin yields no event)
- `mcp_alive` — `true` / `false` / `null` (unquoted JSON booleans/null)
- `pgrep_count` — integer process count (-1 when `pgrep` unavailable)
- `db_path` — resolved trajectory DB path for the active project

This shape is stable for downstream parsing (e.g., `jq 'select(.mcp_alive == false)'`).
