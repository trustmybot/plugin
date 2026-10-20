#!/usr/bin/env bash
# L1 lint: every config-changing `claude plugin` / `claude mcp` call runs at
# project scope. The CLI's defaults reach user scope (`plugin uninstall`
# defaults to user, `mcp add` to local — stored in ~/.claude.json — and
# `mcp remove` acts on whichever scope holds the name), so TMB pins the scope
# instead of relying on them.
#
# Config-changing subcommands, aliases included, from the help of Claude Code
# 2.1.303 (`claude plugin --help`, `claude plugin marketplace --help`,
# `claude mcp --help` and each subcommand's `--help`):
#   with `-s, --scope`  plugin install|i, uninstall|remove, enable, disable,
#                       update, prune|autoremove; mcp add, add-json,
#                       add-from-claude-desktop, remove
#   with `--scope` only plugin marketplace add, remove|rm
#   no scope option     plugin configure, init|new; plugin marketplace update;
#                       mcp login, logout, reset-project-choices
# A call passes only when its last scope flag (`--scope X`, `--scope=X`, and
# `-s X` / `-sX` where the subcommand takes `-s`) before any `--` is the
# literal `project`; a subcommand with no scope option is flagged outright.
# Read-only ones (list, get, details, validate, ...) pass. `plugins` is the
# CLI's alias for `plugin`.
#
# The program is `claude`, any path ending in `/claude`, or a variable (`$X`,
# `${X}`, quoted or not) whose name contains "claude" (any case) or that the
# file assigns a value naming `claude`. It is matched anywhere on a line, so
# `command`, `exec`, `env`, `timeout` and `VAR=value` prefixes need no rule.
# Global options may sit between the program and `plugin` / `mcp`. The call
# runs to the end of its command (`;`, `&&`, `||`, `|`, `&`, an unmatched `)`
# or backtick, the string it sits in, or an unescaped newline). TS/JS argv
# arrays (`['plugin', 'install', x]`, global options and a program element
# allowed before the group) are checked the same way. A non-literal
# subcommand (a variable, a non-string array element) fails closed: flagged
# unless the call is pinned to project scope.
#
# Comments are stripped only outside quotes: `#` at a word start in shell,
# `//` and `/* */` in TS/JS. Heredoc bodies are scanned as commands.
#
# Scans every git-tracked *.sh, *.mjs, *.js and *.ts outside any tests/ or
# test/ (test sources quote CLI calls in prose and pass `['plugin', dir]` as
# SQL parameters), dist/ and node_modules/ directory.
#
# Exempt: the Human-run repair tools on tests/l1-lint/no-home-writes.allowlist.
#
# --self-test runs the checks against fixtures/cli-config-scope/: every line
# marked VIOLATION in a bad fixture is flagged, nothing else is, and the good
# fixtures produce no findings.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/cli-config-scope"

read -r -d '' SCANNER <<'PERL' || true
use strict; use warnings;

my %PLUGIN_PIN  = map { $_ => 1 } qw(install i uninstall remove enable disable update prune autoremove);
my %PLUGIN_BARE = map { $_ => 1 } qw(configure init new);
my %MKT_PIN     = map { $_ => 1 } qw(add remove rm);
my %MKT_BARE    = map { $_ => 1 } qw(update);
my %MCP_PIN     = map { $_ => 1 } qw(add add-json add-from-claude-desktop remove);
my %MCP_BARE    = map { $_ => 1 } qw(login logout reset-project-choices);

