#!/usr/bin/env bash
# scan.sh — deterministic project scanner.
#
# Walks the session dir for git repos, enumerates each repo's tracked files,
# computes md5 + size + last_commit_sha per file, and emits a single JSON
# document on stdout for the MCP scan_run handler to ingest.
#
# Output shape:
#   {
#     "session_dir": "<absolute path>",
#     "scanned_at": "<ISO timestamp>",
#     "repos":  [ { name, path, file_count } ],
#     "files":  [ { repo, path, size_bytes, content_md5, last_commit_sha } ],
#     "plugin_inventory": { status, note },
#     "mcp_inventory": { status, note }
#   }
#
# plugin_inventory.status: cli (read from `claude plugin list --json`),
# fixture (read from TMB_SCAN_PLUGIN_JSON), unavailable (no plugin list; note
# says why) or skipped (no trajectory DB with a cheatcodes table to record into).
# mcp_inventory.status: home (read from ~/.claude.json mcpServers), fixture
# (read from TMB_SCAN_MCP_JSON), unavailable (note says why) or skipped (as above).
#
# Determinism rules (per the user's design):
#   - Drift detection is md5-only. No git diff. last_commit_sha is metadata,
#     not an invalidation signal.
#   - Repo discovery is via `find -name .git` (POSIX), not git, since
#     the session dir itself is not required to be a git repo.
#   - Per-repo file enumeration is `git ls-files` (.gitignore-aware).
#   - Single-pass git log: one `git log --format=%H --name-only` pass per
#     repo builds a path→sha map; no per-file git subprocess.
#   - md5 batched via xargs+parallel workers (md5 -r on macOS, md5sum on Linux).
#   - stat batched via xargs (BSD stat -f '%N\t%z' or GNU stat -c '%n\t%s').
#   - JSONL emitted in one final awk pass; jq used only for the envelope.
#
# Usage:
#   bash scripts/scan.sh [session_dir]
#   session_dir defaults to $PWD.
#
# Environment:
#   TMB_SCAN_PLUGIN_JSON    path to a file holding `claude plugin list --json`
#                           output; read in place of the CLI under the test
#                           flags.
#   TMB_SCAN_MCP_JSON       path to a file holding an `mcpServers` object (the
#                           shape of ~/.claude.json's `.mcpServers`); read in
#                           place of ~/.claude.json under the test flags.
#   TMB_SCAN_DISCOVERY_TIMEOUT  seconds allowed for `claude plugin list` (4).
#
# Test flags: TMB_FORBID_LIVE_SYNC=1 or a set TMB_TEST_RUN_ID (tmb_test_flag in
# hooks/lib/query-task.sh). Under either, the DB must resolve from
# TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR (the shared resolver never walks up;
# exit 2 otherwise), `claude` is never spawned and ~/.claude.json is never read.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/hooks/lib/query-task.sh"

SCAN_TEST_MODE=0
if tmb_test_flag >/dev/null; then
  SCAN_TEST_MODE=1
  if ! tmb_db_path >/dev/null; then
    echo 'scan: TRAJECTORY_DB_PATH is required under TMB_FORBID_LIVE_SYNC/TMB_TEST_RUN_ID (walk-up discovery disabled) unless CLAUDE_PROJECT_DIR names a project with a DB' >&2
    exit 2
  fi
fi

SESSION_DIR="${1:-$PWD}"
SESSION_DIR=$(cd "$SESSION_DIR" 2>/dev/null && pwd)
[ -d "$SESSION_DIR" ] || { echo '{"error":"session_dir does not exist"}' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo '{"error":"jq missing"}' >&2; exit 1; }

# Detect md5 command and mode.
# macOS: `md5 -r` → "hash path"; Linux: `md5sum` → "hash  path"
# Both produce hash-first output parseable by the same awk rule.
_md5_cmd() {
  if command -v md5 >/dev/null 2>&1; then
    echo "md5 -r"
  elif command -v md5sum >/dev/null 2>&1; then
    echo "md5sum"
  else
    echo ""
  fi
}
MD5_CMD=$(_md5_cmd)

