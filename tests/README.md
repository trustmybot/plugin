# tests

How to run, what each layer covers, when to add a test where.

## Layered test pyramid

Each layer catches a different class of bug; skipping one means shipping a bug the others cannot see.

| Layer | What | Where | Catches |
|---|---|---|---|
| **L0** | Install-smoke (Docker `bun install --ignore-scripts`) | [`docker/install-smoke.Dockerfile`](./docker/) | dist/ shipping, prebuild, MCP server cold-spawn |
| **L1** | Lint (version sync, link check, dist freshness, layer-budget, etc.) | [`lint/*.sh`](./lint/) | Stale CHANGELOG, broken links, version drift, agent-template line caps, doctrine doc parity |
| **L2** | MCP unit — handler logic against synthetic args; no protocol, no LLM | `mcp/trajectory-server/src/test/*.test.ts` | Handler bugs, constraint violations, return-shape drift |
| **L3** | Integration — real server subprocess + JSON-RPC stdio + hook scripts | [`mcp-integration/*.test.mjs`](./mcp-integration/), [`hooks/*.sh`](./hooks/) | Schema drift, missing `agent` param, protocol plumbing, role enforcement, hook deny/inject behavior |
| **L4** | Workflow simulation — MCP-only multi-step flows (no real Claude) | [`workflow-sim/*.test.mjs`](./workflow-sim/) | Workflow contract bugs at the MCP-call level |
| **L5** | Per-row independent units. Each test starts from a fixture pre-seeding the cumulative state up to that row (codebase + MCP DB rows + audit history). One row = one test. ~$0.20/test. | [`dogfood/run-l5.sh`](./dogfood/run-l5.sh), [`dogfood/flows/`](./dogfood/flows/) | Per-row contract drift. **First-line check after a fix.** If the L5 for a row fails, don't run L6 yet. |
| **L6** | Single chained integration. Walks all 13 journey rows sequentially in one CC session via `claude --session-id` / `--resume`. State carries across rows. | [`dogfood/run-l6.sh`](./dogfood/run-l6.sh), [`dogfood/integration/scenarios/`](./dogfood/integration/scenarios/) | Cross-row continuity (row N+1 inheriting row N's DB writes). Run after relevant L5s pass. See [`EVALUATION.md`](./EVALUATION.md) for the journey table + per-step log format. |
| **Release canary** | Full marketplace install + workflow doctrine in one Docker image | [`docker/release-canary.Dockerfile`](./docker/) | Everything L0 catches + everything L5 catches, against the as-shipped marketplace artifact. RC-only (token-heavy) |
| **A/B prompt eval** | Head-to-head comparison of doctrine variants (e.g. CLAUDE.md slim vs padded). N pairs per arm against an L5 flow → per-arm pass-rate + chi-squared p-value | [`dogfood/run-ab.sh`](./dogfood/run-ab.sh) + [`dogfood/ab-scenarios/`](./dogfood/ab-scenarios/) | Whether a doctrine change moves the needle vs is just rearrangement |
| **Manual smoke** *(fallback)* | Human-driven interactive Claude Code session for UX scenarios the automated layers can't model (e.g. AskUserQuestion interactivity, real worktree creation in CC's UI) | [`manual/`](./manual/) | UX regressions only catchable with a human in the loop |

**Golden rule:** *L<sub>N</sub> green does not imply L<sub>N+1</sub> green.* L2 once passed every test while a critical bug sat in production — the MCP schema stripped the `agent` parameter on every call, collapsing all role checks to `caller_role: 'unknown'`. L3 would have caught that at the wire level in milliseconds. Always run L0–L4 before tagging.

## Testing philosophy — light to heavy, fail fast

**Always start from the lightest test layer and only escalate when each preceding layer is green.** The pyramid orders by cost (latency + tokens + manual time) ascending: L0 → L1 → L2 → L3 → L4 → L5 (per-flow, `--plugin-dir`) → L6 (multi-turn integration) → Release canary (marketplace simulation in Docker) → Manual smoke (last resort).

Applies to:

