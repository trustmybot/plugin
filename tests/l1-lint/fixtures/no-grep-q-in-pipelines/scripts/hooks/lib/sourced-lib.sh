#!/usr/bin/env bash
# Sourced library: no pipefail line of its own, inherits the caller's.
has_five() { printf '%s\n' "$1" | grep -q '^5$'; }