# Detect stat command.
# BSD (macOS): stat -f '%N\t%z' → "path\tsize"
# GNU (Linux): stat -c '%n\t%s' → "path\tsize"
_stat_cmd() {
  if stat -f '%z' "$(which stat)" >/dev/null 2>&1; then
    echo "bsd"
  elif stat -c '%s' "$(which stat)" >/dev/null 2>&1; then
    echo "gnu"
  else
    echo ""
  fi
}
STAT_MODE=$(_stat_cmd)

# Batch md5: abs_list_file contains one absolute path per line.
# Output: "abspath\tmd5" per line (unordered is fine — consumed by awk map).
_batch_md5() {
  local abs_list_file="$1"
  if [ -z "$MD5_CMD" ]; then
    awk '{print $0 "\t"}' "$abs_list_file"
    return
  fi
  # xargs: -0 NUL-delimited (paths may contain spaces), -P4 parallel workers,
  # -n50 files per invocation.
  # BSD/GNU both produce "hash path" (md5 -r) or "hash  path" (md5sum).
  # awk flips to "path\thash". MD5_CMD ("md5 -r") splits into command + flag.
  # shellcheck disable=SC2086
  while IFS= read -r p; do printf '%s\0' "$p"; done < "$abs_list_file" \
  | xargs -0 -P4 -n50 $MD5_CMD 2>/dev/null \
  | awk '{hash=$1; sub(/^[^ ]+ +/,""); print $0 "\t" hash}'
}

# Batch stat: abs_list_file contains one absolute path per line.
# Output: "abspath\tsize" per line (unordered is fine — consumed by awk map).
_batch_stat() {
  local abs_list_file="$1"
  case "$STAT_MODE" in
    bsd)
      while IFS= read -r p; do printf '%s\0' "$p"; done < "$abs_list_file" \
      | xargs -0 -P4 -n100 stat -f '%N	%z' 2>/dev/null
      ;;
    gnu)
      while IFS= read -r p; do printf '%s\0' "$p"; done < "$abs_list_file" \
      | xargs -0 -P4 -n100 stat -c '%n	%s' 2>/dev/null
      ;;
    *)
      # Fallback: wc per file.
      while IFS= read -r p; do
        sz=$(wc -c < "$p" 2>/dev/null | tr -d ' ')
        printf '%s\t%s\n' "$p" "${sz:-0}"
      done < "$abs_list_file"
      ;;
  esac
}

# One scan_skipped audit row per skipped path and reason; a re-scan that skips
# the same path writes nothing. Best-effort: no DB or no audit table, no row.
_audit_skip() {
  local path="$1" reason="$2" db content
  # shellcheck source=scripts/hooks/lib/db-write.sh
  . "$SCRIPT_DIR/hooks/lib/db-write.sh" 2>/dev/null || return 0
  tmb_have_sqlite || return 0
  db=$(tmb_db_path 2>/dev/null) || return 0
  [ -n "$(tmb_sqlite_ro "$db" "SELECT name FROM sqlite_master WHERE type='table' AND name='audit';")" ] || return 0
  content=$(jq -nc --arg path "$path" --arg reason "$reason" '{path:$path,reason:$reason}')
  tmb_audit_append "$db" -1 '' "hook:scan" "scan_skipped" "$path: skipped ($reason)" "$content" '$.path' '$.reason'
}

# The reason a discovered repo below SESSION_DIR is left out of the scan, or
# nothing when it is scanned: dot_dir (a dot-prefixed path segment below
# SESSION_DIR), git_ignored (the nearest enclosing repo up to SESSION_DIR
# ignores it) or no_commits (no HEAD commit).
_skip_reason() {
  local repo="$1" rel="${1#"$SESSION_DIR"/}" enclosing
  case "/$rel" in
    */.*) echo dot_dir; return ;;
  esac
  enclosing=$(dirname "$repo")
  while :; do
    if [ -e "$enclosing/.git" ]; then
      git -C "$enclosing" check-ignore -q "$repo" 2>/dev/null && { echo git_ignored; return; }
      break
    fi
    [ "$enclosing" = "$SESSION_DIR" ] && break
    enclosing=$(dirname "$enclosing")
  done
  git -C "$repo" rev-parse --verify -q HEAD >/dev/null 2>&1 || echo no_commits
}

