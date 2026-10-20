#!/usr/bin/env bash
LOG="${TMPDIR:-/tmp}/tmb-kuzu-install.log"
echo x > "$LOG"
cat /tmp/tmb-out.log
grep foo /tmp/a.log > "$TMPDIR/b"
WS="$(mktemp -d "${TMPDIR:-/tmp}/tmb-good.XXXXXX")"
mkdir -p "$WS/sub"
cp /tmp/source.txt "$WS/dest.txt"
echo "use /tmp sparingly" > "$WS/note"
# echo x > /tmp/commented
diff <(sort /tmp/a) <(sort /tmp/b) > "$WS/diff"
