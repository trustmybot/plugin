#!/usr/bin/env bash
# Tests for scripts/lib/resolve-headless-hook.sh (#74/#680).
#
# The resolver discovers the ACTIVE tmb cache version at hook-fire time and execs
# .../cache/<mp>/tmb/<version>/scripts/hooks/<basename>.sh, forwarding stdin +
# argv. A version bump must re-resolve with ZERO stale refs — this IS the issue
# acceptance. Empty/unresolvable cache must FAIL OPEN LOUD (exit 0 + stderr warn,
# never exit 2, never crash).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
RESOLVER="$PLUGIN_ROOT/scripts/lib/resolve-headless-hook.sh"

MP="trustmybot"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CLAUDE_HOME="$WORK/.claude"
CACHE="$CLAUDE_HOME/plugins/cache/$MP/tmb"
MANIFEST="$CLAUDE_HOME/plugins/installed_plugins.json"
mkdir -p "$CLAUDE_HOME/plugins"

# Materialize a fake version dir whose target hook echoes a marker + its argv and
# cats stdin, so we can prove which version resolved and that I/O passes through.
make_version() {
  local version="$1"
  local hookdir="$CACHE/$version/scripts/hooks"
  mkdir -p "$hookdir"
  cat >"$hookdir/probe.sh" <<EOF
#!/usr/bin/env bash
echo "VERSION=$version"
echo "ARGV=\$*"
echo "STDIN=\$(cat)"
EOF
  chmod +x "$hookdir/probe.sh"
}

write_manifest() {
  local version="$1"
  cat >"$MANIFEST" <<EOF
{
  "version": 2,
  "plugins": {
    "tmb@$MP": [
      {
        "scope": "local",
        "installPath": "$CACHE/$version",
        "version": "$version"
      }
    ]
  }
}
EOF
}

run_resolver() {
  # $1 = stdin payload; remaining args appended after --hook probe
  local payload="$1"; shift
  echo "$payload" | env CLAUDE_CONFIG_DIR="$CLAUDE_HOME" \
    bash "$RESOLVER" --marketplace "$MP" --hook probe "$@" 2>"$WORK/stderr"
}

# Two version dirs in the cache; manifest declares the OLDER one active. The
# resolver must honor the manifest, not just the highest semver.
make_version "0.9.0"
make_version "0.10.0-alpha"
write_manifest "0.9.0"

test_case "resolves the manifest-declared active version (not highest semver)"
out="$(run_resolver "hello-stdin" extra-arg)"
rc=$?
assert_exit_code 0 "$rc" "resolver exit code"
assert_contains "$out" "VERSION=0.9.0" "resolved manifest-active version"
assert_not_contains "$out" "VERSION=0.10.0-alpha" "did not resolve a stale version"

test_case "forwards stdin and pass-through argv untouched"
assert_contains "$out" "STDIN=hello-stdin" "stdin forwarded"
assert_contains "$out" "ARGV=extra-arg" "argv forwarded"

# Acceptance: bump the active version in the manifest. Zero stale refs — the
# resolver now execs the new version with no code change.
test_case "version bump re-resolves to the new active version with zero stale refs"
write_manifest "0.10.0-alpha"
out2="$(run_resolver "again")"
rc=$?
assert_exit_code 0 "$rc" "resolver exit code after bump"
assert_contains "$out2" "VERSION=0.10.0-alpha" "resolved bumped version"
assert_not_contains "$out2" "VERSION=0.9.0" "no stale reference to old version"

# Fallback: no manifest, highest-semver dir under the marketplace cache wins.
test_case "no manifest: falls back to highest-semver cache dir"
rm -f "$MANIFEST"
out3="$(run_resolver "fb")"
rc=$?
assert_exit_code 0 "$rc" "resolver exit code on fallback"
assert_contains "$out3" "VERSION=0.10.0-alpha" "fallback picked highest semver"

# Fail-open-loud: empty cache + no manifest → exit 0 with a loud stderr warning.
test_case "empty/unresolvable cache fails OPEN LOUD (exit 0 + stderr warning, never 2)"
rm -rf "$CACHE"
out4="$(run_resolver "x")"
rc=$?
assert_exit_code 0 "$rc" "fail-open exit code is 0 (never 2)"
assert_eq "" "$out4" "no stdout on fail-open"
err="$(cat "$WORK/stderr")"
assert_contains "$err" "TMB resolve-hook" "loud stderr warning present"
assert_contains "$err" "failing OPEN" "warning states it is failing open"

summarize
