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
  # xargs: -P4 parallel workers, -n50 files per invocation.
  # BSD/GNU both produce "hash path" (md5 -r) or "hash  path" (md5sum).
  # awk flips to "path\thash".
  cat "$abs_list_file" | xargs -P4 -n50 $MD5_CMD 2>/dev/null \
  | awk '{hash=$1; sub(/^[^ ]+ +/,""); print $0 "\t" hash}'
}

# Batch stat: abs_list_file contains one absolute path per line.
# Output: "abspath\tsize" per line (unordered is fine — consumed by awk map).
_batch_stat() {
  local abs_list_file="$1"
  case "$STAT_MODE" in
    bsd)
      cat "$abs_list_file" | xargs -P4 -n100 stat -f '%N	%z' 2>/dev/null
      ;;
    gnu)
      cat "$abs_list_file" | xargs -P4 -n100 stat -c '%n	%s' 2>/dev/null
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

  files_list=$(git -C "$repo_root" ls-files 2>/dev/null || true)
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
  git -C "$repo_root" log --format='%H' --name-only --no-renames 2>/dev/null \
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

scanned_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
  --arg session_dir "$SESSION_DIR" \
  --arg scanned_at "$scanned_at" \
  --slurpfile repos "$repos_jsonl" \
  --slurpfile files "$files_jsonl" \
  '{session_dir:$session_dir,scanned_at:$scanned_at,repos:$repos,files:$files}'
