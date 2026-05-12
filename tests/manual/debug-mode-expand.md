# Manual test: debug-mode-expand

Reproducible test recipe for the file-based logging added in the `feat/debug-mode-expand` PR. Run from a working plugin checkout with `dist/` built.

Prerequisites: `cd mcp/trajectory-server && npm run build` must succeed.

---

## 1. MCP-server log (always-on)

Verify that startup, tool entry/exit, and shutdown entries land in `mcp-server.log` unconditionally.

```bash
rm -f ~/.claude/tmb/logs/mcp-server.log ~/.claude/tmb/logs/sql.log

(
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"identity_get","arguments":{"agent":"bro"}}}'
  sleep 0.5
) | TRAJECTORY_DB_PATH=/tmp/debug-smoke.db \
    node --experimental-sqlite dist/index.js 2>/dev/null

rm -f /tmp/debug-smoke.db

tail -5 ~/.claude/tmb/logs/mcp-server.log
```

Expected `mcp-server.log` entries (one JSONL object per line):
- `{"kind":"startup","pid":<N>,"version":"0.6.0-rc.1","db_path":"/tmp/debug-smoke.db","ts":"..."}`
- `{"kind":"tool_entry","tool":"identity_get","agent":"bro","ts":"..."}`
- `{"kind":"tool_exit","tool":"identity_get","agent":"bro","is_error":false,"duration_ms":<N>,"ts":"..."}`

Validate JSONL:
```bash
python3 -c "import json; [json.loads(l) for l in open('$HOME/.claude/tmb/logs/mcp-server.log')]" && echo "mcp-server JSONL valid"
```

---

## 2. SQL log (gated on TMB_DEBUG_SQL=1)

Verify that SQL queries appear in `sql.log` only when `TMB_DEBUG_SQL=1` is set.

### 2a. With TMB_DEBUG_SQL=1

```bash
rm -f ~/.claude/tmb/logs/sql.log

(
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"identity_get","arguments":{"agent":"bro"}}}'
  sleep 0.5
) | TMB_DEBUG_SQL=1 TRAJECTORY_DB_PATH=/tmp/debug-sql-smoke.db \
    node --experimental-sqlite dist/index.js 2>/dev/null

rm -f /tmp/debug-sql-smoke.db

tail -3 ~/.claude/tmb/logs/sql.log
python3 -c "import json; [json.loads(l) for l in open('$HOME/.claude/tmb/logs/sql.log')]" && echo "sql JSONL valid"
```

Expected: at least one line like `{"kind":"get","sql":"SELECT * FROM identity LIMIT 1","params":[],"duration_ms":<N>,"row_count":0,"ok":true,"ts":"..."}`.

### 2b. Without TMB_DEBUG_SQL (should produce NO sql.log)

```bash
rm -f ~/.claude/tmb/logs/sql.log

(
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"identity_get","arguments":{"agent":"bro"}}}'
  sleep 0.5
) | TRAJECTORY_DB_PATH=/tmp/debug-nosql-smoke.db \
    node --experimental-sqlite dist/index.js 2>/dev/null

rm -f /tmp/debug-nosql-smoke.db

test ! -f ~/.claude/tmb/logs/sql.log && echo "PASS: sql.log absent when TMB_DEBUG_SQL unset" || echo "FAIL: sql.log appeared unexpectedly"
```

---

## 3. CC log (Claude Code's own debug output)

Pass `--debug-file <path>` to write CC's own debug output to a file. Combine with `--debug <categories>` to narrow scope:

```bash
# Basic: all debug output to file
claude --debug-file /tmp/cc-debug-test.log --print "say the word hello"

# Scoped: only api + hooks categories
claude --debug api,hooks --debug-file /tmp/cc-debug-test.log --print "say the word hello"

head -5 /tmp/cc-debug-test.log
```

Expected: file exists with `[DEBUG]` lines. First few lines typically show MDM settings load + settings file resolution. Full session activity appended during the run.

Validate the file was written and is non-empty:
```bash
test -s /tmp/cc-debug-test.log && echo "PASS: cc debug log written" || echo "FAIL: cc debug log absent or empty"
rm /tmp/cc-debug-test.log
```

---

## 4. Crash sim — pre-kill entries survive

Verify that SIGTERM-received entries are written before the server dies, and that any `mcp-server.log` entries up to the kill are durable (not in a write buffer).

```bash
rm -f ~/.claude/tmb/logs/mcp-server.log

TRAJECTORY_DB_PATH=/tmp/debug-crash-smoke.db \
    node --experimental-sqlite dist/index.js < /dev/null &
SPID=$!

sleep 0.4
kill -TERM $SPID 2>/dev/null
wait $SPID 2>/dev/null

rm -f /tmp/debug-crash-smoke.db

echo "--- mcp-server.log after SIGTERM ---"
tail -5 ~/.claude/tmb/logs/mcp-server.log
```

Expected: `mcp-server.log` contains at minimum a `startup` entry and a `{"kind":"shutdown","signal":"SIGTERM",...}` entry. The `appendFileSync` calls are synchronous so no buffered data is lost on a clean SIGTERM.

For uncaughtException / hard kill (`kill -9`), the startup entry survives but the shutdown entry will NOT appear — that is expected behaviour because SIGKILL bypasses the process handlers.
