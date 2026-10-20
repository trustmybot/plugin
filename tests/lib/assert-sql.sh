#!/usr/bin/env bash
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/skills/tmb_planning/scripts/assert-sql.sh" "$@"
