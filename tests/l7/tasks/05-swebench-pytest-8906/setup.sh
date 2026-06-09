#!/usr/bin/env bash
# Thin wrapper — defers to the parameterized SWE-bench runner.
exec "$PLUGIN_ROOT/tests/l7/lib/swebench-runner.sh" setup "$@"
