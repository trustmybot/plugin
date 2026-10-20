#!/usr/bin/env bash
# Every SQL the hook read helpers run is read-only.
#
# tmb_gate_read, tmb_sqlite_ro and tmb_db_read_budget (scripts/hooks/lib/
# query-task.sh) read a WAL DB nobody holds open without -readonly, so the SQL
# itself is what keeps a hook read from writing. Checked:
#   - every call site of tmb_gate_read and tmb_sqlite_ro under scripts/: each
#     statement of the SQL argument (after whitespace and comments) starts with
#     SELECT, WITH (without INSERT/UPDATE/DELETE/REPLACE), or a read-only
#     PRAGMA: `journal_mode` or `user_version` without `=`, or `table_info(...)`.
#     The SQL must be a literal: a bare variable cannot be checked and is
#     flagged (the one exemption: tmb_sqlite_ro handing its own argument on);
#   - the `sql` of every contract in scripts/hooks/lib/data-contracts.json, the
#     script session-start-prescan.sh runs through tmb_db_read_budget;
#   - no hook calls `sqlite3 -readonly` itself outside lib/query-task.sh: every
#     hook read goes through the helpers.
#
# --self-test: fixtures/gate-read-sql-readonly/good.sh must pass and every call
# site in bad.sh must be flagged. Every run self-tests first.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
FIXTURES="$HERE/fixtures/gate-read-sql-readonly"
CONTRACTS="$PLUGIN_ROOT/scripts/hooks/lib/data-contracts.json"

# scan [--contracts <json-lines file>] <file>... — prints one
# `<where>: <reason>` per offending SQL.
scan() {
  perl -e '
    use strict; use warnings;
    use JSON::PP;
    sub stmt_ok {
      my ($s) = @_;
      $s =~ s/^\s+//; $s =~ s/\s+$//;
      return 1 if $s eq "";
      return "starts with a dot command" if $s =~ /^\./;
      my ($kw) = $s =~ /^([A-Za-z]+)/;
      return "statement has no keyword" unless defined $kw;
      $kw = uc $kw;
      return 1 if ($kw eq "SELECT" || $kw eq "WITH") && $s !~ /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i;
      if ($kw eq "PRAGMA") {
        return 1 if $s =~ /^PRAGMA\s+(?:\w+\.)?(journal_mode|user_version)\s*$/i;
        return 1 if $s =~ /^PRAGMA\s+(?:\w+\.)?table_info\s*\(\s*[\w"\x27]+\s*\)\s*$/i;
        return "PRAGMA is not a read-only pragma read";
      }
      return "statement starts with $kw";
    }
    sub sql_ok {
      my ($sql) = @_;
      $sql =~ s{/\*.*?\*/}{ }gs;
      $sql =~ s/--[^\n]*//g;
      $sql =~ s/\x27[^\x27]*\x27/\x27\x27/g;
      for my $st (split /;/, $sql) {
        my $r = stmt_ok($st);
        return $r if $r ne "1";
      }
      return 1;
    }
    if (@ARGV && $ARGV[0] eq "--contracts") {
      shift @ARGV;
      my $lines = shift @ARGV;
      open my $ch, "<", $lines or die "$lines: $!";
      while (my $l = <$ch>) {
        my ($id, $sql) = @{ decode_json($l) };
        my $r = sql_ok($sql);
        print "data-contracts.json: contract $id: sql must be read-only ($r)\n" if $r ne "1";
      }
      close $ch;
    }
    for my $file (@ARGV) {
      open my $fh, "<", $file or die "$file: $!";
      local $/; my $src = <$fh>; close $fh;
      $src =~ s/^([ \t]*#[^\n]*)$/" " x length($1)/gme;
      my $helper = $file =~ m{/scripts/hooks/lib/query-task\.sh$};
      if ($file =~ m{/scripts/hooks/} && !$helper) {
        while ($src =~ /\bsqlite3\b[^\n]*?[ \t]-readonly\b/g) {
          my $line = 1 + (() = substr($src, 0, $-[0]) =~ /\n/g);
          print "$file:$line: sqlite3 -readonly outside lib/query-task.sh (read through tmb_gate_read / tmb_sqlite_ro)\n";
        }
      }
      while ($src =~ /(?<!-F )\b(tmb_gate_read|tmb_sqlite_ro)\b(?![ \t]*\(\))[ \t]+("(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\S+)[ \t]*(?:\\\n[ \t]*)?("(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\S+)?/g) {
        my ($start, $fn, $arg) = ($-[0], $1, defined $3 ? $3 : "");
        my $line = 1 + (() = substr($src, 0, $start) =~ /\n/g);
        next if $helper && $fn eq "tmb_gate_read" && $arg eq q{"${2:-}"};
        my $why;
        if ($arg =~ /^"(.*)"$/s || $arg =~ /^\x27(.*)\x27$/s) {
          my $sql = $1;
          if ($sql =~ /^\s*\$\{?\w+(?::-)?\}?\s*$/) {
            $why = "SQL is a variable, not a literal";
          } else {
            my $r = sql_ok($sql);
            $why = $r if $r ne "1";
          }
        } else {
          $why = "SQL argument is not a quoted literal";
        }
        print "$file:$line: $fn SQL must be read-only ($why)\n" if defined $why;
      }
    }
  ' -- "$@"
}

run_self_test() {
  local ok=1 out bad_sites hits
  out=$(scan "$FIXTURES/good.sh")
  if [ -n "$out" ]; then
    printf 'gate-read-sql-readonly --self-test: FAIL (good.sh flagged)\n%s\n' "$out" >&2
    ok=0
  fi
  bad_sites=$(grep -cE 'tmb_gate_read|tmb_sqlite_ro' "$FIXTURES/bad.sh")
  hits=$(scan "$FIXTURES/bad.sh" | grep -c . || true)
  if [ "$hits" -ne "$bad_sites" ]; then
    printf 'gate-read-sql-readonly --self-test: FAIL (bad.sh: %s of %s call sites flagged)\n' "$hits" "$bad_sites" >&2
    scan "$FIXTURES/bad.sh" >&2
    ok=0
  fi
  [ "$ok" = 1 ] || return 1
  printf 'gate-read-sql-readonly --self-test: PASS (%s bad call sites caught, good.sh clean)\n' "$hits"
}

if [ "${1:-}" = "--self-test" ]; then
  run_self_test
  exit $?
fi

run_self_test >/dev/null || { run_self_test; exit 1; }

FILES=()
while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(find "$PLUGIN_ROOT/scripts" -name '*.sh' -not -path '*/node_modules/*' -print0)

CONTRACT_LINES=$(jq -c '.contracts[] | [.id, .sql]' "$CONTRACTS" 2>/dev/null) || {
  printf 'gate-read-sql-readonly: cannot read %s\n' "$CONTRACTS" >&2
  exit 1
}
OUT=$(scan --contracts <(printf '%s\n' "$CONTRACT_LINES") "${FILES[@]}") || {
  printf '%s\n' "$OUT" >&2
  printf 'gate-read-sql-readonly: the scan itself failed\n' >&2
  exit 1
}
if [ -n "$OUT" ]; then
  printf "%s\n" "$OUT" | sed "s|^$PLUGIN_ROOT/||"
  printf '\ngate-read-sql-readonly: FAIL\n' >&2
  exit 1
fi
printf 'gate-read-sql-readonly: PASS (%s files, %s contracts scanned)\n' "${#FILES[@]}" "$(printf '%s\n' "$CONTRACT_LINES" | grep -c .)"
