#!/usr/bin/env bash
# L1 lint: every `sqlite3` CLI invocation in shipped shell sets a busy timeout.
#
# The sqlite3 CLI's default busy timeout is 0: while another session (a second
# trajectory server, the dashboard, a hook) writes the DB, any read or write
# without one fails at once with "database is locked", and the hook fails open
# or closed at random. Route reads through tmb_gate_read / tmb_sqlite_ro /
# tmb_db_read_budget (scripts/hooks/lib/query-task.sh) and writes through
# tmb_db_write (scripts/hooks/lib/db-write.sh); where a helper does not fit,
# pass `-cmd ".timeout ${TMB_DB_WRITE_TIMEOUT_MS:-1500}"` yourself.
#
# Scanned: *.sh / *.bash / extensionless files under scripts/, skills/, hooks/.
# An invocation is `sqlite3` (or a path ending in /sqlite3) in command position
# (line start, after `$(`, `(`, `{`, a backtick, `;` `&` `|` `!`, a shell keyword, or
# an exec/command/env/nohup/time/timeout/xargs wrapper) followed by an argument,
# or `sqlite3` followed by an option anywhere (`set -- sqlite3 -readonly ...`).
# Its text runs from that line through open double quotes, `\` continuations
# or a heredoc body; it passes when that text holds `.timeout` or
# `busy_timeout`. Comment lines are skipped.
#
# Allowlist: tests/l1-lint/sqlite3-needs-timeout.allowlist —
# <path><TAB><substring of the line><TAB><reason>, only for a DB that is not
# the trajectory DB (a private copy, a scratch DB). An entry with no reason or
# matching no hit fails.
#
# --self-test scans fixtures/sqlite3-needs-timeout/: every `# VIOLATION` line
# of bad.txt (among them a bare `sqlite3 "$DB" "SELECT 1"`) must be reported
# and nothing in good.txt. Every run self-tests first.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
ALLOWLIST="tests/l1-lint/sqlite3-needs-timeout.allowlist"
FIXTURES="tests/l1-lint/fixtures/sqlite3-needs-timeout"

