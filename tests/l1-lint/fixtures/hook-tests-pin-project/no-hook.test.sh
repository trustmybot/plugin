#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../../../scripts/hooks/lib/cmd-analysis.sh"
tmb_cmd_strip_literals 'echo hi'
