#!/usr/bin/env bash
# Sourced library outside scripts/hooks/lib: no pipefail line of its own, inherits the caller's.
has_five() { printf '%s\n' "$1" | grep -Eq '^5$'; }