# scan <allowlist> <file>... — prints file:line: <line> per violation; exits 1 on any.
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
      if (!defined $sub || !length $sub || !defined $reason || $reason !~ /\S/) {
        print "ALLOWLIST $allowlist:$.: needs <path><TAB><substring><TAB><reason>\n";
        $bad = 1;
        next;
      }
      push @allow, { path => $path, sub => $sub, used => 0 };
    }
  }
  my $arg = qr{(?=[ \t]+(?:[-"\x27\$<\\/~.:]|$)|[ \t]*$)};
  my $bin = qr{(?:[^\s;&|()`"\x27]*/)?sqlite3};
  my $wrap = qr{(?:(?:exec|command|nohup|time|env|xargs|timeout[ \t]+\S+)[ \t]+)};
  my $assign = qr{(?:[A-Za-z_]\w*=\S*[ \t]+)};
  my $cmdpos = qr{(?:^|[;&|(\{`]|\b(?:if|elif|then|do|else|while|until)|!)[ \t]*$assign*$wrap?$assign*$bin$arg};
  my $optpos = qr{(?<![\w.-])$bin[ \t]+-[A-Za-z]};
  for my $file (@files) {
    open my $fh, "<", $file or next;
    my @lines = <$fh>;
    close $fh;
    chomp @lines;
    for my $i (0 .. $#lines) {
      my $l = $lines[$i];
      next if $l =~ /^\s*#/;
      (my $probe = $l) =~ s/\b(?:command[ \t]+-v|type|which|hash)[ \t]+sqlite3\b//g;
      next unless $probe =~ $cmdpos || $probe =~ $optpos;
      my $buf = $l;
      if ($l =~ /<<-?[ \t]*["\x27]?([A-Za-z_]\w*)/) {
        my $delim = $1;
        for (my $j = $i + 1; $j <= $#lines; $j++) {
          (my $t = $lines[$j]) =~ s/^\s+|\s+$//g;
          last if $t eq $delim;
          $buf .= "\n$lines[$j]";
        }
      } else {
        my $q = sub { my $s = shift; $s =~ s/\\"//g; return ($s =~ tr/"//) };
        my $open = $q->($l) % 2;
        my $cont = $l =~ /\\\s*$/;
        for (my $j = $i + 1; ($open || $cont) && $j <= $#lines; $j++) {
          $buf .= "\n$lines[$j]";
          $open = !$open if $q->($lines[$j]) % 2;
          $cont = $lines[$j] =~ /\\\s*$/;
        }
      }
      next if $buf =~ /\.timeout\b|busy_timeout/;
      my ($hit) = grep { $_->{path} eq $file && index($l, $_->{sub}) >= 0 } @allow;
      if ($hit) { $hit->{used} = 1; next }
      (my $t = $l) =~ s/^\s+//;
      printf "%s:%d: %s\n", $file, $i + 1, $t;
      $bad = 1;
    }
  }
  for (grep { !$_->{used} } @allow) {
    print "ALLOWLIST $allowlist: stale entry (no hit): $_->{path}\t$_->{sub}\n";
    $bad = 1;
  }
  exit $bad;
' "$@"
}

# Line numbers of the `# VIOLATION` markers in bad.txt; a marker on a `\`
# continuation line counts for the line the command starts on.
expected_lines() {
  awk '{ cont[NR] = /\\[ \t]*$/ } / # VIOLATION$/ { n = NR; while (n > 1 && cont[n - 1]) n--; print n }' "$1"
}

run_self_test() {
  local fail=0 bad got expected good
  bad=$(scan /dev/null "$FIXTURES/bad.txt")
  got=$(printf '%s\n' "$bad" | sed -n 's/^[^:]*:\([0-9][0-9]*\):.*/\1/p' | tr '\n' ' ')
  expected=$(expected_lines "$FIXTURES/bad.txt" | tr '\n' ' ')
  if [ "$got" != "$expected" ]; then
    printf 'sqlite3-needs-timeout self-test: bad.txt expected hits on lines [%s], got [%s]:\n%s\n' "$expected" "$got" "$bad" >&2
    fail=1
  fi
  got=$(printf '%s' "$expected" | wc -w | tr -d ' ')
  if ! printf '%s\n' "$bad" | grep -F 'sqlite3 "$DB" "SELECT 1"' >/dev/null; then
    printf 'sqlite3-needs-timeout self-test: the bare sqlite3 "$DB" "SELECT 1" in bad.txt was not reported\n' >&2
    fail=1
  fi
  if ! good=$(scan /dev/null "$FIXTURES/good.txt"); then
    printf 'sqlite3-needs-timeout self-test: false positives in good.txt:\n%s\n' "$good" >&2
    fail=1
  fi
  [ "$fail" -eq 0 ] && printf 'Sqlite3-needs-timeout self-test: PASS (%s bad invocations caught, good.txt clean)\n' "$got"
  return "$fail"
}

if [ "${1:-}" = "--self-test" ]; then
  run_self_test
  exit $?
fi

run_self_test >/dev/null 2>&1 || { run_self_test; exit 1; }

FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(
  find scripts skills hooks -type f \( -name '*.sh' -o -name '*.bash' -o ! -name '*.*' \) \
    -not -path '*/node_modules/*' 2>/dev/null | sort
)

OUT=$(scan "$ALLOWLIST" "${FILES[@]}")
status=$?

if [ "$status" -ne 0 ]; then
  printf 'Sqlite3-needs-timeout: FAIL — sqlite3 invoked without a busy timeout (the CLI default of 0 fails at once under a concurrent writer):\n%s\n' "$OUT" >&2
  printf '  Read through tmb_gate_read / tmb_sqlite_ro / tmb_db_read_budget, write through tmb_db_write,\n  or pass -cmd ".timeout ${TMB_DB_WRITE_TIMEOUT_MS:-1500}". A DB that is not the trajectory DB goes in %s with a reason.\n' "$ALLOWLIST" >&2
  exit 1
fi
printf 'Sqlite3-needs-timeout: PASS (%d files)\n' "${#FILES[@]}"
