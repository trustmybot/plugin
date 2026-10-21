#!/usr/bin/env bash
# cheatcode-vet.sh — deterministic trust-signal gathering for ONE cheatcode.
#
# Gathers reputation + security-surface signals for a single candidate cheatcode
# (skill, MCP/toolkit, plugin) and emits a DETERMINISTIC trust tier classification
# from the signal set alone — reproducible from (candidate, signals) with no LLM,
# no randomness. The tier is a CLASSIFICATION, NOT an install verdict: the
# "trustworthy enough to install?" decision stays bro + Human (#659).
#
# Signals (all best-effort; any failure degrades that signal to empty/null):
#   reputation     — registry tier (from candidate) + GitHub stars/forks
#   maintenance    — pushed_at recency + archived flag
#   license        — SPDX id (or null)
#   maintainer     — repo owner login + type (User|Organization)
#   security_surface — capability flags derived from kind + the assessed surface:
#                        code_execution (ships hooks / scripts / executables /
#                          bin/ files / .lsp.json / monitors/monitors.json /
#                          settings.json / MCP server definitions, a
#                          .claude-plugin manifest declaring hooks, mcpServers,
#                          lspServers, monitors, settings or subagentStatusLine,
#                          or kind=mcp),
#                        network (kind=mcp, MCP server definitions, or a
#                          manifest declaring mcpServers),
#                        fs_writes (ships locally-run code: hooks / scripts /
#                          executables / bin/ files / script files / LSP,
#                          monitor and settings.json definitions)
#
# The repo is identified from the candidate's source_url (a github.com URL).
# Reputation signals (stars, owner, maintenance, license) are repo-level. The
# security surface is the chosen folder: a .../tree/<ref>/<path> URL is assessed
# from the files under <path> at <ref> (git/trees/<ref>?recursive=1 filtered to
# the <path>/ prefix; on a truncated tree, the folder's contents/<path> listing).
# A URL with no /tree/ part assesses the repo root's top-level entries.
# A contents/ listing is one level deep: when it holds a subfolder, the surface
# is partial. So is any surface holding content the listing does not show: a
# git/trees entry of type commit or mode 160000 (submodule) or 120000 (symlink),
# a contents/ entry that is neither file nor dir, or a file with a null
# download_url (how contents/ reports a submodule). Every .claude-plugin/plugin.json
# or .claude-plugin/marketplace.json listed in the surface (matched in any case),
# at any depth, is fetched at its listed path (up to MAX_MANIFESTS; more makes
# the surface partial) and read for hooks, mcpServers, lspServers, monitors,
# experimental.monitors, settings and subagentStatusLine keys. A manifest that
# cannot be read, or whose path holds a character outside [A-Za-z0-9._/-], makes
# the surface partial, and so does a non-empty dependencies list in a manifest or
# marketplace plugins[] entry, or a plugins[] entry whose source is not "." or a
# "./" path inside the folder (a github/url/git-subdir/npm object, a URL string,
# or a path holding "..").
# A partial surface forces caution unless code was already found.
# Signals come from the GitHub REST API, best-effort behind a short curl timeout.
# On any failure (network denied, non-200, bad JSON, non-github URL) the affected
# signal degrades to empty/null and never crashes the script. A surface that was
# never listed (fetch failed, 404, rate limit, a ref or path that does not
# resolve, an empty listing) is never scored as empty: it forces caution, so
# nothing unseen is trusted.
#
# The candidate source + GitHub responses are abstracted behind
# TMB_CHEATCODE_VET_FIXTURE: when that env var points at a JSON file, the signal
# inputs are read from it (the test hook — no network). The classification path
# is identical to production, so tests exercise the real tier rules on stubbed
# input.
#
# Fixture shape (object; every field optional):
#   {
#     "repo":     { "stargazers_count", "forks_count", "pushed_at",
#                   "archived", "license": {"spdx_id"},
#                   "owner": {"login","type"} },
#     "contents": [ "hooks", "scripts", ... ],    # entries of the assessed surface
#     "tree":     [ {"path","type","mode"}, ... ], # recursive repo listing, used in
#                                                 # place of contents when the
#                                                 # source_url names a /tree/ path
#     "manifests": { "plugins/x/.claude-plugin/plugin.json": {...} }
#                                                 # manifest bodies, keyed by full
#                                                 # path relative to the surface
#                                                 # (or relative to the repo root)
#   }
# A string entry in "contents" is a bare path: it cannot mark a directory, so a
# string fixture never makes the surface partial for nesting. Use objects shaped
# like the contents/ API ({"name","type","download_url"}) for that; their name
# maps to path as on the live path.
# With neither array present (or a /tree/ path matching no tree entry) the
# surface counts as not listed, as on the live path.
#
# Input (one candidate per call):
#   --candidate '<json>'   a candidate object {name,kind,source_url,tier?}
#   or the discrete flags:
#   --source-url <url>  --kind <skill|mcp|plugin>  [--tier <1|2>]  [--name <n>]
#
# Output shape on stdout:
#   {
#     "candidate":  { "name", "kind", "source_url", "tier" },
#     "signals": {
#       "reputation":  { "registry_tier", "stars", "forks" },
#       "maintenance": { "pushed_at", "archived", "active" },
#       "license":     "<spdx-id or null>",
#       "maintainer":  { "login", "type" },
#       "security_surface": { "code_execution", "network", "fs_writes" }
#     },
#     "trust_tier":   "trusted|caution|untrusted|unknown",
#     "rationale":    "<one line>",
#     "capabilities": [ "code_execution", "network", "fs_writes" ]
#   }
#
# Trust tier (DETERMINISTIC classification from the signal set):
#   unknown   — no reputation signal at all: no registry tier AND no GitHub repo
#               data (offline / web-denied / non-github url). Honesty over guess.
#   untrusted — archived repo, OR registry tier present but > 2 (unrecognized),
#               OR stale: not pushed in > 730 days.
#   caution   — DEFAULT once any signal exists. Also forced whenever the
#               security_surface flags code_execution (a code-executing
#               cheatcode is NEVER trusted on popularity alone) or the surface
#               could not be listed or was only partly inspected (never
#               trusted unseen).
#   trusted   — official registry (tier 1) OR a well-maintained popular repo
#               (>= 500 stars, pushed within 365 days, not archived), AND the
#               surface was fully inspected and does NOT flag code_execution.
#
# capabilities[] lists every security_surface flag that is true.

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
[ -n "${TMB_PROJECT_ROOT:-}" ] || { echo '{"error":"TMB_PROJECT_ROOT is unset — the trajectory server sets it to the project root"}' >&2; exit 1; }

