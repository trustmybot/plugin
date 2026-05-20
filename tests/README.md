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
| **L5** | Per-row isolated unit. Same row dir as L6; L5 applies `setup-l5.sh` to pre-seed the prior-state surface so the row runs alone. One row = one test. ~$0.20/test. | [`dogfood/run-l5.sh`](./dogfood/run-l5.sh), [`dogfood/rows/`](./dogfood/rows/) | Per-row contract drift. **First-line check after a fix or when an L6 step fails.** |
| **L6** | Multi-turn chain. Walks the 14 chain steps against a single cumulative trajectory DB; state inherits from prior step instead of `setup-l5.sh`. | [`dogfood/run-l6-chain.sh`](./dogfood/run-l6-chain.sh), [`dogfood/l6-chain/`](./dogfood/l6-chain/) | Cross-step continuity, multi-session state carry. Run after the relevant per-row L5 passes. See [`EVALUATION.md`](./EVALUATION.md) for the journey table + per-step log format. |
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
    ├── run-l5.sh, run-l6-chain.sh, run-ab.sh
    ├── lib/                    ← flow-helpers, l6-chain-helpers, scorers, smoke-helpers, timeout-shim
    ├── rows/<NN>-<name>/       ← canonical row tree (L5 + L6 share the same dir) — prompt.txt + script.json + fixture.txt + setup-l5.sh + outcome bundle
    ├── l6-chain/               ← chain-manifest.json + seeds/ (between-row SQL bridges for chained L6 run)
    ├── fixtures/               ← SQL fixtures (empty, onboarding-named, onboarding-anonymous) — pre-seed the registry-cold gate so rows that exercise task_create_batch don't trip it
    └── ab-scenarios/           ← per-A/B-test layout
```

L2 (MCP unit) lives at `mcp/trajectory-server/src/test/` — colocated with the source it tests, following the convention used elsewhere in that package.

## Run everything automated (L1–L4)

```bash
bash tests/run-all.sh
```

Runs L1 lint → L2 unit → L3 integration → L3 hooks → L4 workflow-sim. Exit non-zero if any suite fails. Run before every push to `dev`.

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
bun test tests/workflow-sim/*.test.mjs
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

Run L5 locally before tagging a release candidate. The token is the one-time `CLAUDE_CODE_OAUTH_TOKEN` from a `claude setup-token` flow.

## Run L6 dogfood (multi-turn chain)

L6 drives real Claude Code through fresh `claude -p` invocations against a cumulative trajectory DB, asserting cross-step DB continuity across the whole user journey. Continuity is DB-driven (bro re-reads `issues`, `tasks`, `discussions`, `audit`, `file_registry` on every cold start via `tmb_recovery`), NOT LLM-session-driven — the chain mirrors how real cross-session resume actually works in production.

The 14 chain steps live in `tests/dogfood/rows/` — the SAME directory L5 runs against. L5 = isolation (applies `setup-l5.sh` to simulate prior-state); L6 = chain (state inherits from prior step's atomic close, `setup-l5.sh` is ignored).

```bash
# Chained run — walks all 14 chain rows against a cumulative trajectory DB.
# Each row fires a fresh `claude -p`; DB continuity drives the chain.
# Per-step logs land at ~/.claude/tmb/l6-chain-runs/<run-id>/.
# See tests/dogfood/l6-chain/README.md.
bash tests/dogfood/run-l6-chain.sh                  # full chain
bash tests/dogfood/run-l6-chain.sh --from 7         # resume from row 7
bash tests/dogfood/run-l6-chain.sh --halt-on-fail 0 # don't stop at first fail
```

Run L6 locally before tagging a release candidate; rc tag policy gates on 14/14 chain pass.

### Debugging an L6 chain failure

When an L6 step fails, the failure can come from either the step itself or from prior chain steps that left bad state behind. To isolate, run the same row in L5 mode:

```bash
bash tests/dogfood/run-l5.sh <NN>-<step-name>     # e.g. 10-consultant
```

L5 applies the step's `setup-l5.sh` to simulate ONLY the prior-state surface (a clean approximation of what the prior chain step should have left), then drives the same prompt + scorers as L6. Two outcomes:

- **L5 passes** — the L6 failure is upstream contamination. Bisect by running the chain `--from` earlier steps; the step whose post-state breaks the next step's L5 pre-conditions is the real culprit.
- **L5 fails** — the step itself is broken (prompt drift, stale scorer, bad `setup-l5.sh`). Fix in isolation, re-run L5 until green, then re-run the chain.

Faster iteration: ~$0.20 per L5 row vs ~$5–10 for a full L6 chain run.

### Writing prompts for L5/L6 rows

L5/L6 test against bro's ability to translate user intent into the right orchestration. Prompts must sound like a real engineer typing — not like a workflow spec. Three rules:

1. **Lazy human tone.** Default to short and vague (`@bro git push`, `@bro hi`). Narrow + tight is fine **only** when needed to scope the assertion ("appends to ~/.todos" pins the file paths so outcome.sql can check them).
2. **Implicit workflows stay bro-side.** Never have the user invoke a step that bro should auto-fire — that bypasses the contract under test.
3. **Always end with `Don't ask questions.`** on a separate line. AUQ is suppressed in test mode, but bro still defaults to asking clarifying questions for ambiguous prompts — the chain then stalls because the synthetic user has no follow-up. This trailing line forces bro to apply documented defaults and proceed, mirroring a real-user "just do the thing" expectation.

