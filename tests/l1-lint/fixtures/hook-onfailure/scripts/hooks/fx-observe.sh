#!/usr/bin/env bash
# Fixture: observe-only. A comment naming "permissionDecision": "deny" and
# tmb_deny_fx does not make it deny-capable; neither does a library it sources.
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/lib/fx-lib.sh"
cat >/dev/null
fx_context
