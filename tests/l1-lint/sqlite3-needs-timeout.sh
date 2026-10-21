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
# Each file is lexed as shell: `\` continuations joined, quotes, `$( )`,
# backticks, `${ }`, process substitution and heredocs honoured, and the text
# split into simple commands at unquoted `;` `&` `|` `(` `)` and newlines, so
# a case arm `a)`, `{`, `then`, `do`, `else`, `!`, `&&`, `||`, `|`, `$(` and a
# backtick all start a command. A command invokes sqlite3 when, after leading
# keywords, VAR=x assignments and sudo / nice / env / command / exec / time /
# timeout N / gtimeout N / stdbuf / ionice / coproc [NAME {] / nohup / xargs
# wrappers (with their options), its name is `sqlite3`, a path ending in
# /sqlite3 (quoted or not), `$(command -v sqlite3 ...)`, or `$V` / `${V}` /
# `${V:?}` / `${V:-sqlite3}` for a variable the file assigns sqlite3,
# `${W:-sqlite3}` or `$(command -v sqlite3 ...)`; `"${A[@]}"` for an array
# whose first command word is sqlite3 counts unless the array holds a timeout.
# `find -exec sqlite3`, and the string run by `eval` or `sh|bash|zsh -c`, are
# lexed as commands too. `sqlite3` followed by an option anywhere in a
# command (`set -- sqlite3 -readonly ...`) counts too. The invocation passes
# when its own arguments, redirections or heredoc body (after the sqlite3
# word, up to the end of that command), or an array expanded there, hold
# `.timeout` or `busy_timeout`.
# Comments, quoted messages and heredoc text are data, never commands.
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
  perl - "$@" <<'PERL'
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

our ($s, $i, $n, @cmds, @pending, $lost);

sub newcmd { my $c = { words => [], extra => [] }; push @cmds, $c; return $c }

sub skipws {
  while ($i < $n) {
    my $c = substr($s, $i, 1);
    if ($c eq " " || $c eq "\t") { $i++; next }
    if ($c eq "\\" && substr($s, $i + 1, 1) eq "\n") { $i += 2; next }
    last;
  }
}

sub read_heredocs {
  while (my $h = shift @pending) {
    my $body = "";
    while ($i < $n) {
      my $e = index($s, "\n", $i);
      $e = $n if $e < 0;
      my $line = substr($s, $i, $e - $i);
      $i = $e + 1;
      (my $t = $line) =~ s/^\s+|\s+$//g;
      last if $t eq $h->{delim};
      $body .= "$line\n";
    }
    $i = $n if $i > $n;
    push @{ $h->{cmd}{extra} }, $body;
  }
}

sub arith {
  my $d = shift;
  while ($i < $n && $d > 0) {
    my $c = substr($s, $i++, 1);
    $d++ if $c eq "(";
    $d-- if $c eq ")";
  }
  $lost ||= "unterminated \$((" if $d > 0;
}

sub dollar_paren {
  if (substr($s, $i, 3) eq "\$((") { $i += 3; arith(2); return }
  $i += 2;
  parse(")");
}

sub squote {
  my $e = index($s, "'", $i + 1);
  if ($e < 0) { $lost ||= "unterminated '"; $e = $n }
  my $v = substr($s, $i + 1, $e - $i - 1);
  $i = $e + 1;
  return $v;
}