| ✓ Natural | ✗ Robotic / over-specified |
|---|---|
| `@bro git push` | `@bro the task on feat/seed-todo is signed off — review and push it.` |
| `@bro let cto weigh in on monolith vs microservices for auth.` | `@bro spawn the cto and have them weigh in on...` |
| `@bro build an add command for the TODO CLI — src/cli.py, appends to ~/.todos.` | `@bro implement an add command for the TODO CLI. Plan and dispatch SWE.` |
| `@bro I want to make this project available on GitHub.` | `@bro reonboard with remote=GitHub, branching_model=github-flow.` |
| `@bro let's switch to Clerk for auth.` | `@bro plan a difficult-path migration from JWT to Clerk and dispatch SWE.` |

Legitimate user-typed slash commands stay verbatim (`/onboard`, `/roundtable …`, `/monitor 123`, `/scan`). Don't have the user type `@bro scan the codebase` — `scan_run` is supposed to be fired implicitly by the registry-cold gate when bro reaches `task_create_batch`. Asking for it explicitly bypasses the very contract row 4 exists to verify.

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
  → L2 + L3 + L5 (add a row under tests/dogfood/rows/).

Does the change affect cross-step / multi-turn dynamics?
  - cumulative state across multiple bro turns
  - state continuity across `--resume` sessions
  - empty-table regression patterns (registry, discussions, agent_runs, etc.)
  → L2 + L3 + L6 (add a row under tests/dogfood/rows/ AND an entry to tests/dogfood/l6-chain/chain-manifest.json).

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

**Regression teeth proof (L3):** removing `requireRoles('task_create_batch', ['bro'], …)` from `tasks.ts` → L3 fails on the next run with *"architect must be forbidden from task_create_batch"*. Verified 2026-04-24.

## Add a new test

| Change | Location | Pattern |
|---|---|---|
| MCP tool handler | `mcp/trajectory-server/src/test/<name>.test.ts` | `node:test` + `node:assert/strict`; helper `tempDB()` in `src/test/helpers.ts` |
| Protocol / role / workflow | `tests/mcp-integration/<name>.test.mjs` | import from `./harness.mjs`; use `startClient()` + `call(name, args)` |
| Hook script | `tests/hooks/<name>.test.sh` | shebang + `. tests/lib/assert.sh`; call `test_case`, `assert_*`, `summarize` (skeleton below) |
| L5 / L6 row | `tests/dogfood/rows/<NN>-<name>/` | scaffold per [`EVALUATION.md`](./EVALUATION.md) — `prompt.txt` + `script.json` + `fixture.txt` + `setup-l5.sh` (L5-only pre-seed) + `outcome.sql` + `tools-required.json` + `tools-forbidden.json` + `cost-budget.json` + optional `outcome-coherence.json` / `outcome-git.json` / `outcome-files.json`. Add to `tests/dogfood/l6-chain/chain-manifest.json` if the row should also run in the L6 chain. |
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

