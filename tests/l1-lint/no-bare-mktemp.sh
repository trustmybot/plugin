#!/usr/bin/env bash
# L1 lint: every mktemp in tests/ and scripts/ (*.sh) passes an explicit path
# template. BSD mktemp (macOS) puts a bare `mktemp`, `mktemp -d`, `mktemp -t X`
# or `mktemp -d -t X` under DARWIN_USER_TEMP_DIR and ignores TMPDIR, which the
# Bash sandbox does not let a command write; GNU mktemp honours TMPDIR. A
# template is honoured by both:
#   mktemp -d "${TMPDIR:-/tmp}/tmb-<name>.XXXXXX"
#   mktemp    "${TMPDIR:-/tmp}/tmb-<name>.XXXXXX"
#
# A call is a mktemp in command position (line start, after `$(`, a backtick,
# or `;` `&` `|` and a space); its first non-flag argument must contain a `/`
# and `XXX`. `-t` and `-p`/`--tmpdir` consume their argument. Comment lines are
# skipped.
#
# Allowlist: tests/l1-lint/no-bare-mktemp.allowlist —
# <path><TAB><substring of the line><TAB><reason>. An entry with no reason or
# matching no hit fails.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
ALLOWLIST="tests/l1-lint/no-bare-mktemp.allowlist"

FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(
  find tests scripts -type f -name '*.sh' -not -path '*/node_modules/*' 2>/dev/null | sort
)

OUT=$(perl -e '
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
  sub first_arg {
    my ($rest) = @_;
    my @tokens;
    my ($tok, $depth, $q) = ("", 0, "");
    my @c = split //, $rest;
    for (my $i = 0; $i < @c; $i++) {
      my $ch = $c[$i];
      if ($q) {
        $tok .= $ch;
        if ($ch eq "\\" && $q eq "\"") { $tok .= $c[++$i] // ""; next }
        if ($ch eq "\$" && ($c[$i+1] // "") eq "(") { $depth++; $tok .= $c[++$i]; next }
        if ($ch eq ")" && $depth) { $depth--; next }
        $q = "" if $ch eq $q && !$depth;
        next;
      }
      if ($ch eq "\$" && ($c[$i+1] // "") eq "(") { $depth++; $tok .= "\$("; $i++; next }
      if ($ch eq ")" && $depth) { $depth--; $tok .= $ch; next }
      if ($ch eq "\"" || $ch eq "\x27") { $q = $ch; $tok .= $ch; next }
      last if !$depth && $ch =~ /[)`;|&#]/;
      if (!$depth && $ch =~ /\s/) { push @tokens, $tok if length $tok; $tok = ""; next }
      $tok .= $ch;
    }
    push @tokens, $tok if length $tok;
    while (@tokens) {
      my $t = shift @tokens;
      next if $t =~ /^\d*[<>]/;
      if ($t =~ /^-(?:t|p)$/ || $t eq "--tmpdir" || $t eq "--suffix") { shift @tokens; next }
      next if $t =~ /^-/;
      return $t;
    }
    return undef;
  }
  for my $file (@files) {
    open my $fh, "<", $file or next;
    while (my $l = <$fh>) {
      next if $l =~ /^\s*#/;
      chomp $l;
      while ($l =~ /(?:(?<!\\)\$\(\s*|`\s*|^\s*|[;&|]\s+)mktemp(?![\w.-])/g) {
        my $rest = substr $l, pos $l;
        my $arg = first_arg($rest);
        next if defined $arg && $arg =~ m{/} && $arg =~ /XXX/;
        my ($hit) = grep { $_->{path} eq $file && index($l, $_->{sub}) >= 0 } @allow;
        if ($hit) { $hit->{used} = 1; next }
        (my $t = $l) =~ s/^\s+//;
        print "$file:$.: $t\n";
        $bad = 1;
      }
    }
    close $fh;
  }
  for (grep { !$_->{used} } @allow) {
    print "ALLOWLIST $allowlist: stale entry (no hit): $_->{path}\t$_->{sub}\n";
    $bad = 1;
  }
  exit $bad;
' "$ALLOWLIST" "${FILES[@]}")
status=$?

if [ "$status" -ne 0 ]; then
  printf 'No-bare-mktemp: FAIL — mktemp without a path template (BSD mktemp ignores TMPDIR; the sandbox denies its default dir).\nUse: mktemp -d "${TMPDIR:-/tmp}/tmb-<name>.XXXXXX" (or $(tmp_footprint_parent) where tests/lib/tmp-footprint.sh is sourced)\n%s\n' "$OUT" >&2
  exit 1
fi
printf 'No-bare-mktemp: PASS (%d files)\n' "${#FILES[@]}"
