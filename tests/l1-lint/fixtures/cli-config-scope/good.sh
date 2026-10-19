#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2154
# claude plugin install "$ref" — comment lines are skipped
timeout 30 claude plugin install "$ref" --scope project 2>/dev/null
claude plugin uninstall "$name" --scope project --keep-data
claude plugin remove "$name" --scope=project
claude plugin enable "$name" --scope project
claude plugin disable "$name" --scope project
claude plugin update "$name" --scope project
claude plugin marketplace add "$url" --scope project
claude plugin marketplace remove "$mkt" --scope project
claude mcp add --scope project "$name" "$url"
claude mcp add-json --scope project "$name" "$json"
claude mcp remove "$name" --scope project
out=$(claude plugin install "$ref" \
  --scope project 2>&1)
claude plugin list --json
claude plugin marketplace list --json
claude mcp list
claude mcp get "$name"
claude plugin validate --strict .
echo "x" # claude mcp remove "$name" in a trailing comment
