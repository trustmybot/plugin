#!/usr/bin/env bash
# L1 lint: TMB prescribes plugin changes only as CLI commands run from the
# project root with an explicit scope (`claude plugin update tmb@trustmybot-dev
# --scope local`), never as the in-session commands `/plugin …`,
# `/reload-plugins` or reconnecting through `/mcp` (GH 1730). A plugin change
# applies only after a full quit and relaunch of Claude Code, and `/plugin`
# does not work in Claude Desktop.
#
# Flags `/plugin`, `/reload-plugins` and `/mcp` used as a command: preceded by
# the start of the line, whitespace, a backtick, a quote or `(`, and followed by
# whitespace, a backtick, a quote, `)`, the end of the line, or `.` `,` `;` `:`
# that does not start a file extension or a path. Path segments pass
# (`trustmybot/plugin`, `/plugin/`, `.../plugin.json`, `logs/mcp-server.log`),
# and so do absolute paths given to `cd` or a Dockerfile WORKDIR, COPY, ADD or
# VOLUME line.
#
# Scans every git-tracked *.md, *.sh, *.ts, *.mjs, *.js, *.json and *.yml
# outside any tests/, test/, dist/ or node_modules/ directory, CHANGELOG.md and
# changelog.d/ (release history stays as written).
#
# --self-test runs the check against fixtures/no-in-session-plugin-commands/:
# every line of each bad.* fixture but a `#!` or `# shellcheck` header is
# flagged, and each good.* fixture produces no findings.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/no-in-session-plugin-commands"

read -r -d '' SCANNER <<'PERL' || true
use strict; use warnings;
my $cmd = qr{(?:^|(?<=[\s`"'(]))(?<!\bcd )/(?:reload-plugins|plugin|mcp)(?=[\s`"')]|[.,;:](?![\w/])|$)};
for my $file (@ARGV) {
  open my $fh, "<", $file or next;
  while (my $line = <$fh>) {
    chomp $line;
    next if $line =~ /^\s*(?:WORKDIR|COPY|ADD|VOLUME)\s/;
    print "$file:$.: $line\n" if $line =~ $cmd;
  }
  close $fh;
}
PERL

# scan <file>... — prints "<file>:<line>: <text>" per line naming an in-session command.
scan() {
  perl -e "$SCANNER" "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  for f in "$FIXTURES"/bad.*; do
    expected=$(grep -cvE '^(#!|# shellcheck )' "$f")
    got=$(scan "$f" | grep -c '' || true)
    if [ "$got" -eq 0 ] || [ "$got" != "$expected" ]; then
      printf 'no-in-session-plugin-commands self-test: %s — %s lines, %s flagged:\n%s\n' "${f##*/}" "$expected" "$got" "$(scan "$f")" >&2
      fail=1
    fi
  done
  for f in "$FIXTURES"/good.*; do
    out=$(scan "$f")
    [ -z "$out" ] || { printf 'no-in-session-plugin-commands self-test: false positives in %s:\n%s\n' "${f##*/}" "$out" >&2; fail=1; }
  done
  [ "$fail" -eq 0 ] && echo "No-in-session-plugin-commands self-test: PASS"
  exit "$fail"
fi

cd "$ROOT" || exit 1
TRACKED=$(git ls-files -- '*.md' '*.sh' '*.ts' '*.mjs' '*.js' '*.json' '*.yml') || {
  echo "No-in-session-plugin-commands: FAIL — git ls-files failed; run from a git checkout" >&2
  exit 1
}
FILES=()
while IFS= read -r f; do
  [ -n "$f" ] && FILES+=("$f")
done < <(printf '%s\n' "$TRACKED" | grep -Ev '(^|/)(tests?|dist|node_modules)/|(^|/)CHANGELOG\.md$|^changelog\.d/' | sort)
VIOLATIONS=$(scan "${FILES[@]}")

if [ -n "$VIOLATIONS" ]; then
  printf 'No-in-session-plugin-commands: FAIL — prescribe "claude plugin … --scope <s>" from the project root and/or a full quit and relaunch of Claude Code instead:\n%s\n' "$VIOLATIONS" >&2
  exit 1
fi
printf 'No-in-session-plugin-commands: PASS (%d files)\n' "${#FILES[@]}"
