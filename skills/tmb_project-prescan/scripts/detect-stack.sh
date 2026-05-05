#!/usr/bin/env bash
set -eo pipefail

CWD="$PWD"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd)
      CWD="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$CWD" ]]; then
  echo "Error: --cwd path does not exist: $CWD" >&2
  exit 1
fi

cd "$CWD"

DETECTOR="file-presence"
LANGUAGES_JSON="[]"

if command -v enry &>/dev/null; then
  ENRY_OUT=$(enry --json 2>/dev/null || true)
  if [[ -n "$ENRY_OUT" ]]; then
    LANGUAGES_JSON=$(echo "$ENRY_OUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
langs = sorted(set(k.lower() for k in data.keys()))
print(json.dumps(langs))
" 2>/dev/null || echo "[]")
    DETECTOR="enry"
  fi
elif command -v tokei &>/dev/null; then
  TOKEI_OUT=$(tokei --output json 2>/dev/null || true)
  if [[ -n "$TOKEI_OUT" ]]; then
    LANGUAGES_JSON=$(echo "$TOKEI_OUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
langs = sorted(set(k.lower() for k in data.keys() if k not in ('Total',)))
print(json.dumps(langs))
" 2>/dev/null || echo "[]")
    DETECTOR="tokei"
  fi
fi

if [[ "$DETECTOR" == "file-presence" ]]; then
  DETECTED_LANGS=()
  [[ -f "pyproject.toml" || -f "requirements.txt" || -f "setup.py" || -f "Pipfile" ]] && DETECTED_LANGS+=("python")
  [[ -f "package.json" ]] && DETECTED_LANGS+=("javascript")
  [[ -f "tsconfig.json" ]] && DETECTED_LANGS+=("typescript")
  [[ -f "Cargo.toml" ]] && DETECTED_LANGS+=("rust")
  [[ -f "go.mod" ]] && DETECTED_LANGS+=("go")
  [[ -f "Gemfile" ]] && DETECTED_LANGS+=("ruby")
  [[ -f "pom.xml" || -f "build.gradle" ]] && DETECTED_LANGS+=("java")
  [[ -f "build.gradle.kts" ]] && DETECTED_LANGS+=("kotlin")
  [[ -f "composer.json" ]] && DETECTED_LANGS+=("php")
  [[ -f "mix.exs" ]] && DETECTED_LANGS+=("elixir")

  if [[ ${#DETECTED_LANGS[@]} -gt 0 ]]; then
    LANGUAGES_JSON=$(printf '%s\n' "${DETECTED_LANGS[@]}" | python3 -c "
import json, sys
langs = [l.strip() for l in sys.stdin.read().strip().split('\n') if l.strip()]
print(json.dumps(sorted(langs)))
" 2>/dev/null || echo "[]")
  fi
fi

FILES_PRESENT=()
for candidate in pyproject.toml requirements.txt setup.py Pipfile package.json tsconfig.json Cargo.toml go.mod Gemfile pom.xml build.gradle build.gradle.kts composer.json mix.exs; do
  [[ -f "$candidate" ]] && FILES_PRESENT+=("$candidate")
done

if [[ ${#FILES_PRESENT[@]} -gt 0 ]]; then
  FILES_PRESENT_JSON=$(printf '%s\n' "${FILES_PRESENT[@]}" | python3 -c "
import json, sys
files = [f.strip() for f in sys.stdin.read().strip().split('\n') if f.strip()]
print(json.dumps(sorted(files)))
" 2>/dev/null || echo "[]")
else
  FILES_PRESENT_JSON="[]"
fi

PKG_MANAGERS=()
for pm in uv poetry pip pipx bun pnpm npm yarn cargo go bundler maven gradle composer mix; do
  command -v "$pm" &>/dev/null && PKG_MANAGERS+=("$pm")
done

if [[ ${#PKG_MANAGERS[@]} -gt 0 ]]; then
  PKG_JSON=$(printf '%s\n' "${PKG_MANAGERS[@]}" | python3 -c "
import json, sys
items = [x.strip() for x in sys.stdin.read().strip().split('\n') if x.strip()]
print(json.dumps(items))
" 2>/dev/null || echo "[]")
else
  PKG_JSON="[]"
fi

TEST_RUNNERS=()
for tr in pytest jest vitest mvn gradle rspec; do
  command -v "$tr" &>/dev/null && TEST_RUNNERS+=("$tr")
done

if [[ ${#TEST_RUNNERS[@]} -gt 0 ]]; then
  TEST_JSON=$(printf '%s\n' "${TEST_RUNNERS[@]}" | python3 -c "
import json, sys
items = [x.strip() for x in sys.stdin.read().strip().split('\n') if x.strip()]
print(json.dumps(items))
" 2>/dev/null || echo "[]")
else
  TEST_JSON="[]"
fi

LINTERS=()
for linter in ruff black eslint prettier clippy gofmt rubocop; do
  command -v "$linter" &>/dev/null && LINTERS+=("$linter")
done

if [[ ${#LINTERS[@]} -gt 0 ]]; then
  LINT_JSON=$(printf '%s\n' "${LINTERS[@]}" | python3 -c "
import json, sys
items = [x.strip() for x in sys.stdin.read().strip().split('\n') if x.strip()]
print(json.dumps(items))
" 2>/dev/null || echo "[]")
else
  LINT_JSON="[]"
fi

REMOTES_JSON="[]"
if git rev-parse --git-dir &>/dev/null 2>&1; then
  REMOTES_RAW=$(git remote -v 2>/dev/null | grep '(fetch)' | awk '{print $1"\t"$2}' || true)
  if [[ -n "$REMOTES_RAW" ]]; then
    REMOTES_JSON=$(echo "$REMOTES_RAW" | python3 -c "
import json, sys, re
remotes = []
for line in sys.stdin.read().strip().split('\n'):
  if not line.strip():
    continue
  parts = line.split('\t', 1)
  if len(parts) != 2:
    continue
  name, url = parts
  provider = 'other'
  if 'github.com' in url:
    provider = 'github'
  elif 'gitlab.com' in url or re.search(r'gitlab\.[a-z]+\.[a-z]+', url):
    provider = 'gitlab'
  elif 'bitbucket.org' in url:
    provider = 'bitbucket'
  elif 'codeberg.org' in url:
    provider = 'codeberg'
  elif 'dev.azure.com' in url:
    provider = 'azuredev'
  remotes.append({'name': name, 'provider': provider, 'url': url})
print(json.dumps(remotes))
" 2>/dev/null || echo "[]")
  fi
fi

DETECTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

python3 - <<PYEOF
import json
print(json.dumps({
  "files_present": $FILES_PRESENT_JSON,
  "languages": $LANGUAGES_JSON,
  "package_managers": $PKG_JSON,
  "test_runners": $TEST_JSON,
  "linters": $LINT_JSON,
  "git_remotes": $REMOTES_JSON,
  "detector": "$DETECTOR",
  "detected_at": "$DETECTED_AT",
}, indent=2))
PYEOF
