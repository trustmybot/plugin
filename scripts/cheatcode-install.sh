#!/usr/bin/env bash
# cheatcode-install.sh — deterministic cheatcode install via the marketplace path.
#
# Installs ONE approved cheatcode (skill, MCP/toolkit, plugin) and reports what
# was wired so the caller can record the install + attachment in the trajectory
# DB. The install is the marketplace-install path ONLY — no seed/copy/--plugin-dir
# (the benchmarks standing rule). The candidate identity is its source_url; the
# kind decides the attachment surface (docs/architecture/CHEATCODES.md #677):
#
#   plugin → marketplace install loads its skills/hooks/commands via the plugin
#            manifest. attachment target 'plugin', no prompt-surface edit.
#   mcp    → register the server (config). attachment target 'mcp', no
#            prompt-surface edit.
#   skill  → a standalone skill must be added to a consuming agent's `skills:`
#            frontmatter. That is a Human-reviewed prompt-surface change, so this
#            script NEVER writes agent md — it emits a PROPOSED-PR payload that
#            the caller surfaces for review.
#
# The marketplace call is abstracted behind TMB_CHEATCODE_INSTALL_FIXTURE: when
# that env var points at a JSON file, the install result is read from it (the
# test hook — no network). Otherwise the marketplace adapter below runs. Either
# way the output shape is identical, so tests exercise the real assembly path on
# stubbed input.
#
# The marketplace adapter is best-effort: a short timeout, and on any failure
# (network denied, missing CLI, non-zero exit) the install degrades to
# installed=false with an error note — it never crashes.
#
# Fixture shape — two forms, auto-detected by the candidate name:
#   FLAT (one install): { "installed": true, "version": "1.2.3", "error": null,
#     "attachments": [ { "target": "swe", "artifact": "..." } ] }
#   PER-CANDIDATE (one file routes many installs): keyed by candidate name →
#     { "feature-dev": { "installed": true, "attachments":[{target:"swe",...}] },
#       "code-review": { "installed": true, "attachments":[{target:"pr-reviewer",...}] } }
# When the top level has a key matching the install candidate's name, that entry
# is used; otherwise the whole object is read as the FLAT shape (backward-compatible).
# When the chosen entry supplies attachments[], they are passed through verbatim
# (the per-agent attachment target — feature-dev→swe, code-review→pr-reviewer);
# otherwise the kind-derived default attachment is used.
#
# Input (one candidate per call):
#   --candidate '<json>'   a candidate object {name,kind,source_url,tier?}
#   or the discrete flags:
#   --source-url <url>  --kind <skill|mcp|plugin>  [--name <n>]  [--tier <1|2>]
#   --scope <local|global>  install scope (default local) — echoed in the output
#       and persisted on the cheatcodes row by the caller.
#
# Output shape on stdout:
#   {
#     "candidate":  { "name", "kind", "source_url", "tier" },
#     "installed":  true|false,
#     "version":    "<version or null>",
#     "scope":      "local|global",
#     "method":     "marketplace|mcp-register|skill-proposed-pr",
#     "attachments":[ { "target", "artifact" }, ... ],
#     "proposed_pr":{ ... } | null,
#     "error":      "<note or null>"
#   }

set -uo pipefail

CANDIDATE_JSON=""
SOURCE_URL=""
KIND=""
TIER=""
NAME=""
SCOPE="local"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate)  CANDIDATE_JSON="${2:-}"; shift 2 ;;
    --source-url) SOURCE_URL="${2:-}"; shift 2 ;;
    --kind)       KIND="${2:-}"; shift 2 ;;
    --tier)       TIER="${2:-}"; shift 2 ;;
    --name)       NAME="${2:-}"; shift 2 ;;
    --scope)      SCOPE="${2:-}"; shift 2 ;;
    *) echo "{\"error\":\"unknown arg: $1\"}" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo '{"error":"jq missing"}' >&2; exit 1; }

case "$SCOPE" in
  local|global) : ;;
  *) echo "{\"error\":\"--scope must be local|global (got '${SCOPE}')\"}" >&2; exit 1 ;;
esac

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

cand_name=$(printf '%s' "$candidate" | jq -r '.name')
cand_kind=$(printf '%s' "$candidate" | jq -r '.kind')
src_url=$(printf '%s' "$candidate" | jq -r '.source_url')

[ -n "$src_url" ] || { echo '{"error":"candidate.source_url is required"}' >&2; exit 1; }
case "$cand_kind" in
  skill|mcp|plugin) : ;;
  *) echo "{\"error\":\"candidate.kind must be skill|mcp|plugin (got '${cand_kind}')\"}" >&2; exit 1 ;;
esac

INSTALL_TIMEOUT=30

