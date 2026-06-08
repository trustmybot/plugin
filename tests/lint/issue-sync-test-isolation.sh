#!/usr/bin/env bash
# L1 lint: every it(...) block that enables issue_sync (auto|glab|gh|on) must also
# reference _spawnFn or makeSpawnFn to prevent real remote API calls during npm test.
#
# Uses awk to extract it(...) blocks (brace-depth tracking) and checks each block
# independently for the config_set pattern and spawn-fn reference.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
TEST_DIR="$PLUGIN_ROOT/mcp/trajectory-server/src/test"

FAIL=0

while IFS= read -r file; do
  relpath="${file#"$PLUGIN_ROOT/"}"

  # Use awk to extract each it(...) block and check it independently.
  # State machine: track brace depth; when depth returns to 0 after an it( open, emit block.
  awk -v relpath="$relpath" '
  BEGIN {
    in_block = 0
    depth = 0
    block_start = 0
    block_text = ""
    fail = 0
  }

  {
    line = $0
    lnum = NR
  }

  # Detect start of an it( block (not already inside one)
  !in_block && /^[[:space:]]*it\(/ {
    in_block = 1
    depth = 0
    block_start = lnum
    block_text = ""
  }

  in_block {
    block_text = block_text line "\n"
    # Count braces on this line
    n = split(line, chars, "")
    for (i = 1; i <= n; i++) {
      if (chars[i] == "{") depth++
      else if (chars[i] == "}") {
        depth--
        if (depth == 0) {
          # End of it() block — check it
          if (block_text ~ /config_set.*issue_sync.*["'"'"'](auto|glab|gh|on)["'"'"']/) {
            if (block_text !~ /_spawnFn|makeSpawnFn/) {
              printf "FAIL: %s:%d — sets issue_sync active but no _spawnFn/makeSpawnFn in it() block\n", relpath, block_start
              fail = 1
            }
          }
          in_block = 0
          block_text = ""
          block_start = 0
          depth = 0
          break
        }
      }
    }
  }

  END { exit fail }
  ' "$file" || FAIL=1

done < <(find "$TEST_DIR" -name "*.test.ts" 2>/dev/null)

if [ "$FAIL" -eq 0 ]; then
  echo "OK: all issue_sync-enabling test blocks reference spawn-fn injection"
  exit 0
else
  exit 1
fi
