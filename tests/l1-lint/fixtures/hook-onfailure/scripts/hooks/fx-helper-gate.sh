#!/usr/bin/env bash
# Fixture: denies through a helper from a library it sources.
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/lib/fx-lib.sh"
cat >/dev/null
tmb_deny_fx
