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
#     "files":  [ { repo, path, size_bytes, content_md5, last_commit_sha } ]
#   }
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

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
  # awk flips to "path\thash".
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

# Discover git repos under SESSION_DIR (max depth 4). Excludes worktrees and
# common build artefacts.
discover_repos() {
  find "$SESSION_DIR" -maxdepth 4 \
    \( -path '*/node_modules' -o -path '*/.claude/worktrees*' \
       -o -path '*/dist' -o -path '*/build' -o -path '*/.next' \
       -o -path '*/target' -o -path '*/.venv' -o -path '*/venv' \) -prune \
    -o -name .git -print 2>/dev/null \
  | sed 's:/\.git$::' \
  | sort -u
}

repos_jsonl=$(mktemp -t tmb-scan-repos.XXXXXX.jsonl)
files_jsonl=$(mktemp -t tmb-scan-files.XXXXXX.jsonl)
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
  sha_map_file=$(mktemp -t tmb-shamap.XXXXXX)
  git -C "$repo_root" -c core.quotePath=false log --format='%H' --name-only --no-renames 2>/dev/null \
  | awk '
      /^[0-9a-f]{40}$/ { cur = $0; next }
      /^$/              { next }
      !seen[$0]++       { print $0 "\t" cur }
    ' > "$sha_map_file"

  # Build absolute path list: sed prepends repo_root to each relpath.
  abs_list_file=$(mktemp -t tmb-abslist.XXXXXX)
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
  md5_map_file=$(mktemp -t tmb-md5map.XXXXXX)
  size_map_file=$(mktemp -t tmb-sizemap.XXXXXX)
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
# Non-load-bearing: this never alters stdout (the world-model JSON below is
# unchanged) and never fails the scan — every step is guarded and best-effort.
discover_resources() {
  local lib="$SCRIPT_DIR/hooks/lib/query-task.sh"
  [ -f "$lib" ] || return 0
  # shellcheck source=scripts/hooks/lib/query-task.sh
  . "$lib" 2>/dev/null || return 0

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
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

  # A valid plugin/mcp/skill name is the marketplace identifier charset. Reject
  # anything else BEFORE the insert — this is the #150 guard that stops header
  # words / glyphs / tokenized fragments from ever becoming a cheatcodes row.
  _valid_name() {
    case "$1" in
      ''|*[!A-Za-z0-9._-]*) return 1 ;;
      *) return 0 ;;
    esac
  }

  # INSERT one discovered resource if it is not already a cheatcodes row
  # (matched on name+kind). Emits a scan_discovered audit row on insert.
  #   $1 kind   skill|mcp|plugin
  #   $2 name   validated against _valid_name (charset gate)
  #   $3 file_path  SKILL.md for skills, '' otherwise
  #   $4 origin     marketplace|external (provenance, never a lifecycle word)
  #   $5 source_url the candidate identity (e.g. <name>@<mkt>); '' → 'scan_discovered'
  #   $6 status     active|installed
  _register() {
    local kind="$1" name="$2" file_path="$3" origin="${4:-external}" source_url="${5:-}" status="${6:-installed}"
    _valid_name "$name" || return 0
    local safe_name safe_kind safe_origin safe_status
    safe_name=$(tmb_sql_quote "$name")
    safe_kind=$(tmb_sql_quote "$kind")
    safe_origin=$(tmb_sql_quote "$origin")
    safe_status=$(tmb_sql_quote "$status")

    local existing
    existing=$(tmb_sqlite_ro "$db" "
      SELECT 1 FROM cheatcodes
       WHERE name = '$safe_name' AND kind = '$safe_kind' LIMIT 1;")
    [ -n "$existing" ] && return 0

    [ -n "$source_url" ] || source_url="scan_discovered"
    local safe_url
    safe_url=$(tmb_sql_quote "$source_url")

    local fp_sql="NULL"
    if [ -n "$file_path" ]; then
      fp_sql="'$(tmb_sql_quote "$file_path")'"
    fi
    local content_json
    content_json=$(printf '{"name":"%s","kind":"%s","origin":"%s","source":"%s"}' \
      "$safe_name" "$safe_kind" "$safe_origin" "$safe_url")

    sqlite3 "$db" <<SQL 2>/dev/null || true
INSERT INTO cheatcodes (name, kind, origin, source_url, file_path, scope, status, installed_at, created_at, updated_at)
VALUES ('$safe_name', '$safe_kind', '$safe_origin', '$safe_url', $fp_sql, 'project-local', '$safe_status', '$now', '$now', '$now');
INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, '', 'scan',
        'scan_discovered',
        '$safe_name ($safe_kind): discovered',
        '$content_json', '$now');
SQL
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
  if command -v claude >/dev/null 2>&1; then
    local plugin_json
    plugin_json=$(_run_bounded claude plugin list --json)
    if printf '%s' "$plugin_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
      # plugins: one TSV line per entry → name<TAB>ref<TAB>status. jq splits the
      # id on '@' and maps enabled→active/installed; the shell loop validates +
      # inserts. A blank name (malformed id) is dropped by _valid_name.
      local pname pref pstatus
      while IFS=$'\t' read -r pname pref pstatus; do
        [ -n "$pname" ] || continue
        _register plugin "$pname" "" marketplace "$pref" "$pstatus"
      done < <(printf '%s' "$plugin_json" | jq -r '
        .[]? | [ ((.id // "") | split("@")[0]),
                 (.id // ""),
                 (if .enabled == true then "active" else "installed" end) ]
        | @tsv' 2>/dev/null)

      # mcp servers contributed by each plugin's mcpServers object.
      local mname
      while IFS= read -r mname; do
        [ -n "$mname" ] || continue
        _register mcp "$mname" "" marketplace "mcp:$mname" active
      done < <(printf '%s' "$plugin_json" | jq -r '
        .[]?.mcpServers? // {} | keys[]?' 2>/dev/null | sort -u)
    fi
  fi

  # mcp fallback — ~/.claude.json mcpServers keys (covers a stale/absent CLI).
  if [ -f "$HOME/.claude.json" ]; then
    local jkey
    while IFS= read -r jkey; do
      [ -n "$jkey" ] && _register mcp "$jkey" "" external "mcp:$jkey" active
    done < <(jq -r '.mcpServers // {} | keys[]' "$HOME/.claude.json" 2>/dev/null || true)
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
  '{session_dir:$session_dir,scanned_at:$scanned_at,repos:$repos,files:$files}'
