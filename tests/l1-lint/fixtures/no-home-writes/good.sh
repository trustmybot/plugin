#!/usr/bin/env bash
# mkdir -p "$HOME/.claude" — a comment, not a write
MANIFEST="$HOME/.claude/plugins/installed_plugins.json"
jq -r '.plugins' "$MANIFEST" 2>/dev/null
cp "$MANIFEST" "$PROJECT/.claude/tmb/manifest.json"
mkdir -p "$CLAUDE_PROJECT_DIR/.claude/tmb/logs"
echo x >> "$STATE_DIR/logs/a.log" 2>&1
grep -q foo "$HOME/.claude.json" > /dev/null
