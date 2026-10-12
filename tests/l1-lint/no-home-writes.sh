#!/usr/bin/env bash
# L1 lint: TMB writes nothing under the user's home directory. Project state
# (trajectory DB, logs, locks, session markers, the headless shim) lives under
# <project>/.claude/<plugin>/; the only path outside the project is the
# embedding model cache, declared once as TMB_MODEL_CACHE_DIR.
#
# Scans scripts/, skills/*/scripts/ and the L5/L6 runners + their libs under
# tests/l5-l6/ (shell, *.sh) and mcp/trajectory-server/src/ (TypeScript, tests
# excluded). A line is a violation when it writes and its target
# references the home directory — directly ($HOME, ${HOME}, ~/, homedir(),
# process.env.HOME) or through a variable assigned from one in the same file.
#   shell writes: > / >> redirects (target), mkdir, tee, touch (any arg),
#                 cp, mv, ln, install (last arg)
#   TS writes:    writeFileSync, mkdirSync, appendFileSync, cpSync,
#                 renameSync, symlinkSync, writeFile, mkdir, appendFile
# TS taint also covers a `homeDir` parameter and functions that return a
# home-rooted path.
# Lines naming TMB_MODEL_CACHE_DIR are allowed. Comment lines are skipped.
#
# Allowlist: tests/l1-lint/no-home-writes.allowlist — repo-relative paths of
# Human-run tools whose job is repairing Claude Code's own config; nothing a
# hook or the server runs may be listed.
#
# --self-test runs the checks against fixtures/no-home-writes/.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/no-home-writes"