## L5/L6 sandbox

All L5 (`run-l5.sh`), L6 (`run-l6-chain.sh`), and A/B (`run-ab.sh`) runs execute inside a network-isolated sandbox. The sandbox is initialized by `tmb_test_sandbox_init` (from `tests/dogfood/lib/sandbox.sh`) before each `claude -p` invocation and torn down after.

### What the sandbox does

| Layer | Effect |
|---|---|
| PATH prepend | `tests/dogfood/lib/stubs/` wins over real binaries — `gh`, `glab`, `curl`, `wget`, `git-remote-https`, `git-remote-http` are all stub scripts that exit 1 with `tmb sandbox:` in stderr |
| HOME override | `$HOME` is redirected to `$PROJECT/_home` with a minimal `.gitconfig` (test identity) and empty `.ssh/`. Real `~/.config/gh`, `~/.ssh`, `~/.gitconfig` are unreachable |
| Credential purge | `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `NPM_TOKEN`, `AWS_*` all unset |
| Pseudo-remote | `$TMB_TEST_REMOTE` is a local bare git repo at `$PROJECT/_remote.git`. Bro can push/pull against this URL without hitting GitHub or GitLab |
| HTTP proxy block | `HTTP_PROXY` + `HTTPS_PROXY` point at `http://127.0.0.1:1` (closed port). Stray direct HTTP connections fail instantly |

### The test-mode signal

When `$TMB_TEST_REMOTE` is set (test/sandbox mode), `origin` is a local bare repo at that path. All git push/pull operates against `$TMB_TEST_REMOTE` only. Real-remote operations (`gh repo create`, `glab repo create`, `git push https://...`) will fail loudly with "tmb sandbox" in stderr — that is the test mode signal.

### L3 isolation test

`tests/hooks/sandbox-isolation.test.sh` is the acceptance gate. It verifies:

1. `gh repo create` → exit 1 + "tmb sandbox" in stderr
2. `glab repo create` → exit 1 + "tmb sandbox" in stderr
3. `git push https://github.com/...` → exit 1 + sandbox-blocked message
4. After teardown: `PATH`, `HOME`, `TMB_TEST_REMOTE` all restored / unset

Run it directly: `bash tests/hooks/sandbox-isolation.test.sh`. It runs automatically as part of `bash tests/hooks/run.sh` (L3).

## Anti-patterns

- **"L2 is green, ship it."** L2 bypasses the MCP protocol layer. The 0-tool-uses bug in PR #41 had 235 L2 tests green while every bro-only MCP write call in production returned `forbidden` because the schema stripped the `agent` param before the handler saw it. Always validate at the wire level (L3).
- **"L5 will catch it."** Dogfood is slow (minutes per scenario) and non-deterministic (depends on LLM). Schema bugs, role bugs, and required-arg bugs should be caught in ms by L2/L3. L5 is for what only a real LLM session can reveal.
- **"The handler already validates args, so schema doesn't matter."** It does. The LLM discovers what params to pass from the inputSchema. If `agent` isn't declared there, the LLM won't pass it, and role enforcement silently fails.
- **Adding a new MCP tool without an L3 test.** Ship a test alongside the tool, not after. Every protected tool must have a role-matrix test; every tool used in any agent's workflow must appear in that agent's workflow test.

## Related

- [`EVALUATION.md`](./EVALUATION.md) — L5 + L6 evaluation system reference: scorers, flow / scenario layout, the TODO-CLI end-to-end journey table.
