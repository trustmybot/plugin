#!/usr/bin/env bash
set -euo pipefail
resp="$(seq 1 100000)"
if echo "$resp" | grep -e '^5$' -q; then echo found; fi
