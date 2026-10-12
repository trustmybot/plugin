#!/usr/bin/env bash
# L1 lint: no `| grep -q` in a shell script that sets pipefail.
#
# `grep -q` exits on the first match and closes the pipe; the upstream command
# can then die of SIGPIPE and, under `set -o pipefail`, the pipeline reports
# failure although the pattern was present. Write `cmd | grep PAT >/dev/null`
# instead: grep reads to EOF, so the upstream always finishes.
#
# Scans every *.sh under tests/, scripts/ and hooks/ (fixtures/ dirs excepted)
# whose `set` line turns on pipefail, and every *.sh under scripts/hooks/lib/
# and tests/lib/ unconditionally: those libraries are sourced and inherit
# pipefail from their callers. A hit is a non-comment line where a pipe
# feeds grep/egrep/fgrep/rg with an option cluster containing q, --quiet or
# --silent. `||` and `grep -q PAT file` (no pipe) are fine.
#
# --self-test runs fixtures/no-grep-q-in-pipelines/: offending.sh and the
# pipefail-less sourced library scripts/hooks/lib/sourced-lib.sh are caught,
# clean.sh and no-pipefail.sh pass.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/no-grep-q-in-pipelines"

# scan <base> <file>... — prints "<file>:<line>: <text>" per hit, relative to <base>.
# Files whose <base>-relative path is under scripts/hooks/lib/ or tests/lib/
# are scanned without the pipefail check.
scan() {
  perl -e '
    use strict; use warnings;
    my $base = shift @ARGV;
    my $pipefail = qr/^\s*set\s+[^#]*-[A-Za-z]*o\s+pipefail\b/;
    my $hit = qr/(?:^|[^|])\|\s*(?:grep|egrep|fgrep|rg)(?:\s+-[A-Za-z]+)*\s+(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)(?![\w-])/;
    for my $file (@ARGV) {
      open my $fh, "<", $file or next;
      my @lines = <$fh>;
      close $fh;
      (my $rel = $file) =~ s{^\Q$base\E/}{};
      my $sourced = $rel =~ m{^(?:scripts/hooks/lib|tests/lib)/};
      next unless $sourced || grep { $_ =~ $pipefail } @lines;
      for my $i (0 .. $#lines) {
        my $line = $lines[$i];
        next if $line =~ /^\s*#/;
        next unless $line =~ $hit;
        chomp $line;
        $line =~ s/^\s+//;
        print "$rel:", $i + 1, ": $line\n";
      }
    }
  ' "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  for f in offending.sh scripts/hooks/lib/sourced-lib.sh; do
    out="$(scan "$FIXTURES" "$FIXTURES/$f")"
    if [ -n "$out" ]; then
      echo "no-grep-q-in-pipelines --self-test: PASS ($f caught)"
    else
      echo "no-grep-q-in-pipelines --self-test: FAIL ($f not caught)" >&2
      fail=1
    fi
  done
  for f in clean.sh no-pipefail.sh; do
    out="$(scan "$FIXTURES" "$FIXTURES/$f")"
    if [ -z "$out" ]; then
      echo "no-grep-q-in-pipelines --self-test: PASS ($f allowed)"
    else
      printf 'no-grep-q-in-pipelines --self-test: FAIL (%s flagged)\n%s\n' "$f" "$out" >&2
      fail=1
    fi
  done
  exit "$fail"
fi

files=()
for dir in tests scripts hooks; do
  [ -d "$ROOT/$dir" ] || continue
  while IFS= read -r -d '' f; do files+=("$f"); done \
    < <(find "$ROOT/$dir" -name fixtures -prune -o -type f -name '*.sh' -print0)
done

out="$(scan "$ROOT" "${files[@]}")"
if [ -n "$out" ]; then
  printf '%s\n' "$out"
  echo "no-grep-q-in-pipelines: FAIL — pipe into 'grep PAT >/dev/null' instead of 'grep -q' under pipefail" >&2
  exit 1
fi
echo "no-grep-q-in-pipelines: PASS"
