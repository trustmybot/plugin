# tests

Everything test-related for the plugin — how to run, what each layer covers, when to add a test where, and the full manual-test catalog.

## Layered test pyramid

Each layer catches a different class of bug; skipping any layer means shipping a bug the others cannot see.

| Layer | What | Where | Catches |
|---|---|---|---|
| **L0** | Install-smoke (Docker `bun install --ignore-scripts`) | [`docker/install-smoke.Dockerfile`](./docker/) | dist/ shipping, prebuild, MCP server cold-spawn — caught v0.2.0 + v0.3.0 |
| **L1** | Lint (version sync, link check, dist freshness, etc.) | [`lint/*.sh`](./lint/) | Stale CHANGELOG, broken links, version drift, doctrine doc parity |
| **L2** | Unit — handler logic, synthetic args; no LLM, no protocol | `mcp/trajectory-server/src/test/*.test.ts` | Handler bugs, constraint violations, return-shape drift |
| **L3** | Integration — real server subprocess + JSON-RPC stdio | [`mcp-integration/*.test.mjs`](./mcp-integration/), [`hooks/*.sh`](./hooks/) | Schema drift, missing `agent` param, protocol plumbing, role enforcement |
| **L4** | Workflow simulation — MCP-only multi-step flows (no real Claude) | [`workflow-sim/*.test.mjs`](./workflow-sim/) | Workflow contract bugs at the MCP-call level |
| **L5** | Manual dogfood — human-driven interactive Claude Code session | [`manual/`](./manual/) | UX regressions only catchable with a human |
| **L6** | **Workflow-doctrine dogfood — multi-scorer (outcome + trajectory + cost)** against `--plugin-dir` source (issues #108, #110) | [`dogfood/`](./dogfood/) | Doctrine drift between FLOWS.md and reality, agent-prompt regressions, cold-start behavior |
| **L5+L6 combined** | **Full marketplace install + workflow doctrine in one Docker image** — replaces manual L5 (issue #112) | [`docker/l5-l6-combined.Dockerfile`](./docker/) | Everything L0 catches PLUS everything L6 catches, against the as-shipped marketplace artifact. Release-only (token-heavy). |

**Golden rule:** *Layer N green does not imply Layer N+1 green.* Layer 1 passed with 235 tests while a critical bug sat in production — the MCP schema stripped the `agent` parameter on every call, collapsing all role checks to `caller_role: 'unknown'`. Layer 2 would have caught that at the wire level in milliseconds. Always run all three before tagging a release.

## Testing philosophy — light to heavy, fail fast

**Always start from the lightest test layer and only escalate when each preceding layer is green.** The pyramid orders by cost (latency + tokens + manual time) ascending: L0 → L1 → L2 → L3 → L4 → L6 (light, --plugin-dir) → L5+L6 combined (heavy, marketplace simulation in Docker) → L5 manual (last resort).

This applies to:

- **PR review**: PRs that fail L1 don't pay the L2 cost. PRs that pass L1-L4 trigger L6 only when labeled. L5+L6-combined runs on tag pushes only.
- **Release validation**: cut a release candidate → run L0 → L4 (every PR did this already) → run L6 light → only if green, run L5+L6 combined → only if green, cut stable.
- **Investigating a regression**: bisect at the lightest layer that fails. If L1 catches it, don't run L4. If L2 catches it, don't run L6.

**Why**: token cost matters (L5+L6 ≈ $1-3 per run; L6 light ≈ ~$0.20; L1-L4 ≈ free). Human time matters (manual L5 = 30-45 min; the rest is automated). Cheap signals first eliminates the need for expensive ones.

**The escalation chain**:

```
PR opened → L0 + L1-L4 in CI (free, < 2 min)
   ↓ green
PR labeled `L6` (optional) → L6 light in CI (~$0.20, ~3 min)
   ↓ green
Tag pushed → L5+L6 combined in CI (~$1-3, ~10 min)
   ↓ green
Release goes out — L5 manual only for genuinely-novel UX scenarios
```

## Layout

```
tests/
├── README.md                ← (you are here) framework + operational
├── run-all.sh               ← orchestrator — runs L0-L4
├── docker/                  ← L0 install-smoke
├── lint/                    ← L1 lints (version sync, links, doctrine docs)
├── mcp-integration/         ← L3 real server subprocess + JSON-RPC
├── hooks/                   ← L3 hook script tests
├── workflow-sim/            ← L4 MCP-only multi-step workflow tests
├── lib/                     ← shared shell-assert helpers
├── manual/                  ← L5 human-run against a real Claude Code session
│   ├── README.md
│   ├── setup.md
│   └── scenarios.md
└── dogfood/                 ← L6 deterministic-trajectory tests (issue #108)
    ├── run-l6.sh
    ├── lib/flow-helpers.sh
    ├── flows/<name>.test.sh
    ├── fixtures/<name>.sql
    └── expected/<name>.txt
```

Layer 1 (MCP unit tests) lives at `mcp/trajectory-server/src/test/` — colocated with the source it tests, following the convention used elsewhere in that package.

## Run everything automated

```bash
# From plugin/ root:
bash tests/run-all.sh
```

Runs in order: Layer 1 unit → Layer 2 integration → hook scripts → agent-budget lint. Exit non-zero if any suite fails. CI at `.github/workflows/test.yml` runs exactly this on every PR to `dev`.

## Run an individual suite

```bash
# Layer 1 — MCP unit (handlers direct, synthetic args)
(cd mcp/trajectory-server && bun run build && node --test dist/test/*.test.js)

# Layer 2 — MCP integration (real server subprocess + JSON-RPC)
bash tests/mcp-integration/run.sh

# Hook scripts
bash tests/hooks/run.sh

# Agent-prompt budget lint
bash tests/lint/agent-line-budget.sh
```

## Run the manual suite (L5)

See [`manual/README.md`](./manual/README.md) — setup, scenarios, and what to do when a scenario fails.

## Run L6 dogfood (deterministic-trajectory tests)

L6 drives real Claude Code through pre-seeded TMB workflows and asserts the MCP/tool sequence matches FLOWS.md. Issue #108.

```bash
# One-time: set the headless auth token
export CLAUDE_CODE_OAUTH_TOKEN="<your-cc-oauth-token>"

# Run all flows
bash tests/dogfood/run-l6.sh

# Run a single flow by name substring
bash tests/dogfood/run-l6.sh onboarding
```

Each flow lives in `tests/dogfood/flows/<name>.test.sh`. Expected trajectories are `tests/dogfood/expected/<name>.txt` (one MCP/tool call per line, prefixed `mcp_call:` or `tool_use:`). Pre-seed SQL fixtures live in `tests/dogfood/fixtures/<name>.sql`.

To add a new flow: copy an existing `flows/*.test.sh`, name a fixture (or write one), capture the expected sequence by running once with `TMB_DEBUG_TRAJECTORY=1` and reading the `debug_trajectory` table.

CI runs L6 on tag pushes and on PRs labeled `L6`. The workflow at `.github/workflows/l6-dogfood.yml` skips silently if the secret is unset.

## Which layer does a new test belong in?

```
Is the change a pure handler detail (SQL, validation, return shape)?
  → Layer 1 only.

Does the change touch:
  - a tool's inputSchema?
  - a requireRoles wrapper?
  - cross-tool invariants (e.g., validation_history must reflect validation_record)?
  - an agent's MCP responsibility sequence?
  → Layer 1 AND Layer 2.

Does the change affect:
  - an agent's prompt?
  - a skill's behavior?
  - a routing rule in bro/architect?
  - the UX of any user-facing interaction?
  → Layer 1 AND Layer 2 AND Layer 3 (add a scenario).
```

## What each layer cannot catch

- **Layer 1** — bypasses the MCP protocol. Cannot catch schema drift, role enforcement via the SDK (tests pass `agent:'x'` synthetically, production stripping happens before handler sees it), stdio transport bugs, or cross-tool workflow regressions.
- **Layer 2** — deterministic protocol exercise. Cannot catch UX regressions, prompt drift, or whether the LLM *chooses* to call the right MCP at the right time (it tests that the call works when made, not that it's made).
- **Layer 3** — slow and non-deterministic. Cannot substitute for Layer 1/2. If a dogfood run finds a schema bug, that's a signal Layer 1/2 coverage is incomplete.

**Regression teeth proof (Layer 2):** removing `requireRoles('identity_set', ['bro'], …)` from `identity.ts` → Layer 2 fails on the next run with *"architect must be forbidden from identity_set"*. Verified 2026-04-24.

## Add a new test

| Change | Location | Pattern |
|---|---|---|
| MCP tool handler | `mcp/trajectory-server/src/test/<name>.test.ts` | `node:test` + `node:assert/strict`; helper `tempDB()` in `src/test/helpers.ts` |
| Protocol / role / workflow | `tests/mcp-integration/<name>.test.mjs` | import from `./harness.mjs`; use `startClient()` + `call(name, args)` |
| Hook script | `tests/hooks/<name>.test.sh` | shebang + `. tests/lib/assert.sh`; call `test_case`, `assert_*`, `summarize` (skeleton below) |
| Manual scenario | `tests/manual/scenarios.md` | follow the 8-section template at the top of that file |

### Hook test skeleton

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/<your-hook>.sh"

test_case "describe the scenario"
out=$(echo '{"tool_input":{"command":"..."}}' | bash "$HOOK" 2>&1 || true)
assert_contains "$out" "expected-substring"

summarize
```

Assertion helpers (`tests/lib/assert.sh`):

- `assert_eq <expected> <actual> [label]`
- `assert_contains <haystack> <needle> [label]`
- `assert_not_contains <haystack> <needle> [label]`
- `assert_exit_code <expected> <actual> [label]`
- `summarize` — prints pass/fail summary; returns non-zero if any assertion failed.

## Anti-patterns

- **"Layer 1 is green, ship it."** Layer 1 bypasses the MCP protocol layer. The 0-tool-uses bug in PR #41 had 235 Layer 1 tests green while every `identity_set` call in production returned `forbidden` because the schema stripped the `agent` param before the handler saw it. Always validate at the wire level.
- **"Layer 3 will catch it."** Dogfood is slow (minutes per scenario) and non-deterministic (depends on LLM). Schema bugs, role bugs, and required-arg bugs should be caught in ms by Layer 2. Layer 3 is for what only a real LLM session can reveal.
- **"The handler already validates args, so schema doesn't matter."** It does. The LLM discovers what params to pass from the inputSchema. If `agent` isn't declared there, the LLM won't pass it, and role enforcement silently fails.
- **Adding a new MCP tool without a Layer 2 test.** Ship a test alongside the tool, not after. Every protected tool must have a role-matrix test; every tool used in any agent's workflow must appear in that agent's workflow test.

## Related

- [`scripts/hooks/diagnostic/README.md`](../scripts/hooks/diagnostic/README.md) — opt-in probe-bash harness for investigating [issue #14](https://github.com/trustmybot/plugin/issues/14)
