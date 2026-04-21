#!/usr/bin/env bash
# Hook: Enforce bro/tasks/*.xml files use timestamp naming: YYYYMMDD-HHMM_descriptive_name.xml
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only enforce for bro/tasks/ files
case "$FILE_PATH" in
  *bro/tasks/*.xml) ;;
  *) exit 0 ;;
esac

# Exempt archive directory
case "$FILE_PATH" in
  *bro/tasks/archive/*) exit 0 ;;
esac

BASENAME=$(basename "$FILE_PATH")

# Expected pattern: YYYYMMDD-HHMM_name.xml
if ! echo "$BASENAME" | grep -qE '^[0-9]{8}-[0-9]{4}_[a-zA-Z0-9_.-]+\.xml$'; then
  echo "{\"decision\":\"block\",\"reason\":\"BLOCKED: Task file name '$BASENAME' must match YYYYMMDD-HHMM_descriptive_name.xml (e.g., 20260421-1430_fix_auth.xml). Use \`date +%Y%m%d-%H%M\` for the timestamp.\"}"
  exit 0
fi

exit 0
