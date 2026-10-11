#!/usr/bin/env bash
LOG_DIR="${HOME}/.claude/tmb/logs"
mkdir -p "$LOG_DIR" # VIOLATION
echo x >> "$LOG_DIR/a.log" # VIOLATION
printf '%s\n' "$WS" > "$HOME/.claude/tmb-active-workspace" # VIOLATION
cp a.txt ~/.claude/b.txt # VIOLATION
tmp="${LOG_DIR}/x.tmp"
mv -f "$tmp" "$LOG_DIR/x" # VIOLATION
echo y | tee -a "$HOME/out.log" >/dev/null # VIOLATION