# scan <file>... — prints "<file>:<line>: <text>" per violation.
scan() {
  perl -e '
    use strict; use warnings;
    my $home_sh = qr/\$\{?HOME\b\}?|(?:^|[\s"=:(])~\//;
    my $home_ts = qr/\bhomedir\s*\(\s*\)|process\.env(?:\.HOME\b|\[\s*["\x27]HOME["\x27]\s*\])/;
    for my $file (@ARGV) {
      open my $fh, "<", $file or next;
      my @lines = <$fh>;
      close $fh;
      my $ts = $file =~ /\.ts$/;
      for (@lines) { $ts ? s{\s+//\s.*$}{} : s{\s+#\s.*$}{} }
      my $home = $ts ? $home_ts : $home_sh;
      my %taint;
      # TS: a home-directory parameter, and functions that return a home path.
      if ($ts) {
        $taint{homeDir} = 1;
        my $fn;
        for my $l (@lines) {
          $fn = $1 if $l =~ /\bfunction\s+([A-Za-z_]\w*)\s*\(/;
          $taint{$fn} = 1 if defined $fn && $l =~ /\breturn\b/ && $l =~ $home && $l !~ /TMB_MODEL_CACHE_DIR/;
        }
      }
      my $changed = 1;
      while ($changed) {
        $changed = 0;
        for my $l (@lines) {
          next if $l =~ /^\s*(#|\/\/|\*)/;
          next if $l =~ /TMB_MODEL_CACHE_DIR/;
          my ($name, $rhs) = $ts
            ? ($l =~ /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(.*)/)
            : ($l =~ /^\s*(?:local\s+|export\s+|readonly\s+)?([A-Za-z_]\w*)=(.*)/);
          next unless defined $name;
          next if $taint{$name};
          # Taint follows path construction, not values read from a path.
          next if $ts && $rhs =~ /\b(?:readFileSync|readdirSync|existsSync|statSync|lstatSync|JSON\.parse)\b/;
          next if !$ts && $rhs =~ /\$\((?!\s*dirname\b)/;
          my $hit = $rhs =~ $home;
          if (!$hit) {
            for my $t (keys %taint) {
              if ($ts ? $rhs =~ /\b\Q$t\E\b/ : $rhs =~ /\$\{?\Q$t\E\b/) { $hit = 1; last }
            }
          }
          if ($hit) { $taint{$name} = 1; $changed = 1 }
        }
      }
      my $refs = sub {
        my ($s) = @_;
        return 1 if $s =~ $home;
        for my $t (keys %taint) {
          return 1 if ($ts ? $s =~ /\b\Q$t\E\b/ : $s =~ /\$\{?\Q$t\E\b/);
        }
        return 0;
      };
      my $n = 0;
      for my $l (@lines) {
        $n++;
        next if $l =~ /^\s*(#|\/\/|\*)/;
        next if $l =~ /TMB_MODEL_CACHE_DIR/;
        my $bad = 0;
        if ($ts) {
          while ($l =~ /\b(?:writeFileSync|mkdirSync|appendFileSync|cpSync|renameSync|symlinkSync|writeFile|mkdir|appendFile)\s*\(([^;]*)/g) {
            $bad = 1 if $refs->($1);
          }
        } else {
          while ($l =~ /(?<![0-9&<>])>>?\s*("[^"]*"|\x27[^\x27]*\x27|[^\s;|&)]+)/g) {
            my $target = $1;
            next if $target =~ m{^/dev/null$|^&};
            $bad = 1 if $refs->($target);
          }
          for my $seg (split /(?:&&|\|\||;|\|)/, $l) {
            if ($seg =~ /(?:^|\s)(mkdir|tee|touch)\s+(.*)/) {
              $bad = 1 if $refs->($2);
            } elsif ($seg =~ /(?:^|\s)(cp|mv|ln|install)\s+(.*)/) {
              my @args = grep { $_ ne "" && $_ !~ /^-/ && $_ !~ /^\d*>/ } split /\s+/, $2;
              $bad = 1 if @args && $refs->($args[-1]);
            }
          }
        }
        if ($bad) { chomp(my $t = $l); $t =~ s/^\s+//; print "$file:$n: $t\n" }
      }
    }
  ' "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  bad=$(scan "$FIXTURES"/bad.sh "$FIXTURES"/bad.ts | wc -l | tr -d ' ')
  expected_bad=$(grep -c 'VIOLATION' "$FIXTURES"/bad.sh "$FIXTURES"/bad.ts | awk -F: '{s+=$2} END {print s}')
  good=$(scan "$FIXTURES"/good.sh "$FIXTURES"/good.ts)
  [ "$bad" = "$expected_bad" ] || { printf 'no-home-writes self-test: expected %s violations in bad fixtures, got %s\n' "$expected_bad" "$bad" >&2; scan "$FIXTURES"/bad.sh "$FIXTURES"/bad.ts >&2; fail=1; }
  [ -z "$good" ] || { printf 'no-home-writes self-test: false positives in good fixtures:\n%s\n' "$good" >&2; fail=1; }
  [ "$fail" -eq 0 ] && echo "No-home-writes self-test: PASS"
  exit "$fail"
fi

cd "$ROOT" || exit 1
ALLOWLIST="tests/l1-lint/no-home-writes.allowlist"
allowed() {
  [ -f "$ALLOWLIST" ] && grep -v '^[[:space:]]*#' "$ALLOWLIST" | grep -xF "$1" >/dev/null
}
FILES=()
while IFS= read -r f; do allowed "$f" || FILES+=("$f"); done < <(
  find scripts skills/*/scripts -type f -name '*.sh' 2>/dev/null | sort
  find tests/l5-l6 tests/l5-l6/lib -maxdepth 1 -type f -name '*.sh' | sort
  find mcp/trajectory-server/src -type f -name '*.ts' -not -path '*/test/*' | sort
)
VIOLATIONS=$(scan "${FILES[@]}")

if [ -n "$VIOLATIONS" ]; then
  printf 'No-home-writes: FAIL — writes under the home directory (project state belongs in <project>/.claude/<plugin>/):\n%s\n' "$VIOLATIONS" >&2
  exit 1
fi
printf 'No-home-writes: PASS (%d files)\n' "${#FILES[@]}"
