#!/usr/bin/env bash
set -euo pipefail
resp="$(seq 1 100000)"
if echo "$resp" | grep --fixed-strings -q '5'; then echo found; fi
