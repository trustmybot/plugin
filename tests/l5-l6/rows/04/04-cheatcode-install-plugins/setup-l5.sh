#!/usr/bin/env bash
# Cheatcode-install-plugins L5 isolation: seed deterministic fixtures for the
# whole search → vet → approve → install SOP so no live web / real marketplace
# call is ever made. All three fixtures live in the project dir at the default
# file-convention paths (cheatcode-search.sh / cheatcode-vet.sh probe these when
# their env var is unset), so the chain reaches them regardless of subshell env
# propagation; the env exports additionally cover runners that source this setup.
#
# Both candidates are plugin-kind: feature-dev (attaches to swe) and code-review
# (attaches to pr-reviewer). The search fixture supplies both candidates so the
# discovery step is deterministic; the vet fixture supplies the {repo, contents}
# signal set for either candidate (plugin-kind forces a code-execution surface →
# 'caution' tier, gating the human approval); the install fixture supplies the
# {installed, version, attachments} marketplace result that passes through
# verbatim. No network on any step.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

SEARCH_FIXTURE="$PROJECT/.tmb-cheatcode-fixture.json"
cat > "$SEARCH_FIXTURE" <<'JSON'
[
  { "name": "feature-dev", "kind": "plugin", "source_url": "https://github.com/example-org/feature-dev",
    "description": "feature development plugin for swe agents implementing specs", "registry": "anthropic-official", "tier": 1 },
  { "name": "code-review", "kind": "plugin", "source_url": "https://github.com/example-org/code-review",
    "description": "optional code-review linting conveniences for pr-reviewer agents", "registry": "anthropic-official", "tier": 1 }
]
JSON

VET_FIXTURE="$PROJECT/.tmb-cheatcode-vet-fixture.json"
cat > "$VET_FIXTURE" <<'JSON'
{
  "repo": {
    "stargazers_count": 1200,
    "forks_count": 80,
    "pushed_at": "2026-05-01T00:00:00Z",
    "archived": false,
    "license": { "spdx_id": "MIT" },
    "owner": { "login": "example-org", "type": "Organization" }
  },
  "contents": ["README.md", "LICENSE", ".claude-plugin", "hooks"]
}
JSON

FIXTURE="$PROJECT/.tmb-cheatcode-install-fixture.json"
cat > "$FIXTURE" <<'JSON'
{
  "installed": true,
  "version": "1.0.0",
  "error": null,
  "attachments": [
    { "target": "swe", "artifact": "marketplace-plugin:feature-dev" },
    { "target": "pr-reviewer", "artifact": "marketplace-plugin:code-review" }
  ]
}
JSON

export TMB_CHEATCODE_SEARCH_FIXTURE="$SEARCH_FIXTURE"
export TMB_CHEATCODE_VET_FIXTURE="$VET_FIXTURE"
export TMB_CHEATCODE_INSTALL_FIXTURE="$FIXTURE"
