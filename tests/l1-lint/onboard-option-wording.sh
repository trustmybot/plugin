#!/usr/bin/env bash
# L1 lint: /onboard option wording speaks to the user, not about TMB's
# internals (GH 1575). Scans the module-level code of
# mcp/trajectory-server/src/tools/onboard.ts (everything above
# `export function onboardTools`, where every question option is built; the
# tool definitions below it are written for the model and are skipped).
#
# Checked strings: the string literals of every `label:` and `description:`
# property value, and of every property value inside BRANCHING_DESCRIPTIONS.
#   FAIL (exit 1) on a case-insensitive whole-word match, plural included, of
#        trajectory, DB, hook, shim, PreToolUse, KV, wire, mirror, containment.
#   WARN (exit 0) on a description string literal longer than 15 words
#        (per literal, so the two arms of a ternary are counted apart).
# Comments are stripped first; `${...}` in template literals counts as nothing.
#
# --self-test runs the scan against fixtures/onboard-option-wording/: bad.ts
# must fail exactly once per line marked VIOLATION, good.ts must pass with
# exactly one warning.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/onboard-option-wording"
TARGET="mcp/trajectory-server/src/tools/onboard.ts"

# scan <file>... — prints "FAIL<TAB><file>:<line>: ..." and "WARN<TAB>..." lines.
scan() {
  perl -e '
    use strict; use warnings;
    my $forbidden = qr/\b(trajectory|DB|hook|shim|PreToolUse|KV|wire|mirror|containment)s?\b/i;
    my $max_words = 15;

    sub strip_comments {
      my ($src) = @_;
      my $out = "";
      my $i = 0;
      my $n = length $src;
      while ($i < $n) {
        my $c = substr($src, $i, 1);
        my $two = substr($src, $i, 2);
        if ($c eq "\x27" || $c eq "\"" || $c eq "`") {
          my $j = $i + 1;
          while ($j < $n && substr($src, $j, 1) ne $c) { $j += substr($src, $j, 1) eq "\\" ? 2 : 1 }
          $out .= substr($src, $i, $j - $i + 1);
          $i = $j + 1;
        } elsif ($two eq "//") {
          my $j = index($src, "\n", $i);
          $j = $n if $j < 0;
          $i = $j;
        } elsif ($two eq "/*") {
          my $j = index($src, "*/", $i + 2);
          $j = $n - 2 if $j < 0;
          my $skipped = substr($src, $i, $j + 2 - $i);
          $out .= "\n" x ($skipped =~ tr/\n//);
          $i = $j + 2;
        } else {
          $out .= $c;
          $i++;
        }
      }
      return $out;
    }

    # value_literals($src, $pos) — the string literals of the expression that
    # starts at $pos and runs to the next top-level , } ] or ;.
    sub value_literals {
      my ($src, $pos) = @_;
      my @lits;
      my $depth = 0;
      my $n = length $src;
      while ($pos < $n) {
        my $c = substr($src, $pos, 1);
        if ($c eq "\x27" || $c eq "\"" || $c eq "`") {
          my $j = $pos + 1;
          while ($j < $n && substr($src, $j, 1) ne $c) { $j += substr($src, $j, 1) eq "\\" ? 2 : 1 }
          my $lit = substr($src, $pos + 1, $j - $pos - 1);
          $lit =~ s/\$\{[^}]*\}//g if $c eq "`";
          $lit =~ s/\\(.)/$1/g;
          push @lits, $lit;
          $pos = $j + 1;
          next;
        }
        if ($c eq "(" || $c eq "[" || $c eq "{") { $depth++ }
        elsif ($c eq ")" || $c eq "]" || $c eq "}") { last if $depth == 0; $depth-- }
        elsif (($c eq "," || $c eq ";") && $depth == 0) { last }
        $pos++;
      }
      return @lits;
    }

    for my $file (@ARGV) {
      open my $fh, "<", $file or die "cannot read $file\n";
      local $/;
      my $src = <$fh>;
      close $fh;
      $src = strip_comments($src);
      my $end = $src =~ /^export function onboardTools\b/m ? $-[0] : length $src;
      $src = substr($src, 0, $end);

      my @props;
      while ($src =~ /\b(label|description)\s*:\s*/g) { push @props, [$1, pos($src)] }
      if ($src =~ /\bBRANCHING_DESCRIPTIONS\s*=\s*\{/g) {
        my $start = pos($src);
        my $depth = 0;
        my $close = $start;
        for (; $close < length $src; $close++) {
          my $c = substr($src, $close, 1);
          $depth++ if $c eq "{";
          if ($c eq "}") { last if $depth == 0; $depth-- }
        }
        my $block = substr($src, $start, $close - $start);
        while ($block =~ /(?:^|[,{\s])(?:\x27[^\x27]*\x27|"[^"]*"|[A-Za-z_]\w*)\s*:\s*/g) {
          push @props, ["description", $start + pos($block)];
        }
      }

      for my $p (@props) {
        my ($kind, $at) = @$p;
        my @lits = value_literals($src, $at);
        next unless @lits;
        my $line = 1 + (substr($src, 0, $at) =~ tr/\n//);
        for my $lit (@lits) {
          if ($lit =~ $forbidden) {
            print "FAIL\t$file:$line: \"$1\" in $kind: $lit\n";
            last;
          }
        }
        if ($kind eq "description") {
          for my $lit (@lits) {
            my $words = () = $lit =~ /\S+/g;
            print "WARN\t$file:$line: description has $words words (aim for <= $max_words): $lit\n" if $words > $max_words;
          }
        }
      }
    }
  ' "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  bad_out=$(scan "$FIXTURES/bad.ts")
  good_out=$(scan "$FIXTURES/good.ts")
  bad_fails=$(printf '%s\n' "$bad_out" | grep -c '^FAIL' || true)
  expected=$(grep -c 'VIOLATION' "$FIXTURES/bad.ts")
  good_fails=$(printf '%s\n' "$good_out" | grep '^FAIL' || true)
  good_warns=$(printf '%s\n' "$good_out" | grep -c '^WARN' || true)
  [ "$bad_fails" = "$expected" ] || { printf 'onboard-option-wording self-test: expected %s failures in bad.ts, got %s\n%s\n' "$expected" "$bad_fails" "$bad_out" >&2; fail=1; }
  [ -z "$good_fails" ] || { printf 'onboard-option-wording self-test: false positives in good.ts:\n%s\n' "$good_fails" >&2; fail=1; }
  [ "$good_warns" = "1" ] || { printf 'onboard-option-wording self-test: expected 1 length warning in good.ts, got %s\n%s\n' "$good_warns" "$good_out" >&2; fail=1; }
  [ "$fail" -eq 0 ] && echo "Onboard-option-wording self-test: PASS"
  exit "$fail"
fi

cd "$ROOT" || exit 1
[ -f "$TARGET" ] || { echo "Onboard-option-wording: FAIL — $TARGET not found" >&2; exit 1; }
out=$(scan "$TARGET") || { echo "Onboard-option-wording: FAIL — scan error" >&2; exit 1; }
warns=$(printf '%s\n' "$out" | sed -n 's/^WARN\t//p')
fails=$(printf '%s\n' "$out" | sed -n 's/^FAIL\t//p')
[ -n "$warns" ] && printf 'Onboard-option-wording: WARN — long descriptions:\n%s\n' "$warns" >&2
if [ -n "$fails" ]; then
  printf 'Onboard-option-wording: FAIL — say what happens to the user, not the mechanism:\n%s\n' "$fails" >&2
  exit 1
fi
echo "Onboard-option-wording: PASS"