# Normalize the candidate into a single JSON object regardless of which input
# form was used. --candidate wins; the discrete flags fill in otherwise.
if [ -n "$CANDIDATE_JSON" ]; then
  if ! printf '%s' "$CANDIDATE_JSON" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo '{"error":"--candidate is not a JSON object"}' >&2
    exit 1
  fi
  candidate=$(printf '%s' "$CANDIDATE_JSON" | jq -c '{
    name:       (.name // ""),
    kind:       (.kind // "any"),
    source_url: (.source_url // ""),
    tier:       (if (.tier | type) == "number" then .tier else null end)
  }')
else
  [ -n "$SOURCE_URL" ] || { echo '{"error":"--source-url or --candidate is required"}' >&2; exit 1; }
  candidate=$(jq -c -n \
    --arg name "$NAME" \
    --arg kind "${KIND:-any}" \
    --arg url "$SOURCE_URL" \
    --arg tier "$TIER" \
    '{
      name: $name,
      kind: $kind,
      source_url: $url,
      tier: (if ($tier | length) > 0 then ($tier | tonumber) else null end)
    }')
fi

src_url=$(printf '%s' "$candidate" | jq -r '.source_url')
cand_kind=$(printf '%s' "$candidate" | jq -r '.kind')

CURL_TIMEOUT=8

# fetch URL → body on stdout, or empty string on any failure. Never errors.
fetch() {
  curl -fsSL --max-time "$CURL_TIMEOUT" \
    -H "Accept: application/vnd.github+json" \
    "$1" 2>/dev/null || true
}

# Derive owner/repo from a github.com source_url (or empty on no match).
owner_repo() {
  printf '%s' "$1" \
    | sed -nE 's#^https?://github\.com/([^/]+)/([^/.]+)(\.git)?/?.*$#\1/\2#p'
}

# "<ref><TAB><path>" from a github.com .../tree/<ref>/<path> source_url (path may
# be empty); nothing when the URL has no /tree/ part.
tree_ref_path() {
  printf '%s' "$1" \
    | sed -E 's/[?#].*$//' \
    | sed -nE 's#^https?://github\.com/[^/]+/[^/]+/tree/([^/]+)/?(.*)$#\1	\2#p' \
    | sed -E 's#/+$##'
}

# Entries of a git/trees listing at or under $p, with paths relative to $p.
FILTER_TREE='[ .[]? | select(type == "object" and (.path | type) == "string")
  | select(.path == $p or (.path | startswith($p + "/")))
  | { path: (if .path == $p then (.path | split("/") | last) else .path[($p | length) + 1:] end),
      type: (.type // null), mode: (.mode // null) } ]'

# A contents/ listing: a non-empty array. One holding a dir entry is partial.
IS_CONTENTS='type == "array" and length > 0'
HAS_DIR='any(.[]; type == "object" and .type == "dir")'
# Entries whose content the listing does not show: submodules and symlinks.
TREE_OPAQUE='any(.[]; .type == "commit" or .mode == "160000" or .mode == "120000")'
CONTENTS_OPAQUE='any(.[]; type == "object"
  and ((.type != "file" and .type != "dir") or (.type == "file" and .download_url == null)))'
# A contents/ listing as surface entries: an object's name is its path.
CONTENTS_ENTRIES='[ .[] | if type == "object"
  then { path: (.name // .path), type: (if .type == "dir" then "tree" else "blob" end), mode: null }
  else . end ]'
# Plugin manifests listed in the surface at any depth (string or object entries).
MANIFESTS='[ .[]? | (if type == "string" then . elif type == "object" then .path else empty end)
  | strings
  | select(test("(^|/)\\.claude-plugin/(plugin|marketplace)\\.json$"; "i")) ]
  | unique | .[]'
# "<code> <network> <external source> <source outside the folder> <dependencies>"
# for a manifest. A marketplace source of "." is the marketplace root itself.
MANIFEST_FLAGS='[ any(.. | objects; has("hooks") or has("mcpServers") or has("lspServers") or has("monitors")
      or has("settings") or has("subagentStatusLine")),
  any(.. | objects; has("mcpServers")),
  any(.plugins[]? | objects; (.source | type) != "string" or (.source != "." and (.source | startswith("./") | not))),
  any(.plugins[]? | objects | .source | strings | select(startswith("./")); split("/") | any(. == "..")),
  any(., (.plugins[]? | objects); (.dependencies | type) as $t
      | ($t == "array" or $t == "object" or $t == "string") and (.dependencies | length) > 0) ]
  | map(tostring) | join(" ")'
MAX_MANIFESTS=20

WHY_NESTED="nested folders not inspected"
WHY_OPAQUE="submodule or symlink not inspected"
WHY_MANIFEST="plugin manifest could not be read"
WHY_MANY_MANIFESTS="more than $MAX_MANIFESTS plugin manifests, the rest not inspected"
WHY_EXTERNAL="external plugin source not inspected"
WHY_OUTSIDE="plugin source outside the folder not inspected"
WHY_DEPENDENCIES="external dependencies not inspected"
WHY_UNSAFE_PATH="plugin manifest with an unusual path not inspected"

# Newline-separated reasons the surface is only partly inspected.
partial_why=""
mark_partial() {
  case $'\n'"$partial_why" in
    *$'\n'"$1"$'\n'*) ;;
    *) partial_why="$partial_why$1"$'\n' ;;
  esac
}

