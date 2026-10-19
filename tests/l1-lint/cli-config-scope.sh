#!/usr/bin/env bash
# L1 lint: every config-changing `claude plugin` / `claude mcp` call runs with
# `--scope project`. The CLI's defaults reach user scope (`plugin uninstall`
# defaults to user, `mcp add` to local — stored in ~/.claude.json — and
# `mcp remove` acts on whichever scope holds the name), so TMB pins the scope
# instead of relying on them.
#
# Scans scripts/ (*.sh) and mcp/trajectory-server/src/ (*.ts, tests excluded).
# Config-changing subcommands: install, uninstall, remove, add, add-json,
# enable, disable, update, marketplace add, marketplace remove. Read-only ones
# (list, get, marketplace list, ...) pass. A call is either a command line
# (`claude plugin install x`, backslash continuations joined) or a TS argv
# array (`['plugin', 'install', x]`); it passes when the same command (up to
# `;`, `&&`, `||` or `|`) or the same array carries `--scope project` /
# `--scope=project`. Comment lines and trailing comments are skipped.
#
# Exempt: the Human-run repair tools on tests/l1-lint/no-home-writes.allowlist.
#
# --self-test runs the checks against fixtures/cli-config-scope/: every line
# marked VIOLATION in a bad fixture is flagged, nothing else is, and the good
# fixtures produce no findings.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/cli-config-scope"

# scan <file>... — prints "<file>:<line>: <call>" per unpinned call.
scan() {
  perl -e '
    use strict; use warnings;
    my $sub   = qr/(?:marketplace\s+(?:add|remove)|install|uninstall|remove|add-json|add|enable|disable|update)(?![\w-])/;
    my $q     = qr/[\x27"`]/;
    my $asub  = qr/(?:install|uninstall|remove|add-json|add|enable|disable|update)/;
    my $cmd   = qr/\bclaude\s+(?:plugin|mcp)\s+$sub/;
    my $arr   = qr/($q)(?:plugin|mcp)\1\s*,\s*(?:($q)marketplace\2\s*,\s*($q)(?:add|remove)\3|($q)$asub\4)/;
    my $pin_cmd = qr/--scope(?:\s+|=)["\x27]?project\b/;
    my $pin_arr = qr/($q)--scope\1\s*,\s*($q)project\2|($q)--scope=project\3/;
    for my $file (@ARGV) {
      open my $fh, "<", $file or next;
      my @lines = <$fh>;
      close $fh;
      my $ts = $file =~ /\.ts$/;
      for (@lines) {
        if (/^\s*(#|\/\/|\*)/) { $_ = "\n"; next }
        $ts ? s{\s+//\s.*$}{} : s{\s+#\s.*$}{};
      }
      my $text = join "", @lines;
      my $line_of = sub { 1 + (substr($text, 0, $_[0]) =~ tr/\n//) };
      my %seen;
      my $report = sub {
        my ($pos, $call) = @_;
        my $n = $line_of->($pos);
        return if $seen{$n}++;
        $call =~ s/\s+/ /g;
        print "$file:$n: $call\n";
      };
      while ($text =~ /$cmd/g) {
        my $start = $-[0];
        my $rest = substr($text, $start);
        $rest =~ s/(?<!\\)\n.*//s;
        $rest =~ s/\s*(?:;|&&|\|\|?).*//s;
        $report->($start, $rest) unless $rest =~ $pin_cmd;
      }
      next unless $ts;
      while ($text =~ /$arr/g) {
        my $start = $-[0];
        my ($array) = substr($text, $start) =~ /^([^\]]*)/;
        $report->($start, $array) unless $array =~ $pin_arr;
      }
    }
  ' "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  for f in "$FIXTURES"/bad.*; do
    expected=$(grep -n 'VIOLATION' "$f" | cut -d: -f1 | sort -n | tr '\n' ' ')
    got=$(scan "$f" | sed -E 's/^[^:]+:([0-9]+):.*/\1/' | sort -n | tr '\n' ' ')
    if [ -z "$got" ] || [ "$got" != "$expected" ]; then
      printf 'cli-config-scope self-test: %s — expected lines [%s], flagged [%s]\n' "${f##*/}" "$expected" "$got" >&2
      fail=1
    fi
  done
  for f in "$FIXTURES"/good.*; do
    out=$(scan "$f")
    [ -z "$out" ] || { printf 'cli-config-scope self-test: false positives in %s:\n%s\n' "${f##*/}" "$out" >&2; fail=1; }
  done
  [ "$fail" -eq 0 ] && echo "Cli-config-scope self-test: PASS"
  exit "$fail"
fi

cd "$ROOT" || exit 1
ALLOWLIST="tests/l1-lint/no-home-writes.allowlist"
allowed() {
  [ -f "$ALLOWLIST" ] && grep -v '^[[:space:]]*#' "$ALLOWLIST" | grep -xF "$1" >/dev/null
}
FILES=()
while IFS= read -r f; do allowed "$f" || FILES+=("$f"); done < <(
  find scripts -type f -name '*.sh' | sort
  find mcp/trajectory-server/src -type f -name '*.ts' -not -path '*/test/*' | sort
)
VIOLATIONS=$(scan "${FILES[@]}")

if [ -n "$VIOLATIONS" ]; then
  printf 'Cli-config-scope: FAIL — config-changing claude plugin/mcp calls without --scope project (the CLI default can reach user scope):\n%s\n' "$VIOLATIONS" >&2
  exit 1
fi
printf 'Cli-config-scope: PASS (%d files)\n' "${#FILES[@]}"
