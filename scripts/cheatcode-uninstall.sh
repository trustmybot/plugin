#!/usr/bin/env bash
# cheatcode-uninstall.sh — deterministic cheatcode uninstall via the marketplace path.
#
# Reverses ONE installed cheatcode (skill, MCP/toolkit, plugin) and reports what
# was torn down so the caller can delete the install + attachment rows from the
# trajectory DB. The uninstall is the marketplace/plugin uninstall path ONLY — no
# manual file deletion (docs/architecture/CHEATCODES.md §Teardown #676). The
# candidate identity is its source_url; the kind decides the teardown surface and
# mirrors cheatcode-install.sh exactly:
#
#   plugin → marketplace uninstall removes its skills/hooks/commands via the
#            plugin manifest. method 'marketplace'.
#   mcp    → deregister the server (config). method 'mcp-deregister'.
#   skill  → a standalone skill's attachment is a proposed-PR record only; nothing
#            was ever written to agent md, so there is nothing to reverse at the
#            marketplace. method 'skill-proposed-pr-revert', removed=false.
#
# The marketplace call is abstracted behind TMB_CHEATCODE_UNINSTALL_FIXTURE: when
# that env var points at a JSON file, the uninstall result is read from it (the
# test hook — no network). Otherwise the marketplace adapter below runs. Either
# way the output shape is identical, so tests exercise the real assembly path on
# stubbed input.
#
# The marketplace adapter is best-effort: a short timeout, and on any failure
# (network denied, missing CLI, non-zero exit) the uninstall degrades to
# removed=false with an error note — it never crashes. Idempotency lives in the
# caller: this script reverses whatever it is asked to reverse and reports the
# result; a no-op teardown is still a clean (removed=false) result, never a crash.
#
# Fixture shape (object; every field optional):
#   { "removed": true, "error": null }
#
# Input (one candidate per call):
#   --candidate '<json>'   a candidate object {name,kind,source_url,tier?}
#   or the discrete flags:
#   --source-url <url>  --kind <skill|mcp|plugin>  [--name <n>]  [--tier <1|2>]
#
# Output shape on stdout:
#   {
#     "candidate":  { "name", "kind", "source_url", "tier" },
#     "removed":    true|false,
#     "method":     "marketplace|mcp-deregister|skill-proposed-pr-revert",
#     "error":      "<note or null>"
#   }

set -uo pipefail

CANDIDATE_JSON=""
SOURCE_URL=""
KIND=""
TIER=""
NAME=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate)  CANDIDATE_JSON="${2:-}"; shift 2 ;;
    --source-url) SOURCE_URL="${2:-}"; shift 2 ;;
    --kind)       KIND="${2:-}"; shift 2 ;;
    --tier)       TIER="${2:-}"; shift 2 ;;
    --name)       NAME="${2:-}"; shift 2 ;;
    *) echo "{\"error\":\"unknown arg: $1\"}" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo '{"error":"jq missing"}' >&2; exit 1; }

# Normalize the candidate into a single JSON object regardless of input form.
# --candidate wins; the discrete flags fill in otherwise.
if [ -n "$CANDIDATE_JSON" ]; then
  if ! printf '%s' "$CANDIDATE_JSON" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo '{"error":"--candidate is not a JSON object"}' >&2
    exit 1
  fi
  candidate=$(printf '%s' "$CANDIDATE_JSON" | jq -c '{
    name:       (.name // ""),
    kind:       (.kind // ""),
    source_url: (.source_url // ""),
    tier:       (if (.tier | type) == "number" then .tier else null end)
  }')
else
  [ -n "$SOURCE_URL" ] || { echo '{"error":"--source-url or --candidate is required"}' >&2; exit 1; }
  candidate=$(jq -c -n \
    --arg name "$NAME" \
    --arg kind "$KIND" \
    --arg url "$SOURCE_URL" \
    --arg tier "$TIER" \
    '{
      name: $name,
      kind: $kind,
      source_url: $url,
      tier: (if ($tier | length) > 0 then ($tier | tonumber) else null end)
    }')
fi

cand_kind=$(printf '%s' "$candidate" | jq -r '.kind')
src_url=$(printf '%s' "$candidate" | jq -r '.source_url')

[ -n "$src_url" ] || { echo '{"error":"candidate.source_url is required"}' >&2; exit 1; }
case "$cand_kind" in
  skill|mcp|plugin) : ;;
  *) echo "{\"error\":\"candidate.kind must be skill|mcp|plugin (got '${cand_kind}')\"}" >&2; exit 1 ;;
esac

UNINSTALL_TIMEOUT=30

# Marketplace uninstall adapter (plugin/MCP kinds). Best-effort: prints a JSON
# object {removed, error}. On any failure it degrades to removed=false with an
# error note and never crashes. The marketplace/plugin uninstall path is the
# ONLY teardown surface — no manual file deletion.
marketplace_uninstall() {
  # No marketplace CLI available → degrade soft. Live marketplace wiring is
  # gated behind the fixture in every tested path; an environment without the
  # CLI reports a clean not-removed result rather than failing the script.
  if ! command -v claude >/dev/null 2>&1; then
    jq -nc '{removed: false, error: "marketplace CLI unavailable"}'
    return
  fi
  local rc
  timeout "$UNINSTALL_TIMEOUT" claude plugin uninstall "$src_url" >/dev/null 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then
    jq -nc --arg e "marketplace uninstall failed (exit $rc)" \
      '{removed: false, error: $e}'
    return
  fi
  jq -nc '{removed: true, error: null}'
}

# Acquire the uninstall result. Fixture path (test hook) takes precedence over
# any live marketplace call so CI never touches the network.
uninstall_result='{"removed":false,"error":null}'
if [ -n "${TMB_CHEATCODE_UNINSTALL_FIXTURE:-}" ]; then
  [ -f "$TMB_CHEATCODE_UNINSTALL_FIXTURE" ] || {
    echo "{\"error\":\"fixture not found: $TMB_CHEATCODE_UNINSTALL_FIXTURE\"}" >&2
    exit 1
  }
  fixture=$(cat "$TMB_CHEATCODE_UNINSTALL_FIXTURE")
  if ! printf '%s' "$fixture" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo '{"error":"fixture is not a JSON object"}' >&2
    exit 1
  fi
  uninstall_result=$(printf '%s' "$fixture" | jq -c '{
    removed: (.removed // false),
    error:   (.error // null)
  }')
elif [ "$cand_kind" = "plugin" ] || [ "$cand_kind" = "mcp" ]; then
  uninstall_result=$(marketplace_uninstall)
fi
# skill kind with no fixture: the attachment was a proposed-PR record only, never
# an automatic write, so there is nothing to reverse at the marketplace; the
# uninstall_result stays the not-removed default.

# Assemble the kind-dependent method, then the final payload. Pure jq from
# (candidate, uninstall_result) — deterministic, reproducible.
printf '%s' "$uninstall_result" \
| jq -c \
    --argjson candidate "$candidate" \
    --arg kind "$cand_kind" \
'
  . as $ur
  | (if $kind == "plugin" then "marketplace"
     elif $kind == "mcp"  then "mcp-deregister"
     else "skill-proposed-pr-revert" end) as $method
  | {
      candidate: $candidate,
      removed:   ($ur.removed // false),
      method:    $method,
      error:     ($ur.error // null)
    }
'
