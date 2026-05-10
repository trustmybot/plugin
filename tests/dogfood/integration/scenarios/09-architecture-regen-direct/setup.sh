#!/usr/bin/env bash
# Pre-seed a small Python source tree so architecture_regen has something
# to scan. Without this, bro correctly responds "nothing to refresh"
# (an empty repo has no architecture).
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src/myproj"
cat > "$PROJECT/src/myproj/__init__.py" <<'PY'
"""myproj — sample project for architecture_regen scenario."""
PY
cat > "$PROJECT/src/myproj/cli.py" <<'PY'
import sys
from .core import run

def main():
    print(run(sys.argv[1:]))

if __name__ == "__main__":
    main()
PY
cat > "$PROJECT/src/myproj/core.py" <<'PY'
def run(args):
    return " ".join(args) if args else "noop"
PY
cat > "$PROJECT/pyproject.toml" <<'TOML'
[project]
name = "myproj"
version = "0.0.1"
TOML

(
  cd "$PROJECT" || exit 1
  git add src pyproject.toml
  git commit -qm 'feat: scaffold src/myproj package'
) >/dev/null