# note_tree <filtered tree json> / note_contents <raw contents json>
note_tree() {
  printf '%s' "$1" | jq -e "$TREE_OPAQUE" >/dev/null 2>&1 && mark_partial "$WHY_OPAQUE"
  return 0
}
note_contents() {
  printf '%s' "$1" | jq -e "$HAS_DIR" >/dev/null 2>&1 && mark_partial "$WHY_NESTED"
  printf '%s' "$1" | jq -e "$CONTENTS_OPAQUE" >/dev/null 2>&1 && mark_partial "$WHY_OPAQUE"
  return 0
}

# Resolve the fixture path. The env var wins when set. When it is unset/empty,
# probe the deterministic default path "$TMB_PROJECT_ROOT/.tmb-cheatcode-vet-fixture.json"
# (the path the row setup-l5.sh stages in the project) and use it if present —
# this lets the L6 chain reach the fixture even though the runner's subshell
# export of the env var never reaches the step's `claude -p`. When neither the
# env nor the default file is present, the live / no-fixture path is unchanged.
VET_FIXTURE_PATH="${TMB_CHEATCODE_VET_FIXTURE:-}"
if [ -z "$VET_FIXTURE_PATH" ] && [ -f "$TMB_PROJECT_ROOT/.tmb-cheatcode-vet-fixture.json" ]; then
  VET_FIXTURE_PATH="$TMB_PROJECT_ROOT/.tmb-cheatcode-vet-fixture.json"
