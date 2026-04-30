#!/usr/bin/env bash
# macOS-portable timeout: prefer real `timeout`, fall back to `gtimeout` (brew
# coreutils), else `perl alarm()` as last-resort. Exit 124 on timeout (matches
# GNU timeout's convention); otherwise the wrapped command's actual exit code.
# Source me, don't execute me.

_l5_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    perl -e '
      use strict; use warnings;
      my $secs = shift @ARGV;
      eval {
        local $SIG{ALRM} = sub { kill 9, $$; exit 124 };
        alarm $secs;
        exec @ARGV;
      };
      exit 124;
    ' "$secs" "$@"
  fi
}
