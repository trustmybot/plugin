#!/usr/bin/env bash
# Pre-seed a minimal src/cli.py that L6 would inherit from prior chain steps
# (rows 4–7 built + committed the TODO CLI). Bro is asked to extract the
# storage layer — so the file must exist as prior context.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/cli.py" <<'PY'
"""TODO CLI — stores tasks in a JSON file."""
import json, os, sys

DATA_FILE = "tasks.json"

def load():
    if not os.path.exists(DATA_FILE):
        return []
    with open(DATA_FILE) as f:
        return json.load(f)

def save(tasks):
    with open(DATA_FILE, "w") as f:
        json.dump(tasks, f, indent=2)

def main():
    tasks = load()
    if len(sys.argv) < 2:
        for t in tasks:
            print(f"- {t}")
        return
    cmd = sys.argv[1]
    if cmd == "add" and len(sys.argv) > 2:
        tasks.append(" ".join(sys.argv[2:]))
        save(tasks)
        print("added.")
    else:
        print(f"unknown command: {cmd}")

if __name__ == "__main__":
    main()
PY

(
  cd "$PROJECT" || exit 1
  git add src/cli.py
  git commit -qm 'feat: initial todo CLI with JSON storage'
) >/dev/null