sub dquote {
  my ($vr) = @_;
  while ($i < $n) {
    my $c = substr($s, $i, 1);
    if ($c eq "\\") {
      my $d = substr($s, $i + 1, 1);
      $$vr .= $d eq "\n" ? "" : $d =~ /[\$`"\\]/ ? $d : "\\$d";
      $i += 2;
      next;
    }
    if ($c eq "\"") { $i++; return }
    if ($c eq "`") { my $st = $i++; parse("`"); $$vr .= substr($s, $st, $i - $st); next }
    if ($c eq "\$" && substr($s, $i + 1, 1) eq "(") { my $st = $i; dollar_paren(); $$vr .= substr($s, $st, $i - $st); next }
    if ($c eq "\$" && substr($s, $i + 1, 1) eq "{") { my $st = $i; $i += 2; brace(1); $$vr .= substr($s, $st, $i - $st); next }
    $$vr .= $c;
    $i++;
  }
  $lost ||= "unterminated \"";
}

sub brace {
  my ($inq) = @_;
  my $d = 1;
  while ($i < $n) {
    my $c = substr($s, $i, 1);
    if ($c eq "\\") { $i += 2; next }
    if ($c eq "}") { $i++; return if --$d == 0; next }
    if ($c eq "\$" && substr($s, $i + 1, 1) eq "{") { $i += 2; $d++; next }
    if ($c eq "\$" && substr($s, $i + 1, 1) eq "(") { dollar_paren(); next }
    if ($c eq "\"") { $i++; my $junk = ""; dquote(\$junk); next }
    if ($c eq "'" && !$inq) { squote(); next }
    if ($c eq "`") { $i++; parse("`"); next }
    $i++;
  }
  $lost ||= "unterminated \${";
}

sub lex_word {
  my ($term) = @_;
  my $start = $i;
  my $val = "";
  while ($i < $n) {
    my $c = substr($s, $i, 1);
    if ($c eq "\\") {
      my $d = substr($s, $i + 1, 1);
      $i += 2;
      $val .= $d unless $d eq "\n";
      next;
    }
    last if $c =~ /[ \t\r\n;&|<>()]/;
    if ($c eq "`") {
      last if $term eq "`";
      my $st = $i++;
      parse("`");
      $val .= substr($s, $st, $i - $st);
      next;
    }
    if ($c eq "'") { $val .= squote(); next }
    if ($c eq "\"") { $i++; dquote(\$val); next }
    if ($c eq "\$") {
      my $d = substr($s, $i + 1, 1);
      if ($d eq "'") {
        $i += 2;
        while ($i < $n) {
          my $x = substr($s, $i, 1);
          if ($x eq "\\") { $val .= substr($s, $i + 1, 1); $i += 2; next }
          last if $x eq "'";
          $val .= $x;
          $i++;
        }
        $i++;
        next;
      }
      if ($d eq "(") { my $st = $i; dollar_paren(); $val .= substr($s, $st, $i - $st); next }
      if ($d eq "{") { my $st = $i; $i += 2; brace(0); $val .= substr($s, $st, $i - $st); next }
    }
    if ($c eq "=" && substr($s, $i + 1, 1) eq "(" && $val =~ /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?$/) {
      my $st = $i;
      $i += 2;
      while (1) {
        while ($i < $n && substr($s, $i, 1) =~ /[ \t\r\n]/) { $i++ }
        if ($i < $n && substr($s, $i, 1) eq "#") { my $e = index($s, "\n", $i); $i = $e < 0 ? $n : $e; next }
        if ($i >= $n) { $lost ||= "unterminated array"; last }
        if (substr($s, $i, 1) eq ")") { $i++; last }
        my $w = lex_word("");
        $i++ unless defined $w;
      }
      $val .= substr($s, $st, $i - $st);
      next;
    }
    $val .= $c;
    $i++;
  }
  return undef if $i == $start;
  return { raw => substr($s, $start, $i - $start), val => $val, pos => $start };
}

sub redirect {
  my ($cmd) = @_;
  if (substr($s, $i, 2) =~ /^[<>]\(/) {
    my $st = $i;
    $i += 2;
    parse(")");
    push @{ $cmd->{words} }, { raw => substr($s, $st, $i - $st), val => "", pos => $st };
    return;
  }
  if (substr($s, $i, 3) eq "<<<") {
    $i += 3;
    skipws();
    my $w = lex_word("");
    push @{ $cmd->{extra} }, $w->{raw} if $w;
    return;
  }
  if (substr($s, $i, 2) eq "<<") {
    $i += 2;
    $i++ if substr($s, $i, 1) eq "-";
    skipws();
    my $w = lex_word("");
    push @pending, { delim => $w->{val}, cmd => $cmd } if $w && $w->{val} =~ /^[A-Za-z_][\w.-]*$/;
    return;
  }
  $i++ while $i < $n && substr($s, $i, 1) =~ /[<>&|]/;
  $i++ if substr($s, $i, 1) eq "-";
  skipws();
  my $w = lex_word("");
  push @{ $cmd->{extra} }, $w->{raw} if $w;
}

sub parse {
  my ($term) = @_;
  my $cmd = newcmd();
  my ($depth, $case) = (0, 0);
  while ($i < $n) {
    my $c = substr($s, $i, 1);
    if ($c eq "\\" && substr($s, $i + 1, 1) eq "\n") { $i += 2; next }
    if ($c eq " " || $c eq "\t" || $c eq "\r") { $i++; next }
    if ($c eq "\n") { $i++; $cmd = newcmd(); read_heredocs() if @pending; next }
    if ($c eq "#") { my $e = index($s, "\n", $i); $i = $e < 0 ? $n : $e; next }
    if ($c eq "`" && $term eq "`") { $i++; return }
    if ($c eq ")") {
      $i++;
      if ($depth > 0) { $depth-- }
      elsif ($term eq ")" && !$case) { return }
      $cmd = newcmd();
      next;
    }
    if ($c eq "(") { $i++; $depth++; $cmd = newcmd(); next }
    if ($c eq "&" && substr($s, $i + 1, 1) eq ">") { $i++; redirect($cmd); next }
    if ($c =~ /[;&|]/) { $i++; $cmd = newcmd(); next }
    if ($c eq "<" || $c eq ">") { redirect($cmd); next }
    my $w = lex_word($term);
    if (!defined $w) { $i++; next }
    next if $w->{raw} =~ /^\d+$/ && substr($s, $i, 1) =~ /[<>]/;
    if (!@{ $cmd->{words} }) {
      $case++ if $w->{val} eq "case";
      $case-- if $w->{val} eq "esac" && $case;
    }
    push @{ $cmd->{words} }, $w;
  }
  $lost ||= "unterminated " . ($term eq "`" ? "backtick" : "\$( or (") if $term ne "";
}

sub cmd_name {
  my ($w) = @_;
  my ($k, $m) = (0, scalar @$w);
  my $opts = sub {
    my ($witharg) = @_;
    while ($k < $m && $w->[$k]{val} =~ /^-/) {
      my $o = $w->[$k++]{val};
      $k++ if $o =~ $witharg;
    }
  };
  while ($k < $m) {
    my $v = $w->[$k]{val};
    if ($v =~ /^(?:if|then|elif|else|do|while|until|!|\{|nohup)$/
        || $w->[$k]{raw} =~ /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/) { $k++; next }
    if ($v eq "time")    { $k++; $opts->(qr/^$/); next }
    if ($v eq "exec")    { $k++; $opts->(qr/^-a$/); next }
    if ($v eq "nice")    { $k++; $opts->(qr/^-n$/); next }
    if ($v eq "sudo")    { $k++; $opts->(qr/^-[ugCDprtUT]$/); next }
    if ($v eq "xargs")   { $k++; $opts->(qr/^-[IdEnLPsa]$/); next }
    if ($v eq "stdbuf")  { $k++; $opts->(qr/^-[ioe]$/); next }
    if ($v eq "ionice")  { $k++; $opts->(qr/^-[cnp]$/); next }
    if ($v =~ /^g?timeout$/) { $k++; $opts->(qr/^-[sk]$/); $k++; next }
    if ($v eq "coproc") {
      $k++;
      $k++ if $k + 1 < $m && $w->[$k]{val} =~ /^[A-Za-z_]\w*$/ && $w->[$k + 1]{val} eq "{";
      next;
    }
    if ($v eq "command") {
      last if $k + 1 < $m && $w->[$k + 1]{val} =~ /^-[vV]/;
      $k++;
      $opts->(qr/^$/);
      next;
    }
    if ($v eq "env") {
      $k++;
      while ($k < $m) {
        my $o = $w->[$k]{val};
        if ($o =~ /^-[uCS]$/) { $k += 2; next }
        if ($o =~ /^-/ || $w->[$k]{raw} =~ /^[A-Za-z_]\w*=/) { $k++; next }
        last;
      }
      next;
    }
    last;
  }
  return $k;
}

my $SQLITE = qr{^(?:\S*/)?sqlite3$};
my $LOOKUP = qr{(?:command[ \t]+-v|which|type[ \t]+-P)[ \t]+sqlite3\b[^)`]*};
my $SQLVAL = qr{^(?:(?:\S*/)?sqlite3|\$\{[A-Za-z_]\w*:?[-=](?:\S*/)?sqlite3\}|\$\([ \t]*$LOOKUP\)|`[ \t]*$LOOKUP`)$};
my $TIMEOUT = qr{\.timeout\b|busy_timeout};

our (%vars, %arrays);

# 0: not sqlite3, or an array that already carries a timeout; 1: sqlite3.
sub is_sqlite {
  my ($w) = @_;
  return 1 if $w->{val} =~ $SQLVAL;
  if ($w->{raw} =~ /^"?\$\{([A-Za-z_]\w*)\[([^\]]*)\]\}"?$/) {
    my $a = $arrays{$1} or return 0;
    return $a->{sqlite} && !($2 =~ /^[@*]$/ && $a->{timeout}) ? 1 : 0;
  }
  if ($w->{raw} =~ /^"?\$\{?([A-Za-z_]\w*)(?:(:?[-=?+])([^}]*))?\}?"?$/) {
    return 1 if $vars{$1} || $arrays{$1}{sqlite};
    return 1 if defined $2 && $2 =~ /[-=]$/ && $3 =~ $SQLITE;
  }
  return 0;
}

sub array_timeout {
  my ($raw) = @_;
  return $raw =~ /\$\{([A-Za-z_]\w*)\[[@*]\]\}/ && $arrays{$1}{timeout};
}

sub line_of { my ($w) = @_; $w->{ln} // 1 + (substr($s, 0, $w->{pos}) =~ tr/\n//) }

# Lexes shell text held in a string (an eval argument, a `bash -c` script, an
# array body); every word it yields reports line $ln plus its own offset.
sub subparse {
  my ($src, $ln) = @_;
  local ($s, $i, $n, @cmds, @pending, $lost) = ($src, 0, length $src);
  parse("") while $i < $n;
  for my $c (@cmds) { $_->{ln} = $ln + (substr($s, 0, $_->{pos}) =~ tr/\n//) for @{ $c->{words} } }
  return @cmds;
}

# eval ARGS and sh/bash/zsh/dash/ksh -c SCRIPT run their string as shell.
sub nested_source {
  my ($w, $k) = @_;
  my $v = $w->[$k]{val};
  if ($v eq "eval" && $k + 1 < @$w) {
    return (join(" ", map { $_->{val} } @$w[$k + 1 .. $#$w]), line_of($w->[$k + 1]));
  }
  return () unless $v =~ m{^(?:\S*/)?(?:ba|z|da|k)?sh$};
  for (my $j = $k + 1; $j < $#$w && $w->[$j]{val} =~ /^-/; $j++) {
    return ($w->[$j + 1]{val}, line_of($w->[$j + 1])) if $w->[$j]{val} =~ /^-[a-z]*c[a-z]*$/;
  }
  return ();
}

for my $file (@files) {
  open my $fh, "<", $file or next;
  local $/;
  $s = <$fh>;
  close $fh;
  ($i, $n, @cmds, @pending, $lost) = (0, length $s);
  parse("") while $i < $n;
  if ($lost) {
    print "$file: the lint could not lex this file ($lost); fix the file or teach the lexer the construct\n";
    $bad = 1;
    next;
  }
  for (my $ci = 0; $ci < @cmds; $ci++) {
    my $w = $cmds[$ci]{words};
    next unless @$w;
    my $k = cmd_name($w);
    next if $k >= @$w;
    my ($src, $ln) = nested_source($w, $k);
    push @cmds, subparse($src, $ln) if defined $src && length $src;
  }
  local (%vars, %arrays);
  for my $c (@cmds) {
    for my $w (@{ $c->{words} }) {
      my ($name, $value) = $w->{val} =~ /^([A-Za-z_]\w*)=(.*)$/s or next;
      $vars{$name} = 1 if $value =~ $SQLVAL;
    }
  }
  for my $c (@cmds) {
    for my $w (@{ $c->{words} }) {
      my ($name, $plus, $body) = $w->{raw} =~ /^([A-Za-z_]\w*)(\+?)=\((.*)\)$/s or next;
      $arrays{$name}{timeout} ||= $body =~ $TIMEOUT ? 1 : 0;
      next if $plus;
      my ($first) = grep { @{ $_->{words} } } subparse($body, 1);
      $arrays{$name}{sqlite} ||= $first && is_sqlite($first->{words}[cmd_name($first->{words})] // {val => "", raw => ""});
    }
  }
  my @lines = split /\n/, $s, -1;
  my (%seen, %hits);
  for my $c (@cmds) {
    my $w = $c->{words};
    next unless @$w;
    my $k = cmd_name($w);
    my @at;
    push @at, $k if $k < @$w && is_sqlite($w->[$k]);
    my $find = $k < @$w && $w->[$k]{val} =~ m{^(?:\S*/)?find$};
    for my $j ($find ? $k + 1 .. $#$w - 1 : ()) {
      next unless $w->[$j]{val} =~ /^-(?:exec|execdir|ok|okdir)$/;
      my $e = $j + 1 + cmd_name([@$w[$j + 1 .. $#$w]]);
      push @at, $e if $e < @$w && is_sqlite($w->[$e]);
    }
    for my $j ($find ? () : $k + 1 .. $#$w - 1) {
      push @at, $j if $w->[$j]{val} =~ $SQLITE && $w->[$j + 1]{val} =~ /^-/;
    }
    for my $j (@at) {
      my $own = join "\n", (map { $_->{raw} } @$w[$j + 1 .. $#$w]), @{ $c->{extra} };
      next if $own =~ $TIMEOUT || grep { array_timeout($_->{raw}) } @$w[$j + 1 .. $#$w];
      my $ln = line_of($w->[$j]);
      next if $seen{$ln}++;
      my $l = $lines[$ln - 1];
      my ($hit) = grep { $_->{path} eq $file && index($l, $_->{sub}) >= 0 } @allow;
      if ($hit) { $hit->{used} = 1; next }
      (my $t = $l) =~ s/^\s+//;
      $hits{$ln} = "$file:$ln: $t\n";
      $bad = 1;
    }
  }
  print @hits{ sort { $a <=> $b } keys %hits };
}
for (grep { !$_->{used} } @allow) {
  print "ALLOWLIST $allowlist: stale entry (no hit): $_->{path}\t$_->{sub}\n";
  $bad = 1;
}
exit $bad;
PERL
}

# Line numbers of the `# VIOLATION` markers in bad.txt; a marker on a `\`
# continuation line counts for the line the command starts on.
expected_lines() {
  awk '{ cont[NR] = /\\[ \t]*$/ } / # VIOLATION$/ { n = NR; while (n > 1 && cont[n - 1]) n--; print n }' "$1"
}

run_self_test() {
  local fail=0 bad got want expected good
  bad=$(scan /dev/null "$FIXTURES/bad.txt")
  got=$(printf '%s\n' "$bad" | sed -n 's/^[^:]*:\([0-9][0-9]*\):.*/\1/p' | tr '\n' ' ')
  expected=$(expected_lines "$FIXTURES/bad.txt" | tr '\n' ' ')
  if [ "$got" != "$expected" ]; then
    printf 'sqlite3-needs-timeout self-test: bad.txt expected hits on lines [%s], got [%s]:\n%s\n' "$expected" "$got" "$bad" >&2
    fail=1
  fi
  got=$(printf '%s\n' "$bad" | grep -c '^[^:]*:[0-9][0-9]*:')
  want=$(printf '%s' "$expected" | wc -w | tr -d ' ')
  if [ "$got" -ne "$want" ]; then
    printf 'sqlite3-needs-timeout self-test: bad.txt has %d VIOLATION lines, %d reported\n' "$want" "$got" >&2
    fail=1
  fi
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
