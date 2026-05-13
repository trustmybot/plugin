#!/usr/bin/env bash
# Thin wrapper — defers to the parameterized SWE-bench runner.
exec "$PLUGIN_ROOT/tests/dogfood/bench/lib/swebench-runner.sh" verify "$@"
