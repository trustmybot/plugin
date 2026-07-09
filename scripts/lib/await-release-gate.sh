#!/usr/bin/env bash
# scripts/lib/await-release-gate.sh — await the tag-triggered release-gate verdict.
#
# Sourced (not exec'd) by scripts/publish-rc-channel.sh and scripts/release.sh.
# Pushing a vX.Y.Z[-rc.N] tag auto-fires .github/workflows/release-gate.yml, but
# nothing downstream used to consult that run — an rc was published and its
# cut-issue closed minutes before the tag gate went red into an empty room. These
# publish/release choke points now refuse to make a build public until the tag's
# gate has concluded `success`.
#
# Provides:
#   resolve_gate_tag <tag>
#     Map a tag to the tag whose release-gate run carries its verdict. The gate
#     fires only on rc tags (#630), so an rc tag resolves to itself. A stable tag
#     resolves to the newest v*-rc.* tag merged into HEAD — after a dev → main
#     promotion the promoted rc is always an ancestor, and it is functionally
#     identical to the stable cut, so its concluded run is the stable tag's
#     verdict. Returns:
#       0  — echoes the resolved rc tag on stdout
#       2  — stable tag with no rc tag in HEAD's ancestry (verdict unresolvable)
#   await_release_gate <tag> [timeout_seconds]
#     Resolve the release-gate run whose headBranch == <tag> (tag-triggered runs
#     report the tag name as the branch, so a dev workflow_dispatch run is never
#     matched), poll every 30s while it is queued/in_progress, and return:
#       0  — run concluded success (the ONLY publishing state)
#       2  — no run found for the tag
#       3  — run concluded non-success (red gate — do NOT publish)
#       4  — timed out while still queued/in_progress (inconclusive, not green)
#       1  — usage error / missing dependency (gh, jq)
#     Timeout precedence: <timeout_seconds> arg, else env TMB_GATE_TIMEOUT, else
#     1800s. Prints what it is waiting on, with the run URL.

resolve_gate_tag() {
  local tag="${1:-}"

  if [ -z "$tag" ]; then
    printf "❌ resolve_gate_tag: missing <tag> argument.\n" >&2
    return 1
  fi

  case "$tag" in
    *-rc.*)
      printf '%s\n' "$tag"
      return 0
      ;;
  esac

  local rc_tag
  rc_tag="$(git tag --list 'v*-rc.*' --merged HEAD --sort=-creatordate | head -1)"

  if [ -z "$rc_tag" ]; then
    printf "❌ resolve_gate_tag: no v*-rc.* tag in HEAD's ancestry for stable tag %s.\n" "$tag" >&2
    printf "   The release gate fires only on rc tags (#630), so a stable cut's\n" >&2
    printf "   functional-identity verdict is the promoted rc's run — but none is an\n" >&2
    printf "   ancestor of HEAD. Promote a green rc into main before cutting %s.\n" "$tag" >&2
    return 2
  fi

  printf '%s\n' "$rc_tag"
  return 0
}

await_release_gate() {
  local tag="${1:-}"
  local timeout="${2:-${TMB_GATE_TIMEOUT:-1800}}"
  local repo="trustmybot/plugin"
  local poll_interval=30
  local waited=0
  local run_json status conclusion run_url

  if [ -z "$tag" ]; then
    printf "❌ await_release_gate: missing <tag> argument.\n" >&2
    return 1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    printf "❌ await_release_gate: gh CLI is required to read the release-gate run.\n" >&2
    return 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    printf "❌ await_release_gate: jq is required to parse the release-gate run.\n" >&2
    return 1
  fi

  while :; do
    run_json="$(gh run list \
      --repo "$repo" \
      --workflow=release-gate \
      --branch "$tag" \
      --json databaseId,status,conclusion,url \
      --limit 1 2>/dev/null || true)"

    if [ -z "$run_json" ] || [ "$run_json" = "[]" ]; then
      printf "❌ No release-gate run found for tag %s.\n" "$tag" >&2
      printf "   Tag runs auto-fire on push — wait for GitHub to register it, or\n" >&2
      printf "   confirm the tag was pushed: git ls-remote --tags origin refs/tags/%s\n" "$tag" >&2
      return 2
    fi

    status="$(printf '%s' "$run_json" | jq -r '.[0].status // empty')"
    conclusion="$(printf '%s' "$run_json" | jq -r '.[0].conclusion // empty')"
    run_url="$(printf '%s' "$run_json" | jq -r '.[0].url // empty')"

    case "$status" in
      completed)
        if [ "$conclusion" = "success" ]; then
          printf "✓ release-gate for %s concluded success.\n" "$tag"
          printf "  Run: %s\n" "$run_url"
          return 0
        fi
        printf "❌ release-gate for %s concluded %s — refusing to publish.\n" "$tag" "${conclusion:-unknown}" >&2
        printf "   Run: %s\n" "$run_url" >&2
        printf "   A red tag gate means: roll back the channel/tag and ship a new rc\n" >&2
        printf "   (never publish over a failing gate). Investigate the run above.\n" >&2
        return 3
        ;;
      queued|in_progress|waiting|requested|pending)
        if [ "$waited" -ge "$timeout" ]; then
          printf "❌ release-gate for %s still %s after %ss — timed out.\n" "$tag" "$status" "$timeout" >&2
          printf "   Run: %s\n" "$run_url" >&2
          printf "   Inconclusive is not green — do NOT publish. Re-run this check once\n" >&2
          printf "   the run concludes (raise the budget with TMB_GATE_TIMEOUT=<seconds>).\n" >&2
          return 4
        fi
        printf "… waiting on release-gate for %s (status=%s, %ss/%ss)\n" "$tag" "$status" "$waited" "$timeout"
        printf "  Run: %s\n" "$run_url"
        sleep "$poll_interval"
        waited=$((waited + poll_interval))
        ;;
      *)
        if [ "$waited" -ge "$timeout" ]; then
          printf "❌ release-gate for %s: unexpected status '%s' after %ss — timed out.\n" "$tag" "${status:-empty}" "$timeout" >&2
          printf "   Run: %s\n" "$run_url" >&2
          printf "   Inconclusive is not green — do NOT publish. Re-run this check.\n" >&2
          return 4
        fi
        printf "… release-gate for %s reported status '%s'; re-checking (%ss/%ss)\n" "$tag" "${status:-empty}" "$waited" "$timeout"
        sleep "$poll_interval"
        waited=$((waited + poll_interval))
        ;;
    esac
  done
}
