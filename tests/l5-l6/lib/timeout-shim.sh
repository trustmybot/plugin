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
      use POSIX ":sys_wait_h";
      my $secs = shift @ARGV;
      my $pid = fork();
      if (!defined $pid) { exit 1; }
      if ($pid == 0) { exec @ARGV; exit 1; }
      local $SIG{ALRM} = sub { kill 9, $pid; waitpid($pid, 0); exit 124 };
      alarm $secs;
      waitpid($pid, 0);
      alarm 0;
      my $status = $?;
      exit(($status >> 8) & 0xff);
    ' "$secs" "$@"
  fi
}