fi

# Acquire signal inputs. Fixture path (test hook) takes precedence over any live
# lookup so CI never touches the network.
repo_json='{}'
surface_json='[]'
listed=0
slug=""
fixture=""
tree_ref=""
tree_path=""
ref_path=$(tree_ref_path "$src_url")
if [ -n "$ref_path" ]; then
  tree_ref="${ref_path%%$'\t'*}"
  tree_path="${ref_path#*$'\t'}"
fi
if [ -n "$VET_FIXTURE_PATH" ]; then
  [ -f "$VET_FIXTURE_PATH" ] || {
    echo "{\"error\":\"fixture not found: $VET_FIXTURE_PATH\"}" >&2
    exit 1
  }
  fixture=$(cat "$VET_FIXTURE_PATH")
  if ! printf '%s' "$fixture" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo '{"error":"fixture is not a JSON object"}' >&2
    exit 1
  fi
  repo_json=$(printf '%s' "$fixture" | jq -c '.repo // {}')
  if [ -n "$tree_path" ] && printf '%s' "$fixture" | jq -e '(.tree | type) == "array"' >/dev/null 2>&1; then
    surface_json=$(printf '%s' "$fixture" | jq -c --arg p "$tree_path" ".tree | $FILTER_TREE")
    [ "$surface_json" = "[]" ] || { listed=1; note_tree "$surface_json"; }
  elif printf '%s' "$fixture" | jq -e ".contents | $IS_CONTENTS" >/dev/null 2>&1; then
    surface_json=$(printf '%s' "$fixture" | jq -c ".contents | $CONTENTS_ENTRIES")
    listed=1
    note_contents "$surface_json"
  fi
