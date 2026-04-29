#!/usr/bin/env bash
# Wraps `glab mr merge ...` with retry-on-405. GitLab returns 405 ~40% of
# the time when the MR's mergeable-state is still `unchecked` (async post-
# push computation). Retry within seconds always succeeds.
#
# Usage: glab-retry-merge.sh <all-glab-mr-merge-args>
#   e.g. scripts/lib/glab-retry-merge.sh 23 --yes --remove-source-branch
set -uo pipefail

MAX_ATTEMPTS=3
BACKOFFS=(2 5 10)  # seconds between attempts

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  printf 'glab-retry-merge: attempt %d/%d\n' "$attempt" "$MAX_ATTEMPTS" >&2
  output=$(glab mr merge "$@" 2>&1)
  rc=$?
  if [ $rc -eq 0 ]; then
    echo "$output"
    printf 'glab-retry-merge: succeeded on attempt %d\n' "$attempt" >&2
    exit 0
  fi
  echo "$output"
  if echo "$output" | grep -q '405 Method Not Allowed'; then
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      backoff="${BACKOFFS[$((attempt-1))]}"
      printf 'glab-retry-merge: 405 received, sleeping %ds before retry...\n' "$backoff" >&2
      sleep "$backoff"
    fi
  else
    printf 'glab-retry-merge: non-405 failure, exiting\n' >&2
    exit "$rc"
  fi
  attempt=$((attempt+1))
done

printf 'glab-retry-merge: exhausted %d attempts\n' "$MAX_ATTEMPTS" >&2
exit 1
