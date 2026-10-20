#!/usr/bin/env bash
set -euo pipefail
resp="$(seq 1 100000)"
if echo "$resp" | grep -q '^5$'; then echo found; fi