# Marketplace install adapter (plugin/MCP kinds). Best-effort: prints a JSON
# object {installed, version, error}. On any failure it degrades to
# installed=false with an error note and never crashes. The marketplace-install
# path is the ONLY install surface — no seeding / --plugin-dir.
marketplace_install() {
  # No marketplace CLI available → degrade soft. Live marketplace wiring is
  # gated behind the fixture in every tested path; an environment without the
  # CLI reports a clean not-installed result rather than failing the script.
  if ! command -v claude >/dev/null 2>&1; then
    jq -nc '{installed: false, version: null, error: "marketplace CLI unavailable"}'
    return
  fi
  local out rc
  out=$(timeout "$INSTALL_TIMEOUT" claude plugin install "$src_url" 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ]; then
    jq -nc --arg e "marketplace install failed (exit $rc)" \
      '{installed: false, version: null, error: $e}'
    return
  fi
  # Best-effort version parse from the CLI output; null when not surfaced.
  local ver
  ver=$(printf '%s' "$out" | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  jq -nc --arg v "$ver" '{installed: true, version: (if ($v | length) > 0 then $v else null end), error: null}'
}

# Acquire the install result. Fixture path (test hook) takes precedence over any
# live marketplace call so CI never touches the network.
install_result='{"installed":false,"version":null,"error":null}'
if [ -n "${TMB_CHEATCODE_INSTALL_FIXTURE:-}" ]; then
  [ -f "$TMB_CHEATCODE_INSTALL_FIXTURE" ] || {
    echo "{\"error\":\"fixture not found: $TMB_CHEATCODE_INSTALL_FIXTURE\"}" >&2
    exit 1
  }
  fixture=$(cat "$TMB_CHEATCODE_INSTALL_FIXTURE")
  if ! printf '%s' "$fixture" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo '{"error":"fixture is not a JSON object"}' >&2
    exit 1
  fi
  # Per-candidate keyed shape: a top-level key matching this candidate's name
  # whose value is an object selects that entry. Otherwise read the whole object
  # as the FLAT shape (backward-compatible). The selected entry is normalized
  # identically either way.
  entry="$fixture"
  if [ -n "$cand_name" ] \
     && printf '%s' "$fixture" | jq -e --arg n "$cand_name" '(.[$n] | type) == "object"' >/dev/null 2>&1; then
    entry=$(printf '%s' "$fixture" | jq -c --arg n "$cand_name" '.[$n]')
  fi
  install_result=$(printf '%s' "$entry" | jq -c '{
    installed:   (.installed // false),
    version:     (.version // null),
    error:       (.error // null),
    attachments: (if (.attachments | type) == "array" then .attachments else null end)
  }')
elif [ "$cand_kind" = "plugin" ] || [ "$cand_kind" = "mcp" ]; then
  install_result=$(marketplace_install)
fi
# skill kind with no fixture: nothing is installed at the marketplace; the
# attachment is the proposed-PR payload only, so install_result stays the
# not-installed default.

# Assemble the kind-dependent attachment + method, then the final payload.
# Pure jq from (candidate, install_result) — deterministic, reproducible.
printf '%s' "$install_result" \
| jq -c \
    --argjson candidate "$candidate" \
    --arg kind "$cand_kind" \
    --arg name "$cand_name" \
    --arg url "$src_url" \
    --arg scope "$SCOPE" \
'
  . as $ir
  | (if $kind == "plugin" then "marketplace"
     elif $kind == "mcp"  then "mcp-register"
     else "skill-proposed-pr" end) as $method
  # Fixture-supplied attachments[] pass through verbatim — that is the per-agent
  # attachment target (feature-dev→swe, code-review→pr-reviewer). Otherwise the
  # kind-derived default attachment is used.
  | (if ($ir.attachments | type) == "array" then $ir.attachments
     elif $kind == "plugin" then
        [ { target: "plugin", artifact: ("marketplace-plugin:" + $url) } ]
     elif $kind == "mcp" then
        [ { target: "mcp", artifact: ("mcp-server:" + $url) } ]
     else
        # A standalone skill attaches to a consuming agent via its skills:
        # frontmatter — a Human-reviewed prompt-surface edit. The artifact
        # records the PROPOSED edit; nothing is written here.
        [ { target: "proposed-pr", artifact: ("agent-frontmatter-skill:" + $name) } ]
     end) as $attachments
  | (if $kind == "skill" then
        {
          kind: "agent-frontmatter",
          summary: ("Add skill \($name) to a consuming agent skills: frontmatter"),
          source_url: $url,
          note: "Prompt-surface change — open as a Human-reviewed PR, never an automatic write."
        }
     else null end) as $proposed_pr
  | {
      candidate:   $candidate,
      installed:   ($ir.installed // false),
      version:     ($ir.version // null),
      scope:       $scope,
      method:      $method,
      attachments: $attachments,
      proposed_pr: $proposed_pr,
      error:       ($ir.error // null)
    }
'
