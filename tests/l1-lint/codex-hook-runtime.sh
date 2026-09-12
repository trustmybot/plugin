#!/usr/bin/env bash
# Lint: keep the Codex Scope 5 Hook runtime small, self-contained, and pinned
# to the exact bytes named by the installed manifest.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

MANIFEST="hooks/codex/hooks.json"
PRD="docs/adapters/codex/SCOPE_5_PRD.md"
RUNTIME_FILES=(
  adapters/codex/hooks/dispatcher.mjs
  adapters/codex/hooks/repo-policy.mjs
  adapters/codex/hooks/branch-policy.mjs
  adapters/codex/hooks/restricted-runner.mjs
  adapters/codex/hooks/restricted-profile.mjs
  adapters/codex/hooks/forge-binding.mjs
  adapters/codex/tool-names.mjs
)

for file in "${RUNTIME_FILES[@]}" "$MANIFEST"; do
  if [ ! -f "$file" ]; then
    printf 'codex-hook-runtime: missing %s\n' "$file" >&2
    exit 1
  fi
done
for file in "${RUNTIME_FILES[@]}"; do node --check "$file"; done

runtime_files="$(find adapters/codex/hooks -mindepth 1 -maxdepth 1 -type f -print | LC_ALL=C sort)"
expected_files="$(printf '%s\n' "${RUNTIME_FILES[@]}" | sed '/^adapters\/codex\/tool-names\.mjs$/d' | LC_ALL=C sort)"
if [ "$runtime_files" != "$expected_files" ]; then
  printf 'codex-hook-runtime: runtime directory differs from the fixed digest file list\n' >&2
  exit 1
fi

if ! node -e '
  const { readFileSync } = require("node:fs");
  const { dirname, resolve } = require("node:path");
  const files = process.argv.slice(1);
  const allowed = new Set(files.map(file => resolve(file)));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)[\x22\x27]([^\x22\x27]+)[\x22\x27]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith("node:")
        && !(specifier.startsWith(".") && allowed.has(resolve(dirname(file), specifier)))) {
        console.error(`${file}: unsigned import ${specifier}`);
        process.exit(1);
      }
    }
  }
' "${RUNTIME_FILES[@]}"; then
  printf 'codex-hook-runtime: third-party or unsigned cross-package import detected\n' >&2
  exit 1
fi

# The independent oracle never imports executable runtime modules before checking them.
actual_digest="$(node scripts/maintenance/update-codex-hook-digest.mjs --check)"

documented_digest="$(rg -o 'Hook runtime digest `[a-f0-9]{64}`' "$PRD" | rg -o '[a-f0-9]{64}' || true)"
if [ "$documented_digest" != "$actual_digest" ]; then
  printf 'codex-hook-runtime: PRD digest mismatch (documented %s, actual %s)\n' "${documented_digest:-missing}" "$actual_digest" >&2
  exit 1
fi

# Execution modules may create only private scratch configuration. Decision
# modules remain read-only; integration suites verify execution module paths.
DECISION_FILES=()
for file in "${RUNTIME_FILES[@]}"; do
  case "$file" in
    adapters/codex/hooks/restricted-runner.mjs|adapters/codex/hooks/forge-binding.mjs) ;;
    *) DECISION_FILES+=("$file") ;;
  esac
done
if grep -nE 'node_modules|https?://|fetch\(|XMLHttpRequest|appendFile|writeFile|createWriteStream' "${DECISION_FILES[@]}" >/dev/null; then
  printf 'codex-hook-runtime: decision modules must not read node_modules, access the network, or write files/logs\n' >&2
  exit 1
fi

printf 'codex-hook-runtime: syntax, file boundary, zero-dependency policy, and %s artifact digest PASS\n' "$actual_digest"
