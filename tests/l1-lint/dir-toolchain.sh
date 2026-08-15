#!/usr/bin/env bash
# Lint: verify that shell scripts in guarded directories only use interpreters
# from the directory's declared allowlist. Encodes the B13 incident where a
# Python3 script was added to tests/benchmarks/ without updating the directory
# contract. The current contract allows bash wrappers, Python stdlib parsers,
# and the Node-based Codex MCP latency harness.
#
# Allowlist map (dir → space-separated allowed interpreter tokens):
#   tests/benchmarks → bash, python3, node
#
# Detection strategy: scan each .sh file's shebang line and any heredoc
# markers (python3, python, node, ruby, etc.) embedded as interpreter calls.
# Reports the offending file + interpreter and exits non-zero on any violation.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

FAIL=0

# ---------------------------------------------------------------------------
# Allowlist map: each entry is "dir:interp1:interp2:..."
# Add new directory constraints by appending entries here.
# ---------------------------------------------------------------------------
declare -a ALLOWLIST_MAP=(
  "tests/benchmarks:bash:python3:node"
)

check_dir() {
  local dir_rel="$1"
  shift
  local allowed=("$@")
  local dir="$PLUGIN_ROOT/$dir_rel"

  [ -d "$dir" ] || return 0

  while IFS= read -r -d '' script; do
    local rel="${script#"$PLUGIN_ROOT/"}"

    # Check shebang line.
    local shebang
    shebang=$(head -1 "$script" 2>/dev/null || true)
    if echo "$shebang" | grep -qE '^#!'; then
      # Extract the interpreter name (last path component, strip args).
      local interp
      interp=$(echo "$shebang" | sed -E 's|^#![[:space:]]*/?(usr/bin/env[[:space:]]+)?||' | awk '{print $1}' | xargs basename 2>/dev/null || true)
      if [ -n "$interp" ]; then
        local ok=0
        for a in "${allowed[@]}"; do
          [ "$interp" = "$a" ] && ok=1 && break
        done
        if [ "$ok" -eq 0 ]; then
          printf "FAIL %s: shebang interpreter '%s' not in allowlist [%s] for %s/\n" \
            "$rel" "$interp" "$(IFS=','; echo "${allowed[*]}")" "$dir_rel" >&2
          FAIL=1
        fi
      fi
    fi

    # Check heredoc interpreter markers (e.g. <<'PYTHON', <<EOF used with python3).
    # This catches scripts that launch sub-interpreters via heredocs.
    while IFS= read -r line; do
      local heredoc_interp
      heredoc_interp=$(echo "$line" | grep -oE '\b(python3?|node|ruby|perl|php|Rscript)\b' | head -1 || true)
      if [ -n "$heredoc_interp" ]; then
        local ok=0
        for a in "${allowed[@]}"; do
          [ "$heredoc_interp" = "$a" ] && ok=1 && break
        done
        if [ "$ok" -eq 0 ]; then
          printf "FAIL %s: heredoc/inline interpreter '%s' not in allowlist [%s] for %s/\n" \
            "$rel" "$heredoc_interp" "$(IFS=','; echo "${allowed[*]}")" "$dir_rel" >&2
          FAIL=1
        fi
      fi
    done < "$script"

  done < <(find "$dir" -maxdepth 1 -name '*.sh' -print0)
}

for entry in "${ALLOWLIST_MAP[@]}"; do
  IFS=':' read -r dir_rel allowed_raw <<< "$entry"
  IFS=':' read -ra allowed_arr <<< "$allowed_raw"
  check_dir "$dir_rel" "${allowed_arr[@]}"
done

if [ "$FAIL" -eq 0 ]; then
  echo "dir-toolchain: PASS"
  exit 0
else
  echo "" >&2
  echo "dir-toolchain: FAIL — one or more scripts use interpreters outside the allowlist." >&2
  echo "  Fix: either restrict the script to the allowed interpreter(s), or update" >&2
  echo "  the allowlist in tests/l1-lint/dir-toolchain.sh if the constraint has changed." >&2
  exit 1
fi
