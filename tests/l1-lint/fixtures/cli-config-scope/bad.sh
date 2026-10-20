#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2154,SC2086,SC2093,SC2006
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
"$CLAUDE" plugin install "$ref" # VIOLATION
${CLAUDE_BIN} mcp remove "$name" # VIOLATION
bin=claude
"$bin" plugin install "$ref" --scope user # VIOLATION
cli="$(command -v claude)"
$cli mcp add "$name" "$url" # VIOLATION
/usr/local/bin/claude mcp remove "$name" # VIOLATION
"$HOME/.local/bin/claude" plugin install "$ref" # VIOLATION
command claude plugin install "$ref" # VIOLATION
exec claude mcp add "$name" "$url" # VIOLATION
CLAUDE_CONFIG_DIR=/tmp/x claude plugin enable "$name" # VIOLATION
claude plugin "$sub" "$name" # VIOLATION
claude mcp $op "$name" # VIOLATION
claude --debug mcp remove "$name" # VIOLATION
claude --settings "$file" plugin install "$ref" # VIOLATION
claude plugin install "$ref" --scope project --scope user # VIOLATION
claude mcp add -s project --scope=local "$name" "$url" # VIOLATION
claude plugin install "$ref" -s user # VIOLATION
echo "a # b"; claude plugin install "$ref" # VIOLATION
claude plugin marketplace update "$mkt" # VIOLATION
claude plugin marketplace update "$mkt" --scope project # VIOLATION
claude mcp add-from-claude-desktop # VIOLATION
claude plugin i "$ref" # VIOLATION
claude plugins install "$ref" # VIOLATION
claude plugin marketplace rm "$mkt" # VIOLATION
claude plugin marketplace add "$url" -s project # VIOLATION
claude plugin configure "$name" --values-stdin # VIOLATION
claude plugin init "$name" # VIOLATION
claude plugin new "$name" # VIOLATION
claude plugin prune -y # VIOLATION
claude plugin autoremove --scope local # VIOLATION
claude mcp login "$name" # VIOLATION
claude mcp logout "$name" # VIOLATION
claude mcp reset-project-choices # VIOLATION
claude mcp add "$name" -- npx srv --scope project # VIOLATION
ok=`claude mcp remove "$name"` # VIOLATION
bash <<EOF
claude plugin install foo # VIOLATION
EOF