# lex(text, js) -> (text with comments blanked, per-char context map, JS tokens).
# The map holds the innermost open quote/bracket before each char ("." = none).
sub lex {
  my ($s, $js) = @_;
  my $n = length $s;
  my $out = $s;
  my $map = "." x $n;
  my (@st, @here, @toks);
  my ($tpl, $sig, $oend) = (0, "", -1);
  my $blank = sub {
    my ($a, $b) = @_;
    (my $seg = substr($out, $a, $b - $a)) =~ tr/\n/ /c;
    substr($out, $a, $b - $a) = $seg;
  };
  my $to_eol = sub { my $e = index($s, "\n", $_[0]); $e < 0 ? $n : $e };
  my $emit_str = sub {
    my ($f, $i) = @_;
    return if $tpl;
    my $v = substr($s, $f->[1] + 1, $i - $f->[1] - 1);
    my $lit = $f->[0] ne "`" || $v !~ /\$\{/;
    $v =~ s/\\(.)/$1/gs;
    push @toks, [ "s", $v, $lit, $f->[1] ];
  };
  my $i = 0;
  while ($i < $n) {
    my $c = substr($s, $i, 1);
    my $two = substr($s, $i, 2);
    my $top = @st ? $st[-1][0] : "";
    substr($map, $i, 1) = $top eq "" ? "." : $top;
    if ($js) {
      if ($top eq "\x27" || $top eq "\"") {
        if ($c eq "\\") { $i += 2; next }
        if ($c eq $top) { $emit_str->(pop @st, $i); $sig = "x" }
        elsif ($c eq "\n") { pop @st }
        $i++; next;
      }
      if ($top eq "`") {
        if ($c eq "\\") { $i += 2; next }
        if ($c eq "`") { my $f = pop @st; $tpl--; $emit_str->($f, $i); $sig = "x"; $i++; next }
        if ($two eq "\${") { push @st, [ "{", $i ]; $i += 2; next }
        $i++; next;
      }
      if ($top eq "/" || $top eq "[") {
        if ($c eq "\\") { $i += 2; next }
        if ($c eq "\n") { pop @st while @st && $st[-1][0] =~ m{^[/\[]$}; $i++; next }
        if ($top eq "[") { pop @st if $c eq "]" }
        elsif ($c eq "[") { push @st, [ "[", $i ] }
        elsif ($c eq "/") { pop @st; $sig = "x" }
        $i++; next;
      }
      if ($two eq "//" || ($i == 0 && $two eq "#!")) { my $e = $to_eol->($i); $blank->($i, $e); $i = $e; next }
      if ($two eq "/*") {
        my $e = index($s, "*/", $i + 2);
        $e = $e < 0 ? $n : $e + 2;
        $blank->($i, $e); $i = $e; next;
      }
      if ($c eq "\x27" || $c eq "\"" || $c eq "`") { push @st, [ $c, $i ]; $tpl++ if $c eq "`"; $i++; next }
      if ($c eq "/" && ($sig eq "" || $sig =~ m{[(,=:\[!&|?{};+\-*%<>~^]})) { push @st, [ "/", $i ]; $i++; next }
      if ($c eq "{") { push @st, [ "{", $i ] }
      elsif ($c eq "}" && $top eq "{") { pop @st }
      unless ($tpl) {
        if ($c =~ /[\[\](){},]/) { push @toks, [ "p", $c, 0, $i ] }
        elsif ($c =~ /\S/) {
          if ($oend == $i - 1 && @toks && $toks[-1][0] eq "o") { $toks[-1][1] .= $c } else { push @toks, [ "o", $c, 0, $i ] }
          $oend = $i;
        }
      }
      $sig = $c if $c =~ /\S/;
      $i++; next;
    }
    if ($c eq "\n" && @here) {
      my $j = $i + 1;
      for my $d (@here) {
        while ($j < $n) {
          my $e = $to_eol->($j);
          my $line = substr($s, $j, $e - $j);
          $j = $e + 1;
          last if $line =~ /^\t*\Q$d\E\s*$/;
        }
      }
      @here = ();
      $i = $j < $n ? $j : $n;
      next;
    }
    if ($top eq "\x27") { pop @st if $c eq "\x27"; $i++; next }
    if ($c eq "\\") { $i += 2; next }
    if ($top eq "\"") {
      if ($c eq "\"") { pop @st }
      elsif ($two eq "\$(") { push @st, [ "(", $i ]; $i++ }
      elsif ($c eq "`") { push @st, [ "`", $i ] }
      $i++; next;
    }
    if ($top eq "A") { if ($two eq "))") { pop @st; $i += 2 } else { $i++ } next }
    if ($c eq "#" && ($i == 0 || substr($s, $i - 1, 1) =~ /[\s;&|(]/)) { my $e = $to_eol->($i); $blank->($i, $e); $i = $e; next }
    if ($c eq "\x27" || $c eq "\"") { push @st, [ $c, $i ]; $i++; next }
    if ($c eq "`") { if ($top eq "`") { pop @st } else { push @st, [ "`", $i ] } $i++; next }
    if (substr($s, $i, 3) eq "\$((") { push @st, [ "A", $i ]; $i += 3; next }
    if ($two eq "((") { push @st, [ "A", $i ]; $i += 2; next }
    if ($two eq "\$(") { push @st, [ "(", $i ]; $i += 2; next }
    if ($two eq "\${") { push @st, [ "{", $i ]; $i += 2; next }
    if (substr($s, $i, 3) eq "<<<") { $i += 3; next }
    if ($two eq "<<" && substr($s, $i + 2, 80) =~ /^-?[ \t]*(["\x27]?)([A-Za-z_]\w*)\1/) { push @here, $2; $i += 2; next }
    if ($c eq "(") { push @st, [ "(", $i ] }
    elsif ($c eq ")" && $top eq "(") { pop @st }
    elsif ($c eq "}" && $top eq "{") { pop @st }
    $i++;
  }
  return ($out, $map, \@toks);
}

# words(text, pos, quote) -> ([[word, literal]...], end): shell words of one
# command, stopping at a command boundary or at the enclosing quote char.
sub words {
  my ($s, $p, $q) = @_;
  my $n = length $s;
  my (@w, @st);
  my ($cur, $lit, $in) = ("", 1, 0);
  my $flush = sub { push @w, [ $cur, $lit ] if $in; ($cur, $lit, $in) = ("", 1, 0) };
  while ($p < $n) {
    my $c = substr($s, $p, 1);
    my $top = @st ? $st[-1] : "";
    last if $c eq "\n";
    if ($top eq "\x27") { if ($c eq "\x27") { pop @st } else { $cur .= $c } $p++; next }
    if ($c eq "\\") {
      my $nx = substr($s, $p + 1, 1);
      if ($nx eq "\n") { $flush->() if $top eq ""; $p += 2; next }
      $cur .= $nx; $in = 1; $p += 2; next;
    }
    if ($top eq "\"") {
      if ($c eq "\"") { pop @st; $p++; next }
      if ($c eq "\$") {
        $lit = 0;
        my $nx = substr($s, $p + 1, 1);
        if ($nx eq "(" || $nx eq "{") { push @st, $nx; $cur .= $c . $nx; $p += 2; next }
      }
      $cur .= $c; $p++; next;
    }
    if ($top eq "") {
      last if $q ne "" && $c eq $q;
      if ($c eq " " || $c eq "\t") { $flush->(); $p++; next }
      last if $c =~ /[;|)`]/;
      last if $c eq "&" && !(($p && substr($s, $p - 1, 1) =~ /[<>]/) || substr($s, $p + 1, 1) eq ">");
    }
    $in = 1;
    if ($c eq "\x27" || $c eq "\"") { push @st, $c; $p++; next }
    if ($c eq "\$") {
      $lit = 0;
      my $nx = substr($s, $p + 1, 1);
      if ($nx eq "(" || $nx eq "{") { push @st, $nx; $cur .= $c . $nx; $p += 2; next }
    }
    elsif ($c eq "(") { push @st, "(" }
    elsif ($c eq ")" && $top eq "(") { pop @st }
    elsif ($c eq "}" && $top eq "{") { pop @st }
    $cur .= $c; $p++;
  }
  $flush->();
  return (\@w, $p);
}

# Index of the `plugin`/`plugins`/`mcp` word after the program, skipping
# global options and their values; -1 when the call is not a plugin/mcp call.
sub find_group {
  my ($t, $argv) = @_;
  my $val = 0;
  for my $i (0 .. $#$t) {
    my ($v, $lit) = @{ $t->[$i] };
    return $i if $lit && $v =~ /^(?:plugins?|mcp)$/;
    if (!$lit) { $val = 1; next }
    if ($v =~ /^-/ && $v ne "--") { $val = $v !~ /=/; next }
    if ($val) { $val = 0; next }
    next if $argv && $i == 0 && $v =~ m{(?:^|/)claude$};
    return -1;
  }
  return -1;
}

sub pinned {
  my ($t, $short) = @_;
  my $scope;
  for (my $i = 0; $i < @$t; $i++) {
    my ($v, $lit) = @{ $t->[$i] };
    last if $lit && $v eq "--";
    if ($lit && ($v eq "--scope" || ($short && $v eq "-s"))) {
      my $val = $t->[ ++$i ];
      $scope = $val && $val->[1] ? $val->[0] : "";
    } elsif ($v =~ /^--scope=(.*)/s || ($short && $v =~ /^-s(.+)/s)) {
      $scope = $lit ? $1 : "";
    }
  }
  return defined $scope && $scope eq "project";
}

sub verdict {
  my ($t, $pin, $bare, $short) = @_;
  my ($v, $lit) = @{ $t->[0] };
  my @after = @$t[ 1 .. $#$t ];
  return !pinned($t, 1) unless $lit;
  return 0 if $v =~ /^(?:-h|--help|help)$/;
  return !pinned($t, 1) if $v =~ /^-/;
  return 1 if $bare->{$v};
  return !pinned(\@after, $short) if $pin->{$v};
  return 0;
}

# check(group, tokens after the group word) -> 1 when the call is unpinned.
sub check {
  my ($group, $t) = @_;
  return 0 unless @$t;
  return verdict($t, \%MCP_PIN, \%MCP_BARE, 1) if $group eq "mcp";
  if ($t->[0][1] && $t->[0][0] eq "marketplace") {
    my @rest = @$t[ 1 .. $#$t ];
    return @rest ? verdict(\@rest, \%MKT_PIN, \%MKT_BARE, 0) : 0;
  }
  return verdict($t, \%PLUGIN_PIN, \%PLUGIN_BARE, 1);
}

sub element {
  my ($c) = @_;
  return [ "", 0 ] unless @$c;
  return [ $c->[0][1], $c->[0][2] ] if @$c == 1 && $c->[0][0] eq "s";
  return [ $c->[0][0] eq "s" ? $c->[0][1] : join(" ", map { $_->[1] } @$c), 0 ];
}

# arrays(tokens) -> ([pos, [[element, literal]...]]...) for every [...] literal.
sub arrays {
  my ($toks) = @_;
  my (@out, @fr);
  my %open = ("]" => "[", ")" => "(", "}" => "{");
  for my $t (@$toks) {
    my ($k, $v) = @$t;
    my $f = @fr ? $fr[-1] : undef;
    if ($k eq "p" && $v =~ /^[\[({]$/) {
      push @{ $f->{cur} }, [ "o", $v ] if $f && $f->{t} eq "[";
      push @fr, { t => $v, elems => [], cur => [], pos => $t->[3] };
      next;
    }
    if ($k eq "p" && $open{$v}) {
      next unless $f && $f->{t} eq $open{$v};
      pop @fr;
      next unless $v eq "]";
      push @{ $f->{elems} }, $f->{cur} if @{ $f->{cur} };
      push @out, [ $f->{pos}, [ map { element($_) } @{ $f->{elems} } ] ];
      next;
    }
    next unless $f && $f->{t} eq "[";
    if ($k eq "p") { push @{ $f->{elems} }, $f->{cur}; $f->{cur} = []; next }
    push @{ $f->{cur} }, $t;
  }
  return @out;
}

for my $file (@ARGV) {
  open my $fh, "<", $file or next;
  my $raw = do { local $/; <$fh> };
  close $fh;
  $raw = "" unless defined $raw;
  my $js = $file =~ /\.(?:[cm]?js|[cm]?ts)$/;
  my ($text, $map, $toks) = lex($raw, $js);
  my %prog;
  while ($text =~ /(?<![\w\$])([A-Za-z_]\w*)[ \t]*=(?![=~])[ \t]*([^\n;]*)/g) {
    my ($var, $value) = ($1, $2);
    $prog{$var} = 1 if $value =~ /(?<![\w.-])claude(?![\w.-])/;
  }
  my %seen;
  my $report = sub {
    my ($pos, $call) = @_;
    my $n = 1 + (substr($text, 0, $pos) =~ tr/\n//);
    return if $seen{$n}++;
    $call =~ s/\s+/ /g;
    $call =~ s/^ | $//g;
    print "$file:$n: $call\n";
  };
  my $quote = sub {
    my $q = $_[0] < length $map ? substr($map, $_[0], 1) : "";
    return $q =~ /^["\x27]$/ || ($js && $q eq "`") ? $q : "";
  };
  while ($text =~ /(?<![\w.-])claude(?![\w.-])|\$\{(\w+)[^}\n]*\}|\$(\w+)/g) {
    my ($s, $e) = ($-[0], $+[0]);
    my $name = defined $1 ? $1 : $2;
    next if defined $name && !($name =~ /claude/i || $prog{$name});
    my $q = $quote->($e);
    if ($q ne "" && substr($text, $e, 1) eq $q) { $e++; $q = $quote->($e) }
    my ($w, $end) = words($text, $e, $q);
    my $g = find_group($w, 0);
    next if $g < 0;
    next unless check($w->[$g][0], [ @$w[ $g + 1 .. $#$w ] ]);
    $report->($s, substr($text, $s, $end - $s));
  }
  next unless $js;
  for my $arr (arrays($toks)) {
    my ($pos, $el) = @$arr;
    my $g = find_group($el, 1);
    next if $g < 0;
    next unless check($el->[$g][0], [ @$el[ $g + 1 .. $#$el ] ]);
    $report->($pos, "[" . join(", ", map { $_->[0] } @$el) . "]");
  }
}
PERL

# scan <file>... — prints "<file>:<line>: <call>" per unpinned call.
scan() {
  perl -e "$SCANNER" "$@"
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
TRACKED=$(git ls-files -- '*.sh' '*.mjs' '*.js' '*.ts') || {
  echo "Cli-config-scope: FAIL — git ls-files failed; run from a git checkout" >&2
  exit 1
}
FILES=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  allowed "$f" || FILES+=("$f")
done < <(printf '%s\n' "$TRACKED" | grep -Ev '(^|/)(tests?|dist|node_modules)/' | sort)
VIOLATIONS=$(scan "${FILES[@]}")

if [ -n "$VIOLATIONS" ]; then
  printf 'Cli-config-scope: FAIL — config-changing claude plugin/mcp calls not pinned to project scope (the CLI default can reach user scope):\n%s\n' "$VIOLATIONS" >&2
  exit 1
fi
printf 'Cli-config-scope: PASS (%d files)\n' "${#FILES[@]}"