else
  slug=$(owner_repo "$src_url")
  if [ -n "$slug" ]; then
    body=$(fetch "https://api.github.com/repos/$slug")
    if printf '%s' "$body" | jq -e 'type == "object"' >/dev/null 2>&1; then
      repo_json="$body"
    fi
    if [ -n "$tree_path" ]; then
      tbody=$(fetch "https://api.github.com/repos/$slug/git/trees/$tree_ref?recursive=1")
      if printf '%s' "$tbody" | jq -e 'type == "object" and (.tree | type) == "array" and (.truncated != true)' >/dev/null 2>&1; then
        surface_json=$(printf '%s' "$tbody" | jq -c --arg p "$tree_path" ".tree | $FILTER_TREE")
        [ "$surface_json" = "[]" ] || { listed=1; note_tree "$surface_json"; }
      fi
      contents_url="https://api.github.com/repos/$slug/contents/$tree_path?ref=$tree_ref"
    elif [ -n "$tree_ref" ]; then
      contents_url="https://api.github.com/repos/$slug/contents?ref=$tree_ref"
    else
      contents_url="https://api.github.com/repos/$slug/contents"
    fi
    if [ "$listed" -eq 0 ]; then
      cbody=$(fetch "$contents_url")
      if printf '%s' "$cbody" | jq -e "$IS_CONTENTS" >/dev/null 2>&1; then
        surface_json=$(printf '%s' "$cbody" | jq -c "$CONTENTS_ENTRIES")
        listed=1
        note_contents "$cbody"
      fi
    fi
  fi
fi

# read_manifest <path relative to the surface> → the manifest JSON object, or
# nothing when it cannot be read.
read_manifest() {
  if [ -n "$VET_FIXTURE_PATH" ]; then
    printf '%s' "$fixture" | jq -c --arg m "$1" --arg full "${tree_path:+$tree_path/}$1" \
      '.manifests // {} | (.[$m] // .[$full]) // empty | select(type == "object")' 2>/dev/null
  elif [ -n "$slug" ]; then
    fetch "https://api.github.com/repos/$slug/contents/${tree_path:+$tree_path/}$1${tree_ref:+?ref=$tree_ref}" \
      | jq -c 'select(type == "object" and .encoding == "base64") | .content | gsub("\\s"; "")
               | @base64d | fromjson | select(type == "object")' 2>/dev/null
  fi
}

manifest_code=false
manifest_mcp=false
if [ "$listed" -eq 1 ]; then
  read_count=0
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    if [ "$read_count" -ge "$MAX_MANIFESTS" ]; then
      mark_partial "$WHY_MANY_MANIFESTS"
      break
    fi
    read_count=$((read_count + 1))
    if [[ ! "$m" =~ ^[A-Za-z0-9._/-]+$ ]]; then
      mark_partial "$WHY_UNSAFE_PATH"
      continue
    fi
    mjson=$(read_manifest "$m")
    flags=$(printf '%s' "$mjson" | jq -r "$MANIFEST_FLAGS" 2>/dev/null)
    if [ -z "$mjson" ] || [ -z "$flags" ]; then
      mark_partial "$WHY_MANIFEST"
      continue
    fi
    read -r f_code f_net f_external f_outside f_deps <<<"$flags"
    [ "$f_code" = true ] && manifest_code=true
    [ "$f_net" = true ] && manifest_mcp=true
    [ "$f_external" = true ] && mark_partial "$WHY_EXTERNAL"
    [ "$f_outside" = true ] && mark_partial "$WHY_OUTSIDE"
    [ "$f_deps" = true ] && mark_partial "$WHY_DEPENDENCIES"
  done <<EOF
$(printf '%s' "$surface_json" | jq -r "$MANIFESTS" 2>/dev/null)
EOF
fi

# Deterministic classification in jq — pure, reproducible from inputs alone.
jq -c -n \
  --argjson candidate "$candidate" \
  --argjson repo "$repo_json" \
  --argjson surface "$surface_json" \
  --argjson listed "$listed" \
  --arg partial_why "$partial_why" \
  --argjson manifest_code "$manifest_code" \
  --argjson manifest_mcp "$manifest_mcp" \
  --arg kind "$cand_kind" \