- **PR review.** PRs that fail L1 don't pay the L2 cost. PRs that pass L1–L4 trigger L5/L6 only when labeled. Release canary runs on RC tag pushes only.
- **Release validation.** Cut an RC tag → L0 + L1–L4 (every PR did this) → L5 + L6 → if green, Release canary → if green, promote dev → main → cut stable.
- **Investigating a regression.** Bisect at the lightest layer that fails. If L1 catches it, don't run L4. If L2 catches it, don't run L5.

**Why**: token cost (Release canary ≈ $1–3/run; L6 multi-turn ≈ $0.30–1.00 per scenario; L5 per-flow ≈ ~$0.20; L1–L4 ≈ free). Human time (manual smoke = 30–45 min; rest is automated). Cheap signals first eliminates the need for expensive ones.

The escalation chain:

```
PR opened → L0 + L1–L4 in CI (free, < 2 min)
   ↓ green
PR labeled `L5` (optional) → L5 per-flow runner (~$0.20/flow, ~3 min/flow)
   ↓ green
PR labeled `L6` (optional) → L6 multi-turn integration (~$0.30–1/scenario)
   ↓ green
RC tag pushed → Release canary in CI (~$1–3, ~10 min)
   ↓ green
Promote RC → main → tag stable. Manual smoke only when an automated layer
  genuinely can't model the scenario.
```

## Layout

```
tests/
├── README.md                   ← (this) framework + operational
├── EVALUATION.md               ← L5 + L6 evaluation system reference + TODO-CLI journey table
├── run-all.sh                  ← orchestrator — runs L1–L4
├── docker/                     ← L0 install-smoke + Release canary
├── lint/                       ← L1 lints (version sync, links, doctrine docs, layer budgets)
├── mcp-integration/            ← L3 real server subprocess + JSON-RPC
├── hooks/                      ← L3 hook script tests
├── workflow-sim/               ← L4 MCP-only multi-step workflow tests
├── lib/                        ← shared shell-assert helpers
├── manual/                     ← Manual smoke (human-run against real CC)
│   ├── README.md
│   ├── setup.md
│   └── scenarios.md
└── dogfood/                    ← L5 + L6 dogfood + A/B framework
    ├── run-l5.sh, run-l6.sh, run-ab.sh
    ├── lib/                    ← flow-helpers, l6-helpers, scorers, smoke-helpers, timeout-shim
    ├── flows/<name>/           ← L5 per-flow scaffolding (run.sh + outcome.sql + tools-required + tools-forbidden + cost-budget + outcome-coherence + outcome-git)
    ├── integration/scenarios/<name>/  ← L6 multi-turn scenarios (script.json + prompt.txt + outcome bundle)
    ├── fixtures/               ← SQL fixtures (empty, onboarding-named, onboarding-anonymous) — pre-seed the registry-cold gate so flows that exercise task_create_batch don't trip it
    └── ab-scenarios/           ← per-A/B-test layout
```

L2 (MCP unit) lives at `mcp/trajectory-server/src/test/` — colocated with the source it tests, following the convention used elsewhere in that package.

## Run everything automated (L1–L4)

```bash
bash tests/run-all.sh
```

Runs L1 lint → L2 unit → L3 integration → L3 hooks → L4 workflow-sim. Exit non-zero if any suite fails. CI runs exactly this on every PR to `dev`.

## Run an individual suite

```bash
# L1 — lint
bash tests/lint/agent-line-budget.sh
# (and any other tests/lint/*.sh)

# L2 — MCP unit (handlers direct, synthetic args)
(cd mcp/trajectory-server && bun run build && node --experimental-sqlite --test dist/test/*.test.js)

# L3 — MCP integration (real server subprocess + JSON-RPC)
bash tests/mcp-integration/run.sh

# L3 — Hook scripts
bash tests/hooks/run.sh

# L4 — Workflow simulation
node --test tests/workflow-sim/*.test.mjs
```

## Run L5 dogfood (per-flow)

L5 drives real Claude Code through one pre-seeded flow and asserts the MCP/tool sequence + DB state matches doctrine. See [`EVALUATION.md`](./EVALUATION.md) for the scorer model and the TODO-CLI journey table.

