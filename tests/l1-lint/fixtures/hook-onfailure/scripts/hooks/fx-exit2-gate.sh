#!/usr/bin/env bash
# Fixture: blocks with exit 2.
cat >/dev/null
echo "fx blocked" >&2
exit 2
