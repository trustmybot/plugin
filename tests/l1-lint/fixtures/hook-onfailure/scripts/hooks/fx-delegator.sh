#!/usr/bin/env bash
# Fixture: runs another gate that denies.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/fx-gate.sh"
