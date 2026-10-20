#!/usr/bin/env bash
echo x > /tmp/tmb-out.log # VIOLATION
echo y >> "/var/tmp/claude.log" # VIOLATION
mkdir -p /tmp/tmb-state # VIOLATION
LOG_DIR="/tmp/tmb-logs"
touch "$LOG_DIR/a" # VIOLATION
printf 'z' | tee -a /private/tmp/tmb.txt >/dev/null # VIOLATION
cp a.txt /tmp/b.txt # VIOLATION
mktemp /tmp/tmb.XXXXXX # VIOLATION
mktemp -d -p /tmp # VIOLATION
export TMPDIR=/tmp # VIOLATION
OUT="$LOG_DIR/out"
mv -f x "$OUT" # VIOLATION
