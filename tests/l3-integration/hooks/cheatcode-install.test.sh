#!/usr/bin/env bash
# L3: cheatcode install stage (#659).
#   Part A — scripts/cheatcode-install.sh assembles the install payload from a
#            fixture (no live marketplace). JSON shape + kind-dependent
#            attachment + the skill-kind proposed-PR payload.
#   Part B — scripts/hooks/cheatcode-install-approval.sh fails closed: deny
#            without an approval record, allow with one.
# Network is stubbed via TMB_CHEATCODE_INSTALL_FIXTURE — no live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/cheatcode-install.sh"
HOOK="$PLUGIN_ROOT/scripts/hooks/cheatcode-install-approval.sh"

command -v jq >/dev/null 2>&1 || { printf "SKIP jq not found\n"; exit 0; }

WORKSPACE=$(mktemp -d)
trap 'rm -rf "$WORKSPACE"' EXIT

# ---------------------------------------------------------------------------
# Part A — install script (fixture-stubbed marketplace).
# ---------------------------------------------------------------------------
FIXTURE="$WORKSPACE/install.json"
cat > "$FIXTURE" <<'JSON'
{ "installed": true, "version": "1.2.3", "error": null }
JSON

OUT=$(TMB_CHEATCODE_INSTALL_FIXTURE="$FIXTURE" bash "$SCRIPT" \
  --candidate '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf","tier":1}')

test_case "install output is valid JSON"
if printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then _pass; else _fail "not JSON: $OUT"; fi

test_case "plugin kind installed via marketplace method"
assert_eq "marketplace" "$(printf '%s' "$OUT" | jq -r '.method')" "method"

test_case "plugin install reports installed=true with version"
assert_eq "true" "$(printf '%s' "$OUT" | jq -r '.installed')" "installed"
assert_eq "1.2.3" "$(printf '%s' "$OUT" | jq -r '.version')" "version"

test_case "plugin attachment targets the plugin (no prompt-surface edit)"
assert_eq "plugin" "$(printf '%s' "$OUT" | jq -r '.attachments[0].target')" "attachment target"

test_case "plugin install has no proposed_pr"
assert_eq "null" "$(printf '%s' "$OUT" | jq -r '.proposed_pr')" "proposed_pr"

# Skill kind with no fixture: nothing installs at the marketplace; the
# attachment is the proposed-PR payload only — never an automatic md write.
OUT_SKILL=$(bash "$SCRIPT" \
  --candidate '{"name":"pdf-skill","kind":"skill","source_url":"https://x.test/pdf-skill"}')

test_case "skill kind uses the skill-proposed-pr method"
assert_eq "skill-proposed-pr" "$(printf '%s' "$OUT_SKILL" | jq -r '.method')" "skill method"

test_case "skill kind returns an agent-frontmatter proposed-PR payload"
assert_eq "agent-frontmatter" "$(printf '%s' "$OUT_SKILL" | jq -r '.proposed_pr.kind')" "proposed_pr.kind"

test_case "skill kind installs nothing at the marketplace"
assert_eq "false" "$(printf '%s' "$OUT_SKILL" | jq -r '.installed')" "skill installed"

test_case "invalid kind fails non-zero"
set +e
bash "$SCRIPT" --candidate '{"name":"x","kind":"bad","source_url":"https://x"}' >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then _pass; else _fail "expected non-zero exit on bad kind"; fi

# ---------------------------------------------------------------------------
# Part B — PreToolUse approval gate (fail closed).
# ---------------------------------------------------------------------------
if ! command -v sqlite3 >/dev/null 2>&1; then
  printf "SKIP sqlite3 not found — approval-gate cases skipped\n"
  summarize
  printf "PASS cheatcode-install\n"
  exit 0
fi

WS="$WORKSPACE/ws"
mkdir -p "$WS/.claude/tmb"
DB="$WS/.claude/tmb/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL DEFAULT -1,
    branch_id TEXT,
    from_node TEXT NOT NULL DEFAULT 'bro',
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER NOT NULL DEFAULT 0);
"

install_input() {
  jq -nc --arg url "$1" \
    '{tool_name: "mcp__plugin_tmb_trajectory-server__cheatcode_install",
      tool_input: {agent: "bro", candidate: {name: "pdf", kind: "plugin", source_url: $url}}}'
}

test_case "non-cheatcode_install tool passes through silently"
OUT_PASS=$(echo '{"tool_name":"Bash"}' | bash "$HOOK" 2>&1 || true)
assert_eq "" "$OUT_PASS" "pass-through output"

test_case "install WITHOUT approval record is denied (fail closed)"
OUT_DENY=$(install_input "https://x.test/pdf" | bash "$HOOK" 2>&1 || true)
assert_contains "$OUT_DENY" '"permissionDecision":"deny"' "deny decision"
assert_contains "$OUT_DENY" "cheatcode_approve" "deny names the recovery tool"

test_case "missing candidate.source_url is denied"
OUT_NOURL=$(echo '{"tool_name":"mcp__x__cheatcode_install","tool_input":{}}' | bash "$HOOK" 2>&1 || true)
assert_contains "$OUT_NOURL" '"permissionDecision":"deny"' "deny on missing source_url"

# Seed a per-candidate approval record and retry.
sqlite3 "$DB" "
  INSERT INTO audit (event_type, summary, content_json, created_at)
  VALUES ('cheatcode_approved', 'approved pdf',
          json_object('name','pdf','kind','plugin','source_url','https://x.test/pdf'),
          datetime('now'));
"

test_case "install WITH a matching approval record is allowed"
OUT_ALLOW=$(install_input "https://x.test/pdf" | bash "$HOOK" 2>&1 || true)
assert_eq "" "$OUT_ALLOW" "allow output (no deny)"

test_case "approval for a different candidate does NOT unlock this one (per-candidate)"
OUT_OTHER=$(install_input "https://x.test/OTHER" | bash "$HOOK" 2>&1 || true)
assert_contains "$OUT_OTHER" '"permissionDecision":"deny"' "per-candidate isolation"

summarize
printf "PASS cheatcode-install\n"