```bash
# One-time: set the headless auth token
export CLAUDE_CODE_OAUTH_TOKEN="<your-cc-oauth-token>"

# Run all flows
bash tests/dogfood/run-l5.sh

# Run a single flow by name substring
bash tests/dogfood/run-l5.sh onboarding
```

CI runs L5 on tag pushes and on PRs labeled `L5`. The workflow at `.github/workflows/l5-dogfood.yml` skips silently if the secret is unset.

## Run L6 dogfood (multi-turn integration)

L6 drives real Claude Code through a multi-turn continuous session via `--session-id` / `--resume`, asserting cumulative state across the whole user journey. Each scenario is one self-contained journey; multiple scenarios compose into the TODO-CLI sequence in [`EVALUATION.md`](./EVALUATION.md).

```bash
# Run all scenarios
bash tests/dogfood/run-l6.sh

# Run a single scenario by name substring
bash tests/dogfood/run-l6.sh 04-reonboard
```

CI gates L6 the same way as L5 — on tag pushes and PRs labeled `L6`.

## A/B prompt eval

Reach for the A/B framework when you're about to ship a doctrine change ("tightening this CLAUDE.md section, hope it helps") and want data instead of vibes:

- Compare two CLAUDE.md slim variants on the same flow + prompt → which one improves outcome pass-rate?
- Compare Hybrid D' (cold-start AskUserQuestion + lazy default) against pure-lazy → did the question add value?

Skip A/B for: small mechanical fixes (typos, lint), schema/MCP changes (those land via L1–L4), or anything where the right outcome is obvious without measurement.

```bash
export CLAUDE_CODE_OAUTH_TOKEN=<token>
N=10 bash tests/dogfood/run-ab.sh <scenario-name>
bash tests/dogfood/scripts/ab-report.sh <scenario-name> --db <persisted-trajectory.db>
```

See `tests/dogfood/ab-scenarios/example-claude-md-slim/README.md` for the worked-example scenario layout.

## Run manual smoke

See [`manual/README.md`](./manual/README.md) — setup, scenarios, and what to do when a scenario fails.

## Debug modes

Three opt-in / always-on diagnostic surfaces. Used together they cover the "what was the system doing right before it failed?" question.

| Mode | Surface | Trigger | Purpose |
|---|---|---|---|
| Trajectory capture | `debug_trajectory` SQL table inside the trajectory DB | `TMB_DEBUG_TRAJECTORY=1` | Capture canonical L5 expected-sequence; A/B prompt-eval input |
| MCP server log | `~/.claude/tmb/logs/mcp-server.log` (JSONL, file-based) | always-on | Forensics: lifecycle (startup/shutdown/error) + per-tool entry/exit; survives MCP/CC crash |
| SQL query log | `~/.claude/tmb/logs/sql.log` (JSONL, file-based) | `TMB_DEBUG_SQL=1` | Every `run`/`get`/`all` with sql, params, duration_ms; verbose, off by default |

`mcp-server.log` and `sql.log` are file-based by design — they survive MCP-child or CC-host death, which is the failure mode where the SQL `debug_trajectory` table becomes unreadable.

**Privacy note** — `TMB_DEBUG_SQL=1` logs every SQL parameter verbatim (task descriptions, identity names, discussion content, spec bodies). Enable only when investigating; disable immediately after; don't commit `sql.log` or paste it unredacted.

## Which layer does a new test belong in?

```
Is the change a pure handler detail (SQL, validation, return shape)?
  → L2 only.

Does the change touch:
  - a tool's inputSchema?
  - a requireRoles wrapper?
  - cross-tool invariants (e.g., validation_history must reflect validation_record)?
  - an agent's MCP responsibility sequence?
  → L2 + L3.

Does the change affect:
  - an agent's prompt?
  - a skill's behavior?
  - a routing rule in bro/architect?
  - the UX of any single user-facing interaction?
  → L2 + L3 + L5 (add a flow under tests/dogfood/flows/).

Does the change affect cross-flow / multi-turn dynamics?
  - cumulative state across multiple bro turns
  - state continuity across `--resume` sessions
  - empty-table regression patterns (registry, discussions, agent_runs, etc.)
  → L2 + L3 + L6 (add a scenario under tests/dogfood/integration/scenarios/).

Does the change introduce a hook or modify hook behavior?
  → L3 (tests/hooks/<name>.test.sh).

Does the change touch the schema (DB tables, columns, CHECK constraints)?
  → L2 (test the new shape) + L3 (regression test that callers handle migration).
```

