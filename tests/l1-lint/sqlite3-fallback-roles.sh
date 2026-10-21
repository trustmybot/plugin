#!/usr/bin/env bash
# L1 lint: the sqlite3 fallback's role table matches the server's role gates.
#
# scripts/lib/sqlite3-fallback.sh writes the trajectory DB when the MCP server
# is down; each `_TMB_FALLBACK_ROLES_<tool>='a,b'` must equal the
# `requireRoles('<tool>', ['a', 'b'])` list in mcp/trajectory-server/src/tools/*.ts,
# in the same order, or the fallback admits a caller the server rejects (or the
# reverse). Fails on a tool the server does not gate, or on any drift.
#
# Every run self-tests first against drifted copies in a private temp dir.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

# check <fallback.sh> <tools dir> — prints one line per drift; exits 1 on any.
check() {
  perl -e '
  use strict; use warnings;
  my ($fallback, $dir) = @ARGV;
  my %server;
  for my $ts (sort glob("$dir/*.ts")) {
    open my $fh, "<", $ts or next;
    local $/;
    my $src = <$fh>;
    while ($src =~ /requireRoles\(\s*\x27(\w+)\x27,\s*\[([^\]]*)\]/g) {
      my ($tool, $roles) = ($1, $2);
      $roles =~ s/[\s\x27"]//g;
      $roles =~ s/,$//;
      $server{$tool} = $roles;
    }
  }
  open my $fb, "<", $fallback or die "sqlite3-fallback-roles: cannot read $fallback\n";
  my ($bad, $n) = (0, 0);
  while (<$fb>) {
    next unless /^_TMB_FALLBACK_ROLES_(\w+)=\x27([^\x27]*)\x27/;
    my ($tool, $roles) = ($1, $2);
    $n++;
    if (!exists $server{$tool}) {
      print "$fallback:$.: $tool has no requireRoles(\x27$tool\x27, [...]) in $dir\n";
      $bad = 1;
    } elsif ($server{$tool} ne $roles) {
      print "$fallback:$.: $tool allows \x27$roles\x27 but the server requires \x27$server{$tool}\x27\n";
      $bad = 1;
    }
  }
  if (!$n) { print "$fallback: no _TMB_FALLBACK_ROLES_<tool> entries found\n"; $bad = 1 }
  exit $bad;
' "$@"
}

FALLBACK="scripts/lib/sqlite3-fallback.sh"
TOOLS="mcp/trajectory-server/src/tools"

run_self_test() {
  local dir fail=0
  dir=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-fallback-roles.XXXXXX") || return 1
  mkdir -p "$dir/tools"
  cat >"$dir/tools/x.ts" <<'TS'
requireRoles('audit_append', ['bro', 'swe', 'pr-reviewer', 'consultant'], agent);
requireRoles(
  'issue_close',
  ['bro'],
  agent,
);
TS
  printf "%s\n" "_TMB_FALLBACK_ROLES_audit_append='bro,swe,pr-reviewer,consultant'" "_TMB_FALLBACK_ROLES_issue_close='bro'" >"$dir/ok.sh"
  printf "%s\n" "_TMB_FALLBACK_ROLES_audit_append='bro,swe,pr-reviewer'" "_TMB_FALLBACK_ROLES_issue_close='bro'" >"$dir/drift.sh"
  printf "%s\n" "_TMB_FALLBACK_ROLES_audit_append='bro,swe,pr-reviewer,consultant'" "_TMB_FALLBACK_ROLES_task_retry='bro'" >"$dir/extra.sh"
  check "$dir/ok.sh" "$dir/tools" >/dev/null || { echo "sqlite3-fallback-roles self-test: a matching table was flagged" >&2; fail=1; }
  check "$dir/drift.sh" "$dir/tools" >/dev/null && { echo "sqlite3-fallback-roles self-test: a dropped consultant role was not flagged" >&2; fail=1; }
  check "$dir/extra.sh" "$dir/tools" >/dev/null && { echo "sqlite3-fallback-roles self-test: a tool the server does not gate was not flagged" >&2; fail=1; }
  rm -rf "$dir"
  return "$fail"
}

run_self_test || exit 1

if ! OUT=$(check "$FALLBACK" "$TOOLS"); then
  printf 'Sqlite3-fallback-roles: FAIL — the fallback role table drifted from the server requireRoles lists:\n%s\n' "$OUT" >&2
  printf '  Update the _TMB_FALLBACK_ROLES_<tool> line in %s to the server list, in the same order.\n' "$FALLBACK" >&2
  exit 1
fi
printf 'Sqlite3-fallback-roles: PASS (%s tools match the server)\n' "$(grep -c '^_TMB_FALLBACK_ROLES_' "$FALLBACK")"
