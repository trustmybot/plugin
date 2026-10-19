#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2154
timeout 30 claude plugin install "$ref" >/dev/null 2>&1 # VIOLATION
claude plugin install "$ref" --scope user # VIOLATION
claude plugin install "$ref" --scope "$scope" # VIOLATION
claude plugin uninstall "$name" --keep-data # VIOLATION
claude plugin remove "$name" # VIOLATION
claude plugin enable "$name" # VIOLATION
claude plugin disable "$name" # VIOLATION
claude plugin update "$name" # VIOLATION
claude plugin marketplace add "$url" # VIOLATION
claude plugin marketplace remove "$mkt" # VIOLATION
claude mcp add "$name" "$url" # VIOLATION
claude mcp add-json "$name" "$json" # VIOLATION
claude mcp remove "$name" # VIOLATION
claude mcp add --scope local "$name" "$url" # VIOLATION
claude mcp remove "$name" && echo --scope project # VIOLATION
out=$(claude plugin install "$ref" --name VIOLATION \
  --scope user 2>&1)
