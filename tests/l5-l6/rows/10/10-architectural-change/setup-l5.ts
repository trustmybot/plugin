// Pre-seed a minimal src/cli.py that L6 would inherit from prior chain steps
// (rows 4–7 built + committed the TODO CLI). Bro is asked to extract the
// storage layer — so the file must exist as prior context.
import { gitCommit, setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
writeFile(
  project,
  'src/cli.py',
  `"""TODO CLI — stores tasks in a JSON file."""
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
`,
);
gitCommit(project, ['src/cli.py'], 'feat: initial todo CLI with JSON storage');
