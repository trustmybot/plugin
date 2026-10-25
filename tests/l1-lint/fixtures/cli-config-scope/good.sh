#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2154,SC2086
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
claude plugin details "$name"
claude plugins list
claude plugin --help
claude mcp help add
echo "x" # claude mcp remove "$name" in a trailing comment
claude plugin install "$ref" -s project
claude mcp remove "$name" -s project
claude mcp add --scope=project "$name" "$url"
claude plugin install "$ref" --scope user --scope project
echo "a # b"; claude plugin install "$ref" --scope project
echo 'a # b' && claude mcp remove "$name" -s project
"$CLAUDE" plugin install "$ref" --scope project
command claude mcp add -s project "$name" "$url"
/usr/local/bin/claude plugin marketplace add "$url" --scope=project
claude --debug mcp remove "$name" --scope project
claude plugin "$sub" "$name" --scope project
claude plugin prune -y -s project
claude mcp add-from-claude-desktop -s project
claude plugin marketplace rm "$mkt" --scope project
claude plugin marketplace list
n=${#items[@]}; echo "$#"; claude plugin i "$ref" --scope project
cat <<EOF
don't stop: the quote above is heredoc text
EOF
claude plugin enable "$name" --scope project
command -v claude >/dev/null
echo "$CLAUDE_PROJECT_DIR"
UPDATE_CMD="claude plugin update $INSTALL_KEY --scope $INSTALL_SCOPE" # cli-config-scope: printed
cat > "$README" <<'NOTES' # cli-config-scope: printed
claude plugin marketplace update trustmybot-rc
claude plugin disable tmb@<marketplace> --scope local
NOTES
