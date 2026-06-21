#!/usr/bin/env bash
# Cheatcode-install L5 isolation: seed a deterministic marketplace-install
# fixture and point cheatcode_install at it via TMB_CHEATCODE_INSTALL_FIXTURE so
# no live web / real marketplace call is ever made. The fixture lives in the
# project dir; the env export covers runners that source this setup. The
# {installed, version} object stands in for the marketplace result — the
# attachment + audit records the install writes are computed the same way
# regardless, so the fixture only enriches the reported version.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

FIXTURE="$PROJECT/.tmb-cheatcode-install-fixture.json"
cat > "$FIXTURE" <<'JSON'
{ "installed": true, "version": "1.4.0", "error": null }
JSON

export TMB_CHEATCODE_INSTALL_FIXTURE="$FIXTURE"
