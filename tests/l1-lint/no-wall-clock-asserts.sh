#!/usr/bin/env bash
# L1 lint: tests assert behaviour, not wall-clock budgets (GH 1645, GH 1677).
# An elapsed-time bound flakes on a loaded runner; assert the timeout path fired
# instead (its exit code, message or marker file).
#
# Shell (*.sh): a `$SECONDS` or `date +%s` difference against a variable (an
# elapsed time, not an epoch shifted by a literal), inline or through a variable
# assigned from it, compared with -lt/-le/-gt/-ge or inside (( )).
# TS/JS: a `Date.now() - x` or `performance.now() - x` result, inline or through
# a variable assigned from it, compared to a numeric literal with < <= > >= or
# expect(...).toBeLessThan/…OrEqual/toBeGreaterThan/…OrEqual(<number>).
# Comment lines are skipped.
#
# Allowlist: tests/l1-lint/no-wall-clock-asserts.allowlist —
# <path><TAB><substring of the line><TAB><reason>. An entry with no reason or
# matching no hit fails.
#
# --self-test scans fixtures/no-wall-clock-asserts/: every `VIOLATION` line of
# bad.sh.txt and bad.ts.txt must be reported and nothing in good.sh.txt or
# good.ts.txt. The fixtures are .txt so a repo-wide scan never picks them up;
# the language is the extension before .txt.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
ALLOWLIST="tests/l1-lint/no-wall-clock-asserts.allowlist"
FIXTURES="tests/l1-lint/fixtures/no-wall-clock-asserts"

# scan <allowlist> <file>... — prints file:line per violation; exits 1 on any.
scan() {
  perl -e '
  use strict; use warnings;
  my ($allowlist, @files) = @ARGV;
  my @allow;
  my $bad = 0;
  if (open my $al, "<", $allowlist) {
    while (<$al>) {
      chomp;
      next if /^\s*(#|$)/;
      my ($path, $sub, $reason) = split /\t/, $_, 3;
      if (!defined $sub || !defined $reason || $reason !~ /\S/) {
        print "ALLOWLIST $allowlist:$.: needs <path><TAB><substring><TAB><reason>\n";
        $bad = 1;
        next;
      }
      push @allow, { path => $path, sub => $sub, used => 0 };
    }
  }
  my $var = qr/[A-Za-z_]\w*/;
  my $num = qr/\d[\d_]*(?:\.\d+)?/;
  my $sh_diff = qr/(?:\bSECONDS|date\s+\+%s\)?)\s*-\s*\$?\{?$var/;
  my $ts_diff = qr/(?:Date\.now|performance\.now)\(\)\s*-\s*[A-Za-z_\$][\w.\$]*/;
  my $ts_cmp = qr/(?:<=?|>=?)\s*$num\b/;
  my $ts_rcmp = qr/\b$num\s*(?:<=?|>=?)/;
  my $ts_matcher = qr/\.to(?:BeLessThan|BeLessThanOrEqual|BeGreaterThan|BeGreaterThanOrEqual)\(\s*$num\s*\)/;
  for my $file (@files) {
    my $sh = $file =~ /\.sh(?:\.txt)?$/;
    my %elapsed;
    open my $fh, "<", $file or next;
    while (my $l = <$fh>) {
      chomp $l;
      next if $l =~ m{^\s*(?:#|//|\*|/\*)};
      my $hit = 0;
      if ($sh) {
        $elapsed{$1} = 1 if $l =~ /^\s*(?:local\s+|export\s+|readonly\s+)?($var)=.*$sh_diff/;
        my $cmp = $l =~ /\s-(?:lt|le|gt|ge)\s/ || $l =~ /\(\(.*[<>]/;
        if ($cmp) {
          $hit = 1 if $l =~ $sh_diff;
          for my $v (keys %elapsed) { $hit = 1 if $l =~ /\$\{?$v\b/ || $l =~ /\(\(.*\b$v\b\s*[<>]/ }
        }
      } else {
        $elapsed{$1} = 1 if $l =~ /\b(?:const|let|var)\s+($var)\s*(?::\s*\w+\s*)?=\s*$ts_diff/;
        $hit = 1 if $l =~ /$ts_diff\s*\)?\s*$ts_cmp/ || $l =~ /$ts_rcmp\s*\(?\s*$ts_diff/
          || $l =~ /expect\(\s*\(?\s*$ts_diff\s*\)?\s*\)$ts_matcher/;
        for my $v (keys %elapsed) {
          $hit = 1 if $l =~ /(?<![\w.\$])$v\s*$ts_cmp/ || $l =~ /$ts_rcmp\s*$v\b/
            || $l =~ /expect\(\s*$v\s*\)$ts_matcher/;
        }
      }
      next unless $hit;
      my ($ok) = grep { $_->{path} eq $file && index($l, $_->{sub}) >= 0 } @allow;
      if ($ok) { $ok->{used} = 1; next }
      (my $t = $l) =~ s/^\s+//;
      print "$file:$.: $t\n";
      $bad = 1;
    }
    close $fh;
  }
  for (grep { !$_->{used} } @allow) {
    print "ALLOWLIST $allowlist: stale entry (no hit): $_->{path}\t$_->{sub}\n";
    $bad = 1;
  }
  exit $bad;
' "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  for lang in sh ts; do
    bad=$(scan /dev/null "$FIXTURES/bad.$lang.txt")
    got=$(printf '%s\n' "$bad" | grep -c 'VIOLATION')
    expected=$(grep -c 'VIOLATION' "$FIXTURES/bad.$lang.txt")
    [ "$got" = "$expected" ] && [ "$(printf '%s\n' "$bad" | grep -vc 'VIOLATION')" = 0 ] || {
      printf 'no-wall-clock-asserts self-test: expected %s violations in bad.%s.txt, got:\n%s\n' "$expected" "$lang" "$bad" >&2; fail=1; }
    good=$(scan /dev/null "$FIXTURES/good.$lang.txt") || {
      printf 'no-wall-clock-asserts self-test: false positives in good.%s.txt:\n%s\n' "$lang" "$good" >&2; fail=1; }
  done
  [ "$fail" -eq 0 ] && echo "No-wall-clock-asserts self-test: PASS"
  exit "$fail"
fi

DIRS=()
for d in tests dashboard/test mcp/trajectory-server/src/test; do [ -d "$d" ] && DIRS+=("$d"); done
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(
  find "${DIRS[@]}" -type f \( -name '*.sh' -o -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) \
    -not -path '*/node_modules/*' 2>/dev/null | sort
)

OUT=$(scan "$ALLOWLIST" "${FILES[@]}")
status=$?

if [ "$status" -ne 0 ]; then
  printf 'No-wall-clock-asserts: FAIL — a test compares elapsed wall-clock time, which flakes under load.\nAssert the behaviour instead (the timeout fired: exit code, message or marker), or allowlist the line with a reason.\n%s\n' "$OUT" >&2
  exit 1
fi
printf 'No-wall-clock-asserts: PASS (%d files)\n' "${#FILES[@]}"
