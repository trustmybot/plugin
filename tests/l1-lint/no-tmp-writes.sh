#!/usr/bin/env bash
# L1 lint: TMB writes nothing to a hard-coded /tmp or /var/tmp path. Scratch
# files go under $TMPDIR (mktemp, `${TMPDIR:-/tmp}`, os.tmpdir()) or the
# project's <project>/.claude/<plugin>/ state dir.
#
# Scans scripts/, skills/, agents/, commands/ (shell, JS/TS, Python, Markdown
# code) and mcp/trajectory-server/src/ (TypeScript). A line is a violation when
# it writes and its target is a literal /tmp, /private/tmp or /var/tmp path —
# directly or through a variable assigned one in the same file.
#   shell writes: > / >> redirects (target), mkdir, tee, touch (any arg),
#                 mktemp (template or -p/--tmpdir dir), cp, mv, ln, install,
#                 rsync (last arg), TMPDIR=/tmp
#   JS/TS/Py:     writeFileSync, mkdirSync, mkdtempSync, appendFileSync,
#                 cpSync, copyFileSync, renameSync, symlinkSync,
#                 createWriteStream, writeFile, mkdir, mkdtemp, appendFile,
#                 open(..., 'w'|'a'|'x')
# Reads of /tmp paths and `${TMPDIR:-/tmp}` fallbacks are fine. Comment lines
# are skipped.
#
# Allowlist: tests/l1-lint/no-tmp-writes.allowlist — repo-relative paths.
#
# --self-test runs the checks against fixtures/no-tmp-writes/.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/tests/l1-lint/fixtures/no-tmp-writes"

# scan <file>... — prints "<file>:<line>: <text>" per violation.
scan() {
  perl -e '
    use strict; use warnings;
    my $tmp = qr{(?<![\w.\$\}/-])/(?:private/|var/)?tmp(?![\w.-])};
    my $write_fn = qr/\b(?:writeFileSync|mkdirSync|mkdtempSync|appendFileSync|cpSync|copyFileSync|renameSync|symlinkSync|createWriteStream|writeFile|mkdir|mkdtemp|appendFile)\s*\(([^;]*)/;
    for my $file (@ARGV) {
      open my $fh, "<", $file or next;
      my @lines = <$fh>;
      close $fh;
      my $code = $file =~ /\.(?:[cm]?js|ts|py)$/;
      for (@lines) {
        s{\$\{TMPDIR:?-/(?:private/|var/)?tmp\}}{\$TMPDIR}g;
        $code ? s{\s+(?://|#)\s.*$}{} : s{\s+#\s.*$}{};
      }
      my %taint;
      my $changed = 1;
      while ($changed) {
        $changed = 0;
        for my $l (@lines) {
          next if $l =~ /^\s*(#|\/\/|\*)/;
          my ($name, $rhs) = $code
            ? ($l =~ /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)\s*(.*)/)
            : ($l =~ /^\s*(?:local\s+|export\s+|readonly\s+)?([A-Za-z_]\w*)=(.*)/);
          next unless defined $name;
          next if $taint{$name};
          my $hit = $rhs =~ /^\s*["\x27`]?$tmp/;
          if (!$hit) {
            for my $t (keys %taint) {
              if ($code ? $rhs =~ /^\s*["\x27`]?\$?\{?\Q$t\E\b/ : $rhs =~ /^\s*"?\$\{?\Q$t\E\b/) { $hit = 1; last }
            }
          }
          if ($hit) { $taint{$name} = 1; $changed = 1 }
        }
      }
      my $refs = sub {
        my ($s) = @_;
        return 1 if $s =~ /^\s*["\x27`]?$tmp/;
        for my $t (keys %taint) {
          return 1 if ($code ? $s =~ /^\s*["\x27`]?\$?\{?\Q$t\E\b/ : $s =~ /^\s*"?\$\{?\Q$t\E\b/);
        }
        return 0;
      };
      my $n = 0;
      for my $l (@lines) {
        $n++;
        next if $l =~ /^\s*(#|\/\/|\*)/;
        my $bad = 0;
        if ($code) {
          while ($l =~ /$write_fn/g) {
            $bad = 1 if $refs->($1);
          }
          if ($l =~ /\bopen\s*\(([^,]*),\s*["\x27][wax]/) {
            $bad = 1 if $refs->($1);
          }
        } else {
          while ($l =~ /(?<![0-9&<>])>>?\s*("[^"]*"|\x27[^\x27]*\x27|[^\s;|&)]+)/g) {
            my $target = $1;
            next if $target =~ m{^/dev/null$|^&};
            $bad = 1 if $refs->($target);
          }
          $bad = 1 if $l =~ /(?:^|[\s;&|(])(?:export\s+)?TMPDIR=["\x27]?$tmp/;
          for my $seg (split /(?:&&|\|\||;|\|)/, $l) {
            if ($seg =~ /(?:^|[\s(])(mkdir|tee|touch|mktemp)\s+(.*)/) {
              my @args = grep { $_ ne "" && $_ !~ /^-[^-]*$/ } split /\s+|=/, $2;
              for my $a (@args) { $bad = 1 if $refs->($a) }
            } elsif ($seg =~ /(?:^|[\s(])(cp|mv|ln|install|rsync)\s+(.*)/) {
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
  [ "$bad" = "$expected_bad" ] || { printf 'no-tmp-writes self-test: expected %s violations in bad fixtures, got %s\n' "$expected_bad" "$bad" >&2; scan "$FIXTURES"/bad.sh "$FIXTURES"/bad.ts >&2; fail=1; }
  [ -z "$good" ] || { printf 'no-tmp-writes self-test: false positives in good fixtures:\n%s\n' "$good" >&2; fail=1; }
  [ "$fail" -eq 0 ] && echo "No-tmp-writes self-test: PASS"
  exit "$fail"
fi

cd "$ROOT" || exit 1
ALLOWLIST="tests/l1-lint/no-tmp-writes.allowlist"
allowed() {
  [ -f "$ALLOWLIST" ] && grep -v '^[[:space:]]*#' "$ALLOWLIST" | grep -qxF "$1"
}
FILES=()
while IFS= read -r f; do allowed "$f" || FILES+=("$f"); done < <(
  find scripts skills agents commands -type f \( -name '*.sh' -o -name '*.bash' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.ts' -o -name '*.py' -o -name '*.md' \) -not -path '*/node_modules/*' 2>/dev/null | sort
  find mcp/trajectory-server/src -type f -name '*.ts' | sort
)
VIOLATIONS=$(scan "${FILES[@]}")

if [ -n "$VIOLATIONS" ]; then
  printf 'No-tmp-writes: FAIL — writes to a hard-coded /tmp path (use $TMPDIR or <project>/.claude/<plugin>/):\n%s\n' "$VIOLATIONS" >&2
  exit 1
fi
printf 'No-tmp-writes: PASS (%d files)\n' "${#FILES[@]}"
