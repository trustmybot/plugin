#!/usr/bin/env bash
# Cheatcode-install-plugins L5 isolation: seed a deterministic marketplace-install
# fixture and point cheatcode_install at it via TMB_CHEATCODE_INSTALL_FIXTURE so
# no live web / real marketplace call is ever made. The fixture lives in the
# project dir; the env export covers runners that source this setup.
#
# Both candidates are plugin-kind. The fixture supplies attachments[] that pass
# through verbatim — the per-agent attachment targets the install records: the
# feature-dev plugin attaches to swe, the code-review plugin to pr-reviewer. The
# {installed, version} object stands in for the marketplace result; the
# cheatcodes + attachment + audit rows the install writes are computed the same
# way regardless, so the fixture only enriches the reported version + targets. No
# network.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

FIXTURE="$PROJECT/.tmb-cheatcode-install-fixture.json"
cat > "$FIXTURE" <<'JSON'
{
  "installed": true,
  "version": "1.0.0",
  "error": null,
  "attachments": [
    { "target": "swe", "artifact": "marketplace-plugin:feature-dev" },
    { "target": "pr-reviewer", "artifact": "marketplace-plugin:code-review" }
  ]
}
JSON

export TMB_CHEATCODE_INSTALL_FIXTURE="$FIXTURE"
