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
#   - Composition uses jq slurp to avoid hand-rolled JSON commas.
#
# Usage:
#   bash scripts/scan.sh [session_dir]
#   session_dir defaults to $PWD.

set -uo pipefail

SESSION_DIR="${1:-$PWD}"
SESSION_DIR=$(cd "$SESSION_DIR" 2>/dev/null && pwd)
[ -d "$SESSION_DIR" ] || { echo '{"error":"session_dir does not exist"}' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo '{"error":"jq missing"}' >&2; exit 1; }

# Cross-platform md5 wrapper.
_md5() {
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$1" 2>/dev/null
  elif command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" 2>/dev/null | cut -d' ' -f1
  else
    echo ''
  fi
}

# Cross-platform file-size wrapper (bytes).
_size_bytes() {
  stat -f '%z' "$1" 2>/dev/null || stat -c '%s' "$1" 2>/dev/null || \
    wc -c < "$1" 2>/dev/null | tr -d ' '
}

# Discover git repos under SESSION_DIR (max depth 4). Excludes the workspace's
# own .claude/worktrees/ since those are SWE-spawned scratch dirs, plus common
# build artefacts.
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

  files_list=$(git -C "$repo_root" ls-files 2>/dev/null || true)
  file_count=0

  # TEMP DIAGNOSTIC (#62 GH CI scan_run 0-files) — remove after root-cause
  if [ -n "${TMB_SCAN_DEBUG:-}" ]; then
    {
      echo "=== scan.sh DEBUG: repo_root=$repo_root ==="
      pwd; id 2>&1 | head -1
      echo "-- ls -la repo_root --"
      ls -la "$repo_root" 2>&1 | head -10
      echo "-- git -C status --"
      git -C "$repo_root" status 2>&1 | head -8
      echo "-- git -C log -1 --"
      git -C "$repo_root" log -1 --oneline 2>&1 | head -3
      echo "-- git -C ls-files raw --"
      git -C "$repo_root" ls-files 2>&1 | head -20
      echo "-- files_list captured (lines): $(printf '%s' "$files_list" | wc -l) --"
      echo "=== end DEBUG ==="
    } >&2
  fi

  if [ -n "$files_list" ]; then
    while IFS= read -r relpath; do
      [ -n "$relpath" ] || continue
      abs="$repo_root/$relpath"
      [ -f "$abs" ] || continue
      md5=$(_md5 "$abs")
      size=$(_size_bytes "$abs")
      last=$(git -C "$repo_root" log -1 --format='%H' -- "$relpath" 2>/dev/null || echo '')
      file_count=$((file_count + 1))

      jq -nc \
        --arg repo "$name" --arg path "$relpath" \
        --arg md5 "$md5" --arg last "$last" --argjson size "${size:-0}" \
        '{repo:$repo,path:$path,size_bytes:$size,content_md5:$md5,last_commit_sha:$last}' \
        >> "$files_jsonl"
    done <<< "$files_list"
  fi

  jq -nc \
    --arg name "$name" --arg path "$repo_root" \
    --argjson file_count "$file_count" \
    '{name:$name,path:$path,file_count:$file_count}' \
    >> "$repos_jsonl"
done < <(discover_repos)

scanned_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
  --arg session_dir "$SESSION_DIR" \
  --arg scanned_at "$scanned_at" \
  --slurpfile repos "$repos_jsonl" \
  --slurpfile files "$files_jsonl" \
  '{session_dir:$session_dir,scanned_at:$scanned_at,repos:$repos,files:$files}'