'
  ($candidate.tier) as $rtier
  | (if ($repo | length) > 0 then true else false end) as $have_repo
  | ($repo.stargazers_count // null) as $stars
  | ($repo.forks_count // null) as $forks
  | ($repo.pushed_at // null) as $pushed
  | (($repo.archived // false) == true) as $archived
  | ($repo.license.spdx_id // null) as $license
  | ($repo.owner.login // null) as $owner_login
  | ($repo.owner.type // null) as $owner_type

  # Days since the last push (null if unknown).
  | (if $pushed == null then null
     else ((now - ($pushed | fromdateiso8601)) / 86400 | floor) end) as $age_days

  # active: pushed within the last 365 days, not archived.
  | (if $age_days == null then null
     elif ($archived) then false
     elif ($age_days <= 365) then true
     else false end) as $active

  # security surface — from the entries of the assessed surface only (fixture
  # strings are bare relative paths).
  | [ $surface[]? | (if type == "string" then { path: . } else . end)
      | select(type == "object" and (.path | type) == "string") ] as $entries
  | ($entries | map(.path | ascii_downcase | split("/"))) as $segments
  | (any($segments[]; any(.[]; . == "hooks" or . == "scripts" or . == "bin" or . == ".lsp.json"))
     or any($segments[]; length >= 2 and .[-2] == "monitors" and .[-1] == "monitors.json")
     or any($segments[]; .[-1] == "settings.json")
     or any($entries[]; .mode == "100755")
     or any($entries[]; (.type // "blob") != "tree"
         and (.path | ascii_downcase
              | test("\\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe)$"))))
     as $ships_local_code
  | any($segments[]; any(.[]; . == "mcp" or . == "servers" or . == ".mcp.json")) as $ships_mcp_server
  | (($kind == "mcp") or $ships_local_code or $ships_mcp_server
     or $manifest_code or $manifest_mcp) as $code_execution
  | (($kind == "mcp") or $ships_mcp_server or $manifest_mcp) as $network
  | $ships_local_code as $fs_writes
  | ($partial_why | split("\n") | map(select(length > 0))) as $why

  | {
      code_execution: $code_execution,
      network: $network,
      fs_writes: $fs_writes
    } as $surface
  | ( [ $surface | to_entries[] | select(.value) | .key ] ) as $capabilities

  # Trust tier — deterministic from the signal set.
  | (
      if ($rtier == null) and ($have_repo | not) then "unknown"
      elif $archived then "untrusted"
      elif ($rtier != null) and ($rtier > 2) then "untrusted"
      elif ($age_days != null) and ($age_days > 730) then "untrusted"
      elif $code_execution then "caution"
      elif $listed == 0 then "caution"
      elif ($why | length) > 0 then "caution"
      elif ($rtier == 1) then "trusted"
      elif ($stars != null) and ($stars >= 500) and ($active == true) then "trusted"
      else "caution"
      end
    ) as $trust_tier

  | (
      if $trust_tier == "unknown" then "No reputation signal (offline, web-denied, or unrecognized source) — tier withheld."
      elif $trust_tier == "untrusted" then
        (if $archived then "Repository is archived."
         elif ($rtier != null) and ($rtier > 2) then "Unrecognized registry tier \($rtier)."
         else "Stale: no push in over 730 days." end)
      elif $trust_tier == "caution" then
        (if $code_execution then "Ships executable surface (\($capabilities | join(", "))) — not trusted on popularity alone."
         elif $listed == 0 then "Security surface could not be inspected (file listing unavailable) — not trusted unseen."
         elif ($why | length) > 0 then "Security surface partly inspected: \($why | join("; ")) — not trusted unseen."
         else "Signals present but below the trusted bar." end)
      else
        (if ($rtier == 1) then "Official registry (tier 1) with no code-execution surface."
         else "Popular (\($stars) stars), actively maintained, no code-execution surface." end)
      end
    ) as $rationale

  | {
      candidate: $candidate,
      signals: {
        reputation: { registry_tier: $rtier, stars: $stars, forks: $forks },
        maintenance: { pushed_at: $pushed, archived: $archived, active: $active },
        license: $license,
        maintainer: { login: $owner_login, type: $owner_type },
        security_surface: $surface
      },
      trust_tier: $trust_tier,
      rationale: $rationale,
      capabilities: $capabilities
    }
'
