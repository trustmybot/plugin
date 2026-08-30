#!/usr/bin/env bash
# Lint: keep the Codex Scope 5 Hook runtime small, self-contained, and pinned
# to the exact bytes named by the installed manifest.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DISPATCHER="adapters/codex/hooks/dispatcher.mjs"
POLICY="adapters/codex/hooks/repo-policy.mjs"
MANIFEST="hooks/codex/hooks.json"
PRD="docs/adapters/codex/SCOPE_5_PRD.md"

for file in "$DISPATCHER" "$POLICY" "$MANIFEST"; do
  if [ ! -f "$file" ]; then
    printf 'codex-hook-runtime: missing %s\n' "$file" >&2
    exit 1
  fi
done

node --check "$DISPATCHER"
node --check "$POLICY"

runtime_files="$(find adapters/codex/hooks -mindepth 1 -maxdepth 1 -type f -print | LC_ALL=C sort)"
expected_files="$(printf '%s\n' "$DISPATCHER" "$POLICY" | LC_ALL=C sort)"
if [ "$runtime_files" != "$expected_files" ]; then
  printf 'codex-hook-runtime: runtime directory must contain exactly dispatcher.mjs and repo-policy.mjs\n' >&2
  exit 1
fi

if ! node -e '
  const { readFileSync } = require("node:fs");
  for (const file of process.argv.slice(1)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bfrom\s+[\x22\x27]([^\x22\x27]+)[\x22\x27]/g)) {
      if (!match[1].startsWith("node:")) process.exit(1);
    }
  }
' "$DISPATCHER" "$POLICY"; then
  printf 'codex-hook-runtime: third-party or cross-package static import detected\n' >&2
  exit 1
fi

expected_digest="$(jq -er '.hooks.PreToolUse[0].hooks[0].command | capture("--policy-sha256 (?<digest>[a-f0-9]{64})").digest' "$MANIFEST")"
actual_digest="$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  process.stdout.write(
    createHash("sha256")
      .update(readFileSync(process.argv[1]))
      .update("\0")
      .update(readFileSync(process.argv[2]))
      .digest("hex"),
  );
' "$DISPATCHER" "$POLICY")"

if [ "$actual_digest" != "$expected_digest" ]; then
  printf 'codex-hook-runtime: manifest digest mismatch (expected %s, actual %s)\n' "$expected_digest" "$actual_digest" >&2
  exit 1
fi

documented_digest="$(rg -o 'Hook runtime digest `[a-f0-9]{64}`' "$PRD" | rg -o '[a-f0-9]{64}' || true)"
if [ "$documented_digest" != "$actual_digest" ]; then
  printf 'codex-hook-runtime: PRD digest mismatch (documented %s, actual %s)\n' "${documented_digest:-missing}" "$actual_digest" >&2
  exit 1
fi

if grep -R -nE 'node_modules|https?://|fetch\(|XMLHttpRequest|appendFile|writeFile|createWriteStream' "$DISPATCHER" "$POLICY" >/dev/null; then
  printf 'codex-hook-runtime: runtime must not read node_modules, access the network, or write files/logs\n' >&2
  exit 1
fi

printf 'codex-hook-runtime: syntax, file boundary, zero-dependency policy, and %s digest PASS\n' "$actual_digest"