# Discover git repos under SESSION_DIR (max depth 4). Excludes worktrees and
# common build artefacts below SESSION_DIR; the prune patterns match paths
# relative to it, so a SESSION_DIR that itself sits under .claude/worktrees/
# is still scanned (GH 1550). SESSION_DIR itself is always scanned; a repo
# below it with a _skip_reason is left out and audited (GH 1551).
discover_repos() {
  local repo reason
  (cd "$SESSION_DIR" && find . -maxdepth 4 \
    \( -path '*/node_modules' -o -path '*/.claude/worktrees*' \
       -o -path '*/dist' -o -path '*/build' -o -path '*/.next' \
       -o -path '*/target' -o -path '*/.venv' -o -path '*/venv' \) -prune \
    -o -name .git -print 2>/dev/null) \
  | sed 's:/\.git$::' \
  | while IFS= read -r rel; do
      case "$rel" in
        .) printf '%s\n' "$SESSION_DIR" ;;
        ./*) printf '%s/%s\n' "$SESSION_DIR" "${rel#./}" ;;
      esac
    done \
  | sort -u \
  | while IFS= read -r repo; do
      if [ "$repo" != "$SESSION_DIR" ]; then
        reason=$(_skip_reason "$repo")
        if [ -n "$reason" ]; then
          _audit_skip "$repo" "$reason" >/dev/null 2>&1 || true
          continue
        fi
      fi
      printf '%s\n' "$repo"
    done
}

repos_jsonl=$(mktemp "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-scan-repos.jsonl.XXXXXX")
files_jsonl=$(mktemp "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-scan-files.jsonl.XXXXXX")
trap 'rm -f "$repos_jsonl" "$files_jsonl"' EXIT

while IFS= read -r repo_root; do
  [ -n "$repo_root" ] || continue
  [ -d "$repo_root" ] || continue

  name=$(basename "$repo_root")

  files_list=$(git -C "$repo_root" -c core.quotePath=false ls-files 2>/dev/null || true)
  if [ -z "$files_list" ]; then
    jq -nc \
      --arg name "$name" --arg path "$repo_root" \
      --argjson file_count 0 \
      '{name:$name,path:$path,file_count:$file_count}' \
      >> "$repos_jsonl"
    continue
  fi

  # Single-pass git log: build relpath→sha map in one subprocess.
  # awk: 40-hex lines update current SHA; file lines record first (most-recent) SHA.
  sha_map_file=$(mktemp "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-shamap.XXXXXX")
  git -C "$repo_root" -c core.quotePath=false log --format='%H' --name-only --no-renames 2>/dev/null \
  | awk '
      /^[0-9a-f]{40}$/ { cur = $0; next }
      /^$/              { next }
      !seen[$0]++       { print $0 "\t" cur }
    ' > "$sha_map_file"

  # Build absolute path list: sed prepends repo_root to each relpath.
  abs_list_file=$(mktemp "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-abslist.XXXXXX")
  printf '%s\n' "$files_list" \
  | awk -v r="$repo_root" '{print r "/" $0}' \
  | while IFS= read -r abs; do
      [ -f "$abs" ] && printf '%s\n' "$abs"
    done > "$abs_list_file"

  file_count=$(wc -l < "$abs_list_file" | tr -d ' ')

  if [ "${file_count:-0}" -eq 0 ]; then
    rm -f "$abs_list_file" "$sha_map_file"
    jq -nc \
      --arg name "$name" --arg path "$repo_root" \
      --argjson file_count 0 \
      '{name:$name,path:$path,file_count:$file_count}' \
      >> "$repos_jsonl"
    continue
  fi

  # Batch md5 and stat: each produces "path\tvalue" lines (unordered).
  md5_map_file=$(mktemp "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-md5map.XXXXXX")
  size_map_file=$(mktemp "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-sizemap.XXXXXX")
  _batch_md5 "$abs_list_file" > "$md5_map_file" 2>/dev/null || true
  _batch_stat "$abs_list_file" > "$size_map_file" 2>/dev/null || true

  # Emit JSONL in one awk pass: load all three maps into memory, then
  # iterate ls-files output once to join and emit.
  awk \
    -v repo="$name" \
    -v repo_root="$repo_root" \
    -v shafile="$sha_map_file" \
    -v md5file="$md5_map_file" \
    -v sizefile="$size_map_file" \
    -v outfile="$files_jsonl" \
  '
    function jsonescape(s,    r) {
      r = s
      gsub(/\\/, "\\\\", r)
      gsub(/"/, "\\\"", r)
      gsub(/\t/, "\\t", r)
      return r
    }
    BEGIN {
      while ((getline line < shafile) > 0) {
        n = index(line, "\t")
        if (n > 0) sha[substr(line,1,n-1)] = substr(line,n+1)
      }
      close(shafile)
      while ((getline line < md5file) > 0) {
        n = index(line, "\t")
        if (n > 0) md5m[substr(line,1,n-1)] = substr(line,n+1)
      }
      close(md5file)
      while ((getline line < sizefile) > 0) {
        n = index(line, "\t")
        if (n > 0) sizem[substr(line,1,n-1)] = substr(line,n+1)
      }
      close(sizefile)
    }
    /^$/ { next }
    {
      relpath = $0
      abs = repo_root "/" relpath
      md5v  = (md5m[abs]  != "") ? md5m[abs]  : ""
      sizev = (sizem[abs] != "") ? sizem[abs] : "0"
      shav  = (sha[relpath] != "") ? sha[relpath] : ""
      gsub(/[^0-9]/, "", sizev)
      if (sizev == "") sizev = "0"
      printf "{\"repo\":\"%s\",\"path\":\"%s\",\"size_bytes\":%s,\"content_md5\":\"%s\",\"last_commit_sha\":\"%s\"}\n",
        jsonescape(repo), jsonescape(relpath), sizev, jsonescape(md5v), jsonescape(shav) >> outfile
    }
  ' <<< "$files_list"

  rm -f "$sha_map_file" "$md5_map_file" "$size_map_file" "$abs_list_file"

  jq -nc \
    --arg name "$name" --arg path "$repo_root" \
    --argjson file_count "$file_count" \
    '{name:$name,path:$path,file_count:$file_count}' \
    >> "$repos_jsonl"
done < <(discover_repos)

# --- Resource discovery (#124/#846) --------------------------------------
# After the repo/file walk, reconcile locally-present resources into the
# cheatcodes table: project-local skills, enabled plugins, configured MCP
# servers. Each discovered resource not already tracked (name+kind) is
# INSERTed and a scan_discovered audit row is emitted. Already-tracked rows are
# left to the #113 health-check.
#
# Ingest is JSON-only (#150): plugins come from `claude plugin list --json` and
# MCP servers from each plugin entry's `mcpServers` object (plus a
# ~/.claude.json fallback) — NEVER from line-splitting human-formatted CLI
# stdout, which leaked header words (Installed/Version/Scope/Status/Location),
# the ❯ glyph, and tokenized fragments as fake rows. Every candidate name is
# validated against ^[A-Za-z0-9._-]+$ before insert; a plugin's <name>@<mkt> id
# yields origin=marketplace with source_url=<the ref>. A plugin's enabled flag
# maps to status (enabled→active, else installed).
#
# Non-load-bearing: it only sets plugin_inventory + mcp_inventory on stdout (the world-model JSON is
# unchanged) and never fails the scan — every step is guarded and best-effort.
PLUGIN_INVENTORY_STATUS=skipped
PLUGIN_INVENTORY_NOTE="no trajectory DB with a cheatcodes table"
MCP_INVENTORY_STATUS=skipped
MCP_INVENTORY_NOTE="no trajectory DB with a cheatcodes table"
discover_resources() {
  local lib="$SCRIPT_DIR/hooks/lib/query-task.sh"
  [ -f "$lib" ] || return 0
  # shellcheck source=scripts/hooks/lib/query-task.sh
  . "$lib" 2>/dev/null || return 0
  # shellcheck source=scripts/hooks/lib/db-write.sh
  . "$SCRIPT_DIR/hooks/lib/db-write.sh" 2>/dev/null || return 0

  tmb_have_sqlite || return 0
  local db
  db=$(tmb_db_path) || return 0
  [ -n "$db" ] || return 0

  # cheatcodes + audit tables must exist.
  local have_cc
  have_cc=$(tmb_sqlite_ro "$db" "SELECT name FROM sqlite_master WHERE type='table' AND name='cheatcodes';")
  [ -n "$have_cc" ] || return 0

  local claude_timeout="${TMB_SCAN_DISCOVERY_TIMEOUT:-4}"
  _run_bounded() {
    if command -v timeout >/dev/null 2>&1; then
      timeout "$claude_timeout" "$@" 2>/dev/null || true
    elif command -v gtimeout >/dev/null 2>&1; then
      gtimeout "$claude_timeout" "$@" 2>/dev/null || true
    else
      "$@" 2>/dev/null || true
    fi
  }

  local now
  now=$(tmb_sql_quote "$(tmb_now_iso)")

  # A valid plugin/mcp/skill name is the marketplace identifier charset. Reject
  # anything else BEFORE the insert — this is the #150 guard that stops header
  # words / glyphs / tokenized fragments from ever becoming a cheatcodes row.
  _valid_name() {
    case "$1" in
      ''|*[!A-Za-z0-9._-]*) return 1 ;;
      *) return 0 ;;
    esac
  }

  # Register one discovered resource, keyed on (name, kind). The INSERT is a
  # no-op when the row exists, and the scan_discovered audit row is guarded on
  # the INSERT having inserted, so a re-scan writes nothing. An existing row
  # only gets its blank description / NULL version filled and a legacy
  # 'mcp:<server>' source_url rewritten to the bundled 'mcp:<plugin>/<server>'.
  #   $1 kind   skill|mcp|plugin
  #   $2 name   validated against _valid_name (charset gate)
  #   $3 file_path  SKILL.md for skills, '' otherwise
  #   $4 origin     marketplace|external (provenance, never a lifecycle word)
  #   $5 source_url the candidate identity (e.g. <name>@<mkt>); '' → 'scan_discovered'
  #   $6 status     active|installed
  #   $7 description  '' when the manifest has none
  #   $8 version      '' → NULL
  #   $9 trust_parent plugin whose trust_tier the row inherits ('' → NULL)
  _register() {
    local kind="$1" name="$2" file_path="$3" origin="${4:-external}" source_url="${5:-}" status="${6:-installed}"
    local description="${7:-}" version="${8:-}" trust_parent="${9:-}"
    _valid_name "$name" || return 0
    [ -n "$source_url" ] || source_url="scan_discovered"
    local safe_name safe_kind safe_url safe_desc
    safe_name=$(tmb_sql_quote "$name")
    safe_kind=$(tmb_sql_quote "$kind")
    safe_url=$(tmb_sql_quote "$source_url")
    safe_desc=$(tmb_sql_quote "$description")
    local version_sql="NULL"
    [ -n "$version" ] && version_sql="'$(tmb_sql_quote "$version")'"

    local existing
    existing=$(tmb_sqlite_ro "$db" "
      SELECT CASE
               WHEN (description = '' AND '$safe_desc' <> '')
                 OR (version IS NULL AND $version_sql IS NOT NULL)
                 OR (kind = 'mcp' AND source_url = 'mcp:' || name AND '$safe_url' LIKE 'mcp:%/%')
               THEN 'stale' ELSE 'current' END
        FROM cheatcodes
       WHERE name = '$safe_name' AND kind = '$safe_kind' LIMIT 1;")
    if [ -n "$existing" ]; then
      [ "$existing" = "stale" ] || return 0
      tmb_db_write "$db" "UPDATE cheatcodes
   SET description = CASE WHEN description = '' THEN '$safe_desc' ELSE description END,
       version = COALESCE(version, $version_sql),
       source_url = CASE WHEN kind = 'mcp' AND source_url = 'mcp:' || name AND '$safe_url' LIKE 'mcp:%/%'
                         THEN '$safe_url' ELSE source_url END,
       updated_at = '$now'
 WHERE name = '$safe_name' AND kind = '$safe_kind';" >/dev/null || return 0
      return 0
    fi

    local fp_sql="NULL"
    if [ -n "$file_path" ]; then
      fp_sql="'$(tmb_sql_quote "$file_path")'"
    fi
    local trust_sql="NULL"
    if [ -n "$trust_parent" ]; then
      trust_sql="(SELECT trust_tier FROM cheatcodes WHERE kind = 'plugin' AND name = '$(tmb_sql_quote "$trust_parent")')"
    fi
    local content_json audit_sql
    content_json=$(jq -nc --arg name "$name" --arg kind "$kind" --arg origin "$origin" --arg source "$source_url" \
      '{name: $name, kind: $kind, origin: $origin, source: $source}')
    audit_sql=$(tmb_audit_sql -1 '' "hook:scan" "scan_discovered" "$name ($kind): discovered" "$content_json" \
      "(SELECT changes()) > 0") || return 0

    tmb_db_write "$db" "INSERT INTO cheatcodes (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
VALUES ('$safe_name', '$safe_kind', '$(tmb_sql_quote "$origin")', '$safe_desc', '$safe_url', $fp_sql, $version_sql, $trust_sql, 'project-local', '$(tmb_sql_quote "$status")', '$now', '$now', '$now')
ON CONFLICT (name, kind) DO NOTHING;
$audit_sql" >/dev/null || return 0
  }

  # skills — project-local .claude/skills/<name>/SKILL.md. Builtin-shipped, so
  # origin=builtin is wrong (those carry source_url NULL via the builtin CHECK);
  # a locally-authored skill is a project resource recorded as external.
  local skills_dir="$SESSION_DIR/.claude/skills"
  if [ -d "$skills_dir" ]; then
    local skill_md
    while IFS= read -r skill_md; do
      [ -n "$skill_md" ] || continue
      local sname
      sname=$(basename "$(dirname "$skill_md")")
      _register skill "$sname" ".claude/skills/$sname/SKILL.md" external "skill:$sname" active
    done < <(find "$skills_dir" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | sort)
  fi

  # plugins + mcp — JSON-only ingest (#150). Parse `claude plugin list --json`
  # with jq; never line-split human-formatted stdout. Each entry's `id` is
  # <name>@<marketplace> → origin=marketplace, source_url=<the ref>, status from
  # `enabled`. Each entry's `mcpServers` object names the MCP servers a plugin
  # registers.
  local plugin_json="" plugin_source="" plugin_note=""
  if [ "$SCAN_TEST_MODE" = "1" ]; then
    if [ -n "${TMB_SCAN_PLUGIN_JSON:-}" ] && [ -r "$TMB_SCAN_PLUGIN_JSON" ]; then
      plugin_json=$(cat "$TMB_SCAN_PLUGIN_JSON")
      plugin_source=fixture
    else
      plugin_note="TMB_FORBID_LIVE_SYNC=1 or TMB_TEST_RUN_ID set and no readable TMB_SCAN_PLUGIN_JSON: claude plugin list skipped"
    fi
  elif command -v claude >/dev/null 2>&1; then
    plugin_json=$(_run_bounded claude plugin list --json)
    plugin_source=cli
  else
    plugin_note="claude CLI not on PATH"
  fi
  if [ -n "$plugin_source" ] && ! printf '%s' "$plugin_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
    plugin_note="$plugin_source plugin list is not a JSON array"
    plugin_source=""
  fi
  if [ -z "$plugin_source" ]; then
    PLUGIN_INVENTORY_STATUS=unavailable
    PLUGIN_INVENTORY_NOTE="$plugin_note"
  else
    PLUGIN_INVENTORY_STATUS="$plugin_source"
    PLUGIN_INVENTORY_NOTE=""
    # plugins: one line per entry → name, ref, status, version, description,
    # installPath, separated by US (\x1f) so empty fields keep their place.
    # jq splits the id on '@' and maps enabled→active/installed; the shell
    # loop validates + inserts. A blank name (malformed id) is dropped by
    # _valid_name. A description absent from the list entry is read from the
    # installed plugin.json.
    local pname pref pstatus pversion pdesc ppath
    while IFS=$'\x1f' read -r pname pref pstatus pversion pdesc ppath; do
      [ -n "$pname" ] || continue
      if [ -z "$pdesc" ] && [ -n "$ppath" ] && [ -f "$ppath/.claude-plugin/plugin.json" ]; then
        pdesc=$(jq -r '.description // ""' "$ppath/.claude-plugin/plugin.json" 2>/dev/null || true)
      fi
      _register plugin "$pname" "" marketplace "$pref" "$pstatus" "$pdesc" "$pversion"
    done < <(printf '%s' "$plugin_json" | jq -r '
      .[]? | [ ((.id // "") | split("@")[0]),
               (.id // ""),
               (if .enabled == true then "active" else "installed" end),
               (.version // ""),
               ((.description // "") | gsub("[\t\n\r]"; " ")),
               (.installPath // "") ]
      | join("\u001f")' 2>/dev/null)

    # mcp servers bundled by each plugin's mcpServers object → plugin, server,
    # version (US-separated). source_url mcp:<plugin>/<server> lets the
    # health-check find the parent plugin.
    local mplugin mname mversion
    while IFS=$'\x1f' read -r mplugin mname mversion; do
      [ -n "$mname" ] || continue
      _valid_name "$mplugin" || continue
      _register mcp "$mname" "" marketplace "mcp:$mplugin/$mname" active \
        "$mname MCP server bundled by $mplugin" "$mversion" "$mplugin"
    done < <(printf '%s' "$plugin_json" | jq -r '
      .[]? | ((.id // "") | split("@")[0]) as $p | (.version // "") as $v
      | (.mcpServers? // {} | keys[]?) | [ $p, ., $v ] | join("\u001f")' 2>/dev/null)
  fi

  # mcp fallback — the mcpServers object of ~/.claude.json (covers a
  # stale/absent CLI); under the test flags, of TMB_SCAN_MCP_JSON instead.
  local mcp_servers="" mcp_source="" mcp_note=""
  if [ "$SCAN_TEST_MODE" = "1" ]; then
    if [ -n "${TMB_SCAN_MCP_JSON:-}" ] && [ -r "$TMB_SCAN_MCP_JSON" ]; then
      mcp_servers=$(cat "$TMB_SCAN_MCP_JSON")
      mcp_source=fixture
    else
      mcp_note="TMB_FORBID_LIVE_SYNC/TMB_TEST_RUN_ID set and no readable TMB_SCAN_MCP_JSON: ~/.claude.json skipped"
    fi
  elif [ -f "$HOME/.claude.json" ]; then
    mcp_servers=$(jq -c '.mcpServers // {}' "$HOME/.claude.json" 2>/dev/null || true)
    mcp_source=home
  else
    mcp_note="no ~/.claude.json"
  fi
  if [ -n "$mcp_source" ] && ! printf '%s' "$mcp_servers" | jq -e 'type == "object"' >/dev/null 2>&1; then
    mcp_note="$mcp_source mcpServers is not a JSON object"
    mcp_source=""
  fi
  if [ -z "$mcp_source" ]; then
    MCP_INVENTORY_STATUS=unavailable
    MCP_INVENTORY_NOTE="$mcp_note"
  else
    MCP_INVENTORY_STATUS="$mcp_source"
    MCP_INVENTORY_NOTE=""
    local jkey
    while IFS= read -r jkey; do
      [ -n "$jkey" ] && _register mcp "$jkey" "" external "mcp:$jkey" active
    done < <(printf '%s' "$mcp_servers" | jq -r 'keys[]' 2>/dev/null || true)
  fi

  return 0
}

discover_resources >/dev/null 2>&1 || true

scanned_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
  --arg session_dir "$SESSION_DIR" \
  --arg scanned_at "$scanned_at" \
  --slurpfile repos "$repos_jsonl" \
  --slurpfile files "$files_jsonl" \
  --arg plugin_status "$PLUGIN_INVENTORY_STATUS" \
  --arg plugin_note "$PLUGIN_INVENTORY_NOTE" \
  --arg mcp_status "$MCP_INVENTORY_STATUS" \
  --arg mcp_note "$MCP_INVENTORY_NOTE" \
  '{session_dir:$session_dir,scanned_at:$scanned_at,repos:$repos,files:$files,plugin_inventory:{status:$plugin_status,note:$plugin_note},mcp_inventory:{status:$mcp_status,note:$mcp_note}}'
