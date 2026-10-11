#!/usr/bin/env bash
# L1 lint: importing a trajectory-server module writes nothing to disk. A
# filesystem write that runs when the module is evaluated — a statement at
# module scope, inside a top-level try/if/for block, or in a top-level
# const/let initializer — fires for every script or test that merely imports
# the module, wherever it runs. Writes belong inside functions (memoized
# getters, first-write guards) or at server start in the entry points.
#
# Scans mcp/trajectory-server/src/**/*.ts, excluding src/test/ and the server
# entry points (src/index.ts, src/codex.ts), whose module scope IS server start.
# Write calls: mkdirSync, writeFileSync, appendFileSync, rmSync, renameSync,
# copyFileSync, and openSync with a 'w' flag. A call is module-scope when no
# enclosing scope is a function body, arrow function, method, or class body
# (literal callbacks such as setTimeout(() => ...) count as functions).
#
# --self-test runs the checks against fixtures/no-module-load-writes/.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/no-module-load-writes"

# scan <file>... — prints "<file>:<line>: <text>" per module-scope write.
scan() {
  perl -e '
    use strict; use warnings;
    for my $file (@ARGV) {
      open my $fh, "<", $file or next;
      local $/; my $src = <$fh>; close $fh;
      my @orig = split /\n/, $src, -1;
      # Blank comments, strings, template literals and regex literals, keeping newlines.
      my $code = "";
      my $i = 0; my $n = length $src; my $prev = "";
      my $blank = sub { my $s = shift; $s =~ s/[^\n]/ /g; $s };
      while ($i < $n) {
        my $c = substr($src, $i, 1);
        my $two = substr($src, $i, 2);
        if ($two eq "//") { my $e = index($src, "\n", $i); $e = $n if $e < 0; $code .= " " x ($e - $i); $i = $e; next }
        if ($two eq "/*") { my $e = index($src, "*/", $i + 2); $e = $e < 0 ? $n : $e + 2; $code .= $blank->(substr($src, $i, $e - $i)); $i = $e; next }
        if ($c eq "\x27" || $c eq "\"" || $c eq "`" || ($c eq "/" && $prev =~ /^(?:[(,=:\[!&|?{};]|return)$/)) {
          my $q = $c; my $j = $i + 1; my $depth = 0;
          while ($j < $n) {
            my $d = substr($src, $j, 1);
            if ($d eq "\\") { $j += 2; next }
            if ($q eq "`" && substr($src, $j, 2) eq "\${") { $depth++; $j += 2; next }
            if ($q eq "`" && $depth > 0 && $d eq "}") { $depth--; $j++; next }
            if ($q eq "/" && $d eq "[") { my $k = index($src, "]", $j); $j = $k < 0 ? $n : $k + 1; next }
            if ($d eq $q && $depth == 0) { $j++; last }
            last if $d eq "\n" && $q ne "`";
            $j++;
          }
          if ($q eq "/") { $j++ while $j < $n && substr($src, $j, 1) =~ /[a-z]/ }
          $code .= "\"" . $blank->(substr($src, $i + 1, $j - $i - 1));
          $i = $j; $prev = "x"; next;
        }
        $code .= $c;
        if ($c =~ /\w/) { my ($w) = substr($src, $i) =~ /^(\w+)/; $code .= substr($w, 1); $i += length $w; $prev = $w; next }
        $prev = $c if $c =~ /\S/;
        $prev = "=>" if $two eq "=>";
        $i++;
      }
      # Walk the stripped code, tracking which enclosing scopes run at load.
      my @stack;        # entries: { kind => fn|blk, paren => depth }
      my @parens;       # word before each open paren
      my $last_close = "";
      my $header = "";  # text since the last statement boundary at this level
      my $line = 1;
      my $exec = sub { !grep { $_->{kind} eq "fn" } @stack };
      pos($code) = 0;
      while ($code =~ /\G(?:(\n)|(=>)|(\w+)|([{}()\[\];,])|([^\n\w{}()\[\];,]))/gc) {
        my ($nl, $arrow, $word, $punct, $other) = ($1, $2, $3, $4, $5);
        if (defined $nl) { $line++; next }
        if (defined $arrow) {
          my $rest = substr($code, pos($code));
          if ($rest !~ /^\s*\{/) { push @stack, { kind => "fn", expr => 1, paren => scalar @parens } }
          $header .= " =>"; next;
        }
        if (defined $word) {
          my $after = substr($code, pos($code), 200);
          if ($word =~ /^(?:mkdirSync|writeFileSync|appendFileSync|rmSync|renameSync|copyFileSync|openSync)$/ && $after =~ /^\s*\(/ && $exec->()) {
            my $text = $orig[$line - 1] // "";
            if ($word ne "openSync" || $text =~ /openSync\s*\(.*["\x27]w/) {
              (my $t = $text) =~ s/^\s+//;
              print "$file:$line: $t\n";
            }
          }
          $header .= " $word"; next;
        }
        if (defined $other) { $header .= $other; next }
        if ($punct eq "(" || $punct eq "[") { my ($w) = $header =~ /(\w+)\s*$/; push @parens, ($punct eq "(" ? ($w // "") : "["); $header .= $punct; next }
        if ($punct eq ")" || $punct eq "]") {
          while (@stack && $stack[-1]{expr} && $stack[-1]{paren} >= scalar @parens) { pop @stack }
          $last_close = pop(@parens) // ""; $header .= $punct; next;
        }
        if ($punct eq ";" || $punct eq ",") {
          while (@stack && $stack[-1]{expr} && $stack[-1]{paren} == scalar @parens) { pop @stack }
          $header = "" if $punct eq ";"; next;
        }
        if ($punct eq "{") {
          my $kind;
          if ($header =~ /=>\s*$/) { $kind = "fn" }
          elsif ($header =~ /\)\s*$/) { $kind = $last_close =~ /^(?:if|for|while|catch|switch|with)$/ ? "blk" : "fn" }
          elsif ($header =~ /\b(?:try|else|finally|do)\s*$/) { $kind = "blk" }
          elsif ($header =~ /(?:[<:,=(\[|&?!]|\breturn)\s*$/) { $kind = "obj" }
          elsif ($header =~ /\b(?:function|class)\b/) { $kind = "fn" }
          else { $kind = "obj" }
          push @stack, { kind => $kind, paren => scalar @parens, header => $header };
          $header = ""; next;
        }
        if ($punct eq "}") {
          while (@stack && $stack[-1]{expr}) { pop @stack }
          my $top = pop @stack;
          $header = ($top && $top->{kind} eq "obj") ? $top->{header} . "{}" : "";
          next;
        }
      }
    }
  ' "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  bad=$(scan "$FIXTURES"/bad.ts | wc -l | tr -d ' ')
  expected_bad=$(grep -c 'VIOLATION' "$FIXTURES"/bad.ts)
  good=$(scan "$FIXTURES"/good.ts)
  [ "$bad" = "$expected_bad" ] || { printf 'no-module-load-writes self-test: expected %s violations in bad.ts, got %s\n' "$expected_bad" "$bad" >&2; scan "$FIXTURES"/bad.ts >&2; fail=1; }
  [ -z "$good" ] || { printf 'no-module-load-writes self-test: false positives in good.ts:\n%s\n' "$good" >&2; fail=1; }
  [ "$fail" -eq 0 ] && echo "No-module-load-writes self-test: PASS"
  exit "$fail"
fi

bash "${BASH_SOURCE[0]}" --self-test >/dev/null || { echo "No-module-load-writes: FAIL — self-test failed (run with --self-test)" >&2; exit 1; }

cd "$ROOT" || exit 1
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(
  find mcp/trajectory-server/src -type f -name '*.ts' -not -path '*/test/*' \
    -not -path 'mcp/trajectory-server/src/index.ts' -not -path 'mcp/trajectory-server/src/codex.ts' | sort
)
VIOLATIONS=$(scan "${FILES[@]}")

if [ -n "$VIOLATIONS" ]; then
  printf 'No-module-load-writes: FAIL — filesystem writes at module load (move them into a function or server start):\n%s\n' "$VIOLATIONS" >&2
  exit 1
fi
printf 'No-module-load-writes: PASS (%d files)\n' "${#FILES[@]}"