## What each layer cannot catch

- **L2** — bypasses the MCP protocol. Cannot catch schema drift, role enforcement via the SDK (tests pass `agent:'x'` synthetically; production stripping happens before handler sees it), stdio transport bugs, or cross-tool workflow regressions.
- **L3** — deterministic protocol exercise. Cannot catch UX regressions, prompt drift, or whether the LLM *chooses* to call the right MCP at the right time (it tests that the call works when made, not that it's made).
- **L5** — single-shot, slow, non-deterministic. Cannot substitute for L2/L3 (schema/role bugs should be caught in ms). Cannot catch cross-flow drift — that's L6.
- **L6** — multi-turn, slow, non-deterministic. Cannot substitute for L5 (which is faster + tighter for one-flow regressions). Cannot catch what only happens with a real Human in the loop — that's manual smoke.

**Regression teeth proof (L3):** removing `requireRoles('identity_set', ['bro'], …)` from `identity.ts` → L3 fails on the next run with *"architect must be forbidden from identity_set"*. Verified 2026-04-24.

## Add a new test

| Change | Location | Pattern |
|---|---|---|
| MCP tool handler | `mcp/trajectory-server/src/test/<name>.test.ts` | `node:test` + `node:assert/strict`; helper `tempDB()` in `src/test/helpers.ts` |
| Protocol / role / workflow | `tests/mcp-integration/<name>.test.mjs` | import from `./harness.mjs`; use `startClient()` + `call(name, args)` |
| Hook script | `tests/hooks/<name>.test.sh` | shebang + `. tests/lib/assert.sh`; call `test_case`, `assert_*`, `summarize` (skeleton below) |
| L5 per-flow scenario | `tests/dogfood/flows/<NN>-<name>/` | scaffold per [`EVALUATION.md`](./EVALUATION.md) — `run.sh` + `outcome.sql` + `tools-required.json` + `tools-forbidden.json` + `cost-budget.json` + optional `outcome-coherence.json` + `outcome-git.json` |
| L6 multi-turn scenario | `tests/dogfood/integration/scenarios/<name>/` | scaffold per [`EVALUATION.md`](./EVALUATION.md) — same outcome bundle as L5 plus `script.json` (turns) + `prompt.txt` (turn-1 user input) + `fixture.txt` |
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

- **"L2 is green, ship it."** L2 bypasses the MCP protocol layer. The 0-tool-uses bug in PR #41 had 235 L2 tests green while every `identity_set` call in production returned `forbidden` because the schema stripped the `agent` param before the handler saw it. Always validate at the wire level (L3).
- **"L5 will catch it."** Dogfood is slow (minutes per scenario) and non-deterministic (depends on LLM). Schema bugs, role bugs, and required-arg bugs should be caught in ms by L2/L3. L5 is for what only a real LLM session can reveal.
- **"The handler already validates args, so schema doesn't matter."** It does. The LLM discovers what params to pass from the inputSchema. If `agent` isn't declared there, the LLM won't pass it, and role enforcement silently fails.
- **Adding a new MCP tool without an L3 test.** Ship a test alongside the tool, not after. Every protected tool must have a role-matrix test; every tool used in any agent's workflow must appear in that agent's workflow test.

## Related

- [`EVALUATION.md`](./EVALUATION.md) — L5 + L6 evaluation system reference: scorers, flow / scenario layout, the TODO-CLI end-to-end journey table.
- [`scripts/hooks/diagnostic/README.md`](../scripts/hooks/diagnostic/README.md) — opt-in probe-bash harness for issue #14.
