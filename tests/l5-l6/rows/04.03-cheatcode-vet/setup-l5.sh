#!/usr/bin/env bash
# Cheatcode-vet L5 isolation: seed a deterministic signal fixture and point
# cheatcode_vet at it via TMB_CHEATCODE_VET_FIXTURE so no live web is ever
# touched. The fixture is the {repo, contents} object that stands in for the
# best-effort GitHub responses. Even without the env var the row still passes
# (cheatcode_vet records its audit row with an empty signal set → trust_tier
# 'unknown'), so the fixture only enriches the signals — it never gates the
# assertion.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

FIXTURE="$PROJECT/.tmb-cheatcode-vet-fixture.json"
cat > "$FIXTURE" <<'JSON'
{
  "repo": {
    "stargazers_count": 1200,
    "forks_count": 80,
    "pushed_at": "2026-05-01T00:00:00Z",
    "archived": false,
    "license": { "spdx_id": "MIT" },
    "owner": { "login": "example-org", "type": "Organization" }
  },
  "contents": ["README.md", "LICENSE", "SKILL.md"]
}
JSON

export TMB_CHEATCODE_VET_FIXTURE="$FIXTURE"
