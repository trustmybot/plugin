# Manual test: mcp-health-check hook

Tests for `scripts/hooks/mcp-health-check.sh` (GL #22 + #25 + #2888).

All commands run from the plugin repo root. The hook reads stdin for event metadata; pass `/dev/null` for direct execution to exercise the `"unknown"` event fallback path (mode classification falls back to B in that case).

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
- JSONL tail line: `mcp_alive:true`, `pgrep_count` >= 1, `mode:null`

Sample:
```
{"ts":"2026-05-15T05:10:00Z","event":"unknown","mcp_alive":true,"pgrep_count":2,"mode":null,"session_id":"unknown","db_path":"/Users/Zax/Git/GitHub/TMB/.claude/tmb/trajectory.db"}
```

---

## 2. Mode A — MCP never spawned this session

**Setup:** simulate a SessionStart fire with MCP dead. The hook writes Mode A to `mcp-health.state` so subsequent UserPromptSubmit fires in the same session stay classified as A.

```bash
pkill -f 'trajectory-server/dist/index.js' || true
bash scripts/hooks/mcp-health-check.sh <<'EOF'
{"hookEventName":"SessionStart","session_id":"manual-test-A"}
EOF
echo "exit=$?"
tail -1 ~/.claude/tmb/logs/mcp-health.log
cat ~/.claude/tmb/logs/mcp-health.state
```

**Expected:**
- stdout: JSON `additionalContext` containing "MCP trajectory-server NEVER STARTED" and the three-step recovery escalation
- exit: 0
- JSONL tail line: `"event":"SessionStart","mcp_alive":false,"mode":"A"`
- state file: `{"last_session_id":"manual-test-A","last_alive_at_session_start":false}`

Re-fire as UserPromptSubmit in the same session — still Mode A:

```bash
bash scripts/hooks/mcp-health-check.sh <<'EOF'
{"hookEventName":"UserPromptSubmit","session_id":"manual-test-A"}
EOF
tail -1 ~/.claude/tmb/logs/mcp-health.log
```

**Expected:** JSONL tail line has `"event":"UserPromptSubmit","mode":"A"`.

---

## 3. Mode B — MCP died mid-session

**Setup:** SessionStart fires while MCP is alive (so state records `last_alive_at_session_start:true`), then MCP dies, then UserPromptSubmit fires.

```bash
# Start with MCP alive (open any bro session in another terminal, or just trust state already shows alive).
bash scripts/hooks/mcp-health-check.sh <<'EOF'
{"hookEventName":"SessionStart","session_id":"manual-test-B"}
EOF
# Now kill MCP and fire UserPromptSubmit
pkill -f 'trajectory-server/dist/index.js'
bash scripts/hooks/mcp-health-check.sh <<'EOF'
{"hookEventName":"UserPromptSubmit","session_id":"manual-test-B"}
EOF
tail -1 ~/.claude/tmb/logs/mcp-health.log
```

**Expected:**
- stdout: JSON `additionalContext` containing "MCP trajectory-server is no longer reachable (was alive earlier this session)"
- exit: 0
- JSONL tail line: `"event":"UserPromptSubmit","mcp_alive":false,"mode":"B"`

**After confirming:** quit + relaunch Claude Code to restore MCP.

---

## 4. Missing `pgrep`

Strip `pgrep` from PATH and run the hook.

```bash
PATH=/usr/bin/printf bash scripts/hooks/mcp-health-check.sh </dev/null
echo "exit=$?"
tail -1 ~/.claude/tmb/logs/mcp-health.log
```

**Expected:**
- stdout: empty (silent no-op)
- exit: 0
- JSONL tail line: `mcp_alive:null`, `pgrep_count:-1`, `mode:null`

---

## 5. Log content sample

After running cases 1-3, the last several lines of `~/.claude/tmb/logs/mcp-health.log` will include:

```
{"ts":"2026-05-15T05:10:00Z","event":"unknown","mcp_alive":true,"pgrep_count":2,"mode":null,"session_id":"unknown","db_path":"…/trajectory.db"}
{"ts":"2026-05-15T05:10:01Z","event":"SessionStart","mcp_alive":false,"pgrep_count":0,"mode":"A","session_id":"manual-test-A","db_path":"…/trajectory.db"}
{"ts":"2026-05-15T05:10:02Z","event":"UserPromptSubmit","mcp_alive":false,"pgrep_count":0,"mode":"A","session_id":"manual-test-A","db_path":"…/trajectory.db"}
{"ts":"2026-05-15T05:10:03Z","event":"UserPromptSubmit","mcp_alive":false,"pgrep_count":0,"mode":"B","session_id":"manual-test-B","db_path":"…/trajectory.db"}
```

Fields present in every line:
- `ts` — ISO 8601 UTC timestamp
- `event` — hook event name (`SessionStart`, `UserPromptSubmit`, or `unknown` when stdin yields no event)
- `mcp_alive` — `true` / `false` / `null` (unquoted JSON booleans/null)
- `pgrep_count` — integer process count (-1 when `pgrep` unavailable)
- `mode` — `"A"` / `"B"` / `null` (only set when `mcp_alive=false`)
- `session_id` — CC session id from hook input JSON, or `unknown` fallback
- `db_path` — resolved trajectory DB path for the active project

This shape is stable for downstream parsing (e.g., `jq 'select(.mode == "A")'` filters Mode A hits).
