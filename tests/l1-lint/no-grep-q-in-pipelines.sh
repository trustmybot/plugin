#!/usr/bin/env bash
# L1 lint: no `| grep -q` in a shell script that sets pipefail.
#
# `grep -q` exits on the first match and closes the pipe; the upstream command
# can then die of SIGPIPE and, under `set -o pipefail`, the pipeline reports
# failure although the pattern was present. Write `cmd | grep PAT >/dev/null`
# instead: grep reads to EOF, so the upstream always finishes.
#
# Scans:
#   - every *.sh under tests/, scripts/ and hooks/ (fixtures/ dirs excepted) whose `set` line turns on pipefail;
#   - every */lib/*.sh under scripts/ and tests/ unconditionally: those libraries are sourced and inherit pipefail from their callers;
#   - the string values of the JSON manifests in MANIFESTS below, whose strings are shell commands run via eval under pipefail. The JSON scan is string-based: each raw line is matched as shell text, without parsing the JSON.
#
# MANIFESTS:
#   tests/l5-l6/l6-chain/chain-manifest.json (chain_setup_command, eval'd by run-l6-chain.sh)
#
# A hit is a non-comment logical line where a pipe feeds grep/egrep/fgrep/rg whose options (short clusters, long options such as --fixed-strings, `-e PAT`) include a cluster containing q, --quiet or --silent. A line ending in `|` is joined with the next line before matching. `||` and `grep -q PAT file` (no pipe) are fine.
#
# --self-test runs fixtures/no-grep-q-in-pipelines/: offending*.sh, the pipefail-less sourced libraries under scripts/*/lib/ and manifest-offending.json are caught; clean.sh, no-pipefail.sh and manifest-clean.json pass.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/no-grep-q-in-pipelines"
MANIFESTS=(tests/l5-l6/l6-chain/chain-manifest.json)

# scan <base> <file>... — prints "<file>:<line>: <text>" per hit, relative to <base>.
# *.json files are manifests (always scanned); */lib/*.sh under scripts/ or tests/ are scanned without the pipefail check.
scan() {
  perl -e '
    use strict; use warnings;
    my $base = shift @ARGV;
    my $pipefail = qr/^\s*set\s+[^#]*-[A-Za-z]*o\s+pipefail\b/;
    my $opt = qr/(?:-[A-Za-z]*e\s+(?:\x27[^\x27]*\x27|"[^"]*"|\\"(?:[^"\\]|\\.)*?\\"|\S+)|--[A-Za-z][\w-]*(?:=\S+)?|-[A-Za-z]+)/;
    my $quiet = qr/(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)(?![\w-])/;
    my $hit = qr/(?:^|[^|])\|\s*(?:grep|egrep|fgrep|rg)(?:\s+$opt)*?\s+$quiet/;
    my $trailing = qr/(?:^|[^|])\|\s*$/;
    for my $file (@ARGV) {
      open my $fh, "<", $file or next;
      my @lines = <$fh>;
      close $fh;
      chomp @lines;
      (my $rel = $file) =~ s{^\Q$base\E/}{};
      my $manifest = $rel =~ /\.json$/;
      my $sourced = $rel =~ m{^(?:scripts|tests)/(?:.+/)?lib/[^/]+\.sh$};
      next unless $manifest || $sourced || grep { $_ =~ $pipefail } @lines;
      my $i = 0;
      while ($i <= $#lines) {
        my $start = $i;
        my $line = $lines[$i];
        if ($line =~ /^\s*#/) { $i++; next; }
        while ($line =~ $trailing && $i < $#lines) {
          $i++;
          $line .= " " . $lines[$i];
        }
        $i++;
        next unless $line =~ $hit;
        $line =~ s/^\s+//;
        print "$rel:", $start + 1, ": $line\n";
      }
    }
  ' "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  for f in offending.sh offending-long-option.sh offending-e-pattern.sh offending-trailing-pipe.sh \
    scripts/hooks/lib/sourced-lib.sh scripts/maintenance/lib/sourced-lib.sh manifest-offending.json; do
    out="$(scan "$FIXTURES" "$FIXTURES/$f")"
    if [ -n "$out" ]; then
      echo "no-grep-q-in-pipelines --self-test: PASS ($f caught)"
    else
      echo "no-grep-q-in-pipelines --self-test: FAIL ($f not caught)" >&2
      fail=1
    fi
  done
  for f in clean.sh no-pipefail.sh manifest-clean.json; do
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
for m in "${MANIFESTS[@]}"; do
  [ -f "$ROOT/$m" ] && files+=("$ROOT/$m")
done

out="$(scan "$ROOT" "${files[@]}")"
if [ -n "$out" ]; then
  printf '%s\n' "$out"
  echo "no-grep-q-in-pipelines: FAIL — pipe into 'grep PAT >/dev/null' instead of 'grep -q' under pipefail" >&2
  exit 1
fi
echo "no-grep-q-in-pipelines: PASS"
