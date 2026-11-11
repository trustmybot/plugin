# tests

> **⚠️ DO NOT TOUCH ANY TEST PROMPTS WITHOUT HUMAN APPROVAL.** `l5-l6/rows/*/prompt.txt` are Human-authored to simulate real-user language. Agents that edit prompts to make a flaky chain pass have drifted the entire L5/L6 suite multiple times. On failure: fix the assertion, `setup-l5.ts`, hook, manifest, or doctrine — never the prompt — unless the Human explicitly says so in chat.

How to run, what each layer covers, when to add a test where.

## Layered test pyramid

Each layer catches a different class of bug; skipping one means shipping a bug the others cannot see.

| Layer | What | Where | Catches |
|---|---|---|---|
| **L0** | Install-smoke (Docker `bun install --ignore-scripts`), and an upgrade smoke from a real-shape v1.0.2 DB | [`l0-install/`](./l0-install/) | dist/ shipping, prebuild, MCP server cold-spawn, a v1.0.2 DB failing trajectory-doctor after the upgrade |
| **L1** | Lint (version sync, link check, dist freshness, layer-budget, etc.) | [`l1-lint/*.sh`](./l1-lint/) | Stale CHANGELOG, broken links, version drift, agent-template line caps, doctrine doc parity |
| **L2** | MCP unit — handler logic against synthetic args; no protocol, no LLM | `mcp/trajectory-server/src/test/*.test.ts` (see [`l2-mcp-unit/`](./l2-mcp-unit/)) | Handler bugs, constraint violations, return-shape drift |
| **L3** | Integration — real server subprocess + JSON-RPC stdio + hook scripts | [`l3-integration/mcp/*.test.mjs`](./l3-integration/mcp/), hook suites `mcp/trajectory-server/src/test/*-l3.test.ts` (node:test, run with L2) | Schema drift, missing `agent` param, protocol plumbing, role enforcement, hook deny/inject behavior |
| **L4** | Workflow simulation — MCP-only multi-step flows (no real Claude) | [`l4-workflow-sim/*.test.mjs`](./l4-workflow-sim/) | Workflow contract bugs at the MCP-call level |
| **L5** | Per-row isolated unit. Same row dir as L6; L5 applies `setup-l5.ts` (if present) to pre-seed the prior-state surface so the row runs alone. One row = one test. ~$0.20/test. | [`l5-l6/run-l5.ts`](./l5-l6/run-l5.ts), [`l5-l6/rows/`](./l5-l6/rows/) | Per-row contract drift. **First-line check after a fix or when an L6 step fails.** |
| **L6** | Multi-turn chain. Walks the 15 chain steps against a single cumulative trajectory DB; state inherits from prior step instead of `setup-l5.ts`. | [`l5-l6/run-l6-chain.ts`](./l5-l6/run-l6-chain.ts), [`l5-l6/l6-chain/`](./l5-l6/l6-chain/) | Cross-step continuity, multi-session state carry. Run after the relevant per-row L5 passes. See [`EVALUATION.md`](./EVALUATION.md) for the journey table + per-step log format. |
| **Release canary** | Full marketplace install + workflow doctrine in one Docker image | [`l0-install/release-canary.Dockerfile`](./l0-install/) | Everything L0 catches + everything L5 catches, against the as-shipped marketplace artifact. RC-only (token-heavy) |

**Golden rule:** *L<sub>N</sub> green does not imply L<sub>N+1</sub> green.* L2 once passed every test while a critical bug sat in production — the MCP schema stripped the `agent` parameter on every call, collapsing all role checks to `caller_role: 'unknown'`. L3 would have caught that at the wire level in milliseconds. Always run L0–L4 before tagging.

## Testing philosophy — light to heavy, fail fast

**Always start from the lightest test layer and only escalate when each preceding layer is green.** The pyramid orders by cost (latency + tokens) ascending: L0 → L1 → L2 → L3 → L4 → L5 (per-flow, `--plugin-dir`) → L6 (multi-turn integration) → Release canary (marketplace simulation in Docker). The automated chain is the sole gate.

Applies to:

- **PR review.** PRs that fail L1 don't pay the L2 cost. PRs that pass L1 trigger L5/L6 only when labeled. Release canary runs on RC tag pushes only.
- **Release validation.** Cut an RC tag → L0 + L1–L4 (the only full L1–L4 sweep) → L5 + L6 → if green, Release canary → if green, promote dev → main → cut stable.
- **Investigating a regression.** Bisect at the lightest layer that fails. If L1 catches it, don't run L4. If L2 catches it, don't run L5.

**Why**: token cost (Release canary ≈ $1–3/run; L6 multi-turn ≈ $0.30–1.00 per scenario; L5 per-flow ≈ ~$0.20; L1–L4 ≈ free). Cheap signals first eliminates the need for expensive ones.

The escalation chain:

```
Local run before push → touched-path tests + bun run build:tsc + touched L1 lints (free)
   ↓ green
PR opened → pr-check runs L1 (tests/run-all.ts --l1-only) + dashboard tests (free)
   ↓ green
PR labeled `L5` (optional) → L5 per-flow runner (~$0.20/flow, ~3 min/flow)
   ↓ green
PR labeled `L6` (optional) → L6 multi-turn integration (~$0.30–1/scenario)
   ↓ green
rc branch at the candidate → workflow_dispatch --ref rc → full release-gate (L0 + L1–L4 + L6)
   ↓ green
RC tag pushed on that commit → Release canary in CI (~$1–3, ~10 min)
   ↓ green
Promote RC → main → tag stable.
```

## Layout

```
tests/
├── README.md                   ← (this) framework + operational
├── EVALUATION.md               ← L5 + L6 evaluation system reference + TODO-CLI journey table
├── run-all.ts                  ← orchestrator — runs L1–L4
├── l0-install/                 ← L0 install-smoke + Release canary
├── l1-lint/                    ← L1 lints (version sync, links, doctrine docs, layer budgets)
├── l2-mcp-unit/                ← pointer — see mcp/trajectory-server/src/test/ for the actual tests
├── l3-integration/
│   ├── mcp/                    ← L3 real server subprocess + JSON-RPC
│   └── hooks/                  ← L3 hook script tests
├── l4-workflow-sim/            ← L4 MCP-only multi-step workflow tests
├── lib/                        ← shared shell-assert helpers
└── l5-l6/                      ← L5 + L6
    ├── run-l5.ts, run-l6-chain.ts
    ├── lib/                    ← flow-helpers, l6-chain-helpers, sandbox, scorers, smoke-helpers, timeout (.ts, each with a .test.ts)
    ├── rows/<NN>/<row-name>/   ← canonical row tree in family folders (L5 + L6 share the same dir) — prompt.txt + script.json + fixture.txt + setup-l5.ts (optional) + outcome bundle
    ├── l6-chain/               ← chain-manifest.json + seeds/ (between-row SQL bridges for chained L6 run)
    └── fixtures/               ← SQL fixtures (empty, onboarding-named, onboarding-anonymous) — pre-seed the world-model-cold gate so rows that exercise task_create_batch don't trip it
```

L2 (MCP unit) lives at `mcp/trajectory-server/src/test/` — colocated with the source it tests, following the convention used elsewhere in that package.

## Run everything automated (L1–L4)

```bash
node --experimental-strip-types tests/run-all.ts
```

Runs L1 lint → L2 unit → L3 integration → L3 hooks → L4 workflow-sim. Exit non-zero if any suite fails. Release-gate's `tests` job runs it at rc; pull requests run only L1 + the dashboard tests (GH 2805). Locally, run the tests for the paths you touch, `bun run build:tsc` and the L1 lints you touch.

L1, L2 and L4 run behind `gh`, `glab` and `claude` stubs that record every call; a recorded call fails the step. L2 and L4 also run with `TMB_FORBID_LIVE_SYNC=1` and `TMB_SCAN_PLUGIN_JSON` pointing at an empty plugin list, so the scan walker reads its plugin inventory from that file instead of spawning `claude plugin list --json`. L1 runs with `TMB_L1_OFFLINE=1`, so `l1-lint/manifest-shape.test.mjs` skips its `claude plugin validate --strict` step there; run the lint directly on a host with the `claude` CLI to include it. Each L4 flow runs with `bun test --timeout 30000`.

Three switches narrow a run:

- `--l1-only` (first argument) builds the payload, runs the L1 block, and exits with its result before L2.
- `--l1-local` (first argument) is the local L1 tier: the same L1 table and self-checks as `--l1-only`, minus the steps that table flags slow and the wm-equivalence reindex check, each of which prints `→ SKIP (--l1-local)`. A step is flagged slow only when it measured above 30 s on a dev machine. It is the plugin repo's `.config/tmb/verification-defaults.json` command, so every swe close runs it (GH 2866); CI keeps `--l1-only`, so the skipped steps still gate each PR.
- `TMB_L1_SKIP` holds space-separated lint basenames (`tool-description-budget.test.mjs`). A step whose arguments name one prints `→ SKIP (TMB_L1_SKIP)` and does not fail the run.

```bash
TMB_L1_SKIP="tool-description-budget.test.mjs" node --experimental-strip-types tests/run-all.ts --l1-only
```

`.github/workflows/pr-check.yml` runs `bun install --frozen-lockfile`, then `node --experimental-strip-types tests/run-all.ts --l1-only` with no `TMB_L1_SKIP`, on every pull request into `dev`, `rc` or `main` (GH 2064), so every L1 lint and the strict tsc in `build:payload` gate each PR. That includes `l1-lint/tsc-noemit.test.mjs` (`tsc --noEmit` on `mcp/trajectory-server` and `dashboard`) and `l1-lint/eslint.test.mjs`, which runs `bun run lint`: typescript-eslint `recommendedTypeChecked` from the root `eslint.config.mjs` over `mcp/trajectory-server/src` and `dashboard/{server,web}`, failing on any violation not in the `eslint-suppressions.json` baseline and on any suppression no longer needed (GH 2064). After fixing baselined violations, run `bunx eslint --prune-suppressions` to shrink the baseline. The `l1` job of `.github/workflows/dev-build.yml` runs the same command on every push to `dev`, so a PR whose green check predates a new L1 rule turns `dev` red after it merges (GH 2651); the `stamp` job still publishes the dev build either way. pr-check runs no full sweep: the full `node --experimental-strip-types tests/run-all.ts` L1–L4 sweep runs only at the rc release gate, whose `tests` job fetches the bge-small model through the `.github/actions/fetch-bge-model` composite action, alongside L6 and L0 (GH 2805). `l1-lint/tool-description-budget.test.mjs` rebuilds the MCP server first when `mcp/trajectory-server/dist/index.js` is missing or older than any file under `mcp/trajectory-server/src/` (GH 2492).

The `dashboard` job of `.github/workflows/pr-check.yml` builds `mcp/trajectory-server` (`build:tsc`, for the `dist/db.js` that `writes.test.mjs` imports) and the dashboard (`bun run build`), then runs `node --test dashboard/test/*.test.mjs` (GH 2616). `run-all.ts` L1 runs the same glob as a non-slow step, so `--l1-local` catches a dashboard failure at swe's close and CI only confirms it (GH 2866). The suites bind localhost ports, so a run inside the agent's Bash sandbox needs local binding allowed (GH 2334). A test that needs a `dashboard/server/*.ts` module imports it through `dashboard/test/server-module.mjs`, which bundles it with esbuild, since the module's chain reaches `mcp/trajectory-server/src` files whose `.js` specifiers Node's type stripping does not resolve.

## Test-environment posture

- **Issue sync is off by default.** `run-all.ts` exports `TMB_DISABLE_REMOTE_SYNC=1`. A test of the sync feature itself keeps sync on and injects a fake spawn function (`_spawnFn` / `makeSpawnFn` in `mcp/trajectory-server/src/test/sync-issue.test.ts`), so no real remote is hit.
- **CI is not your laptop.** GitHub runners have no `rg`, so scripts and lints use `grep`. `l1-lint/no-grep-q-in-pipelines.test.mjs` is textual: even a string literal, such as a fixture's verify command, must use `| grep PAT >/dev/null`. `gh --jq` separates expressions with `,`.

## Run an individual suite

```bash
# L1 — lint
node --test tests/l1-lint/agent-line-budget.test.mjs
# (and any other tests/l1-lint/*.test.mjs or *.sh)

# L2 — MCP unit (handlers direct, synthetic args)
(cd mcp/trajectory-server && bun run build && node --experimental-sqlite --test dist/test/*.test.js)

# L3 — MCP integration (real server subprocess + JSON-RPC)
node tests/l3-integration/mcp/run.mjs

# L3 — Hooks (one node:test suite, built with L2 above)
(cd mcp/trajectory-server && node --experimental-sqlite --test dist/test/<name>-l3.test.js)

# L4 — Workflow simulation
bun test --timeout 30000 tests/l4-workflow-sim/*.test.mjs
```

## Run L5 (per-flow)

L5 drives real Claude Code through one pre-seeded flow and asserts the MCP/tool sequence + DB state matches doctrine. See [`EVALUATION.md`](./EVALUATION.md) for the scorer model and the TODO-CLI journey table.

```bash
# One-time: set the auth token for non-interactive `claude -p`
export CLAUDE_CODE_OAUTH_TOKEN="<your-cc-oauth-token>"

# Run all flows
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l5.ts

# Run a single flow by name substring
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l5.ts onboarding
```

Run L5 locally before tagging a release candidate. The token is the one-time `CLAUDE_CODE_OAUTH_TOKEN` from a `claude setup-token` flow.

## Run L6 (multi-turn chain)

L6 drives real Claude Code through fresh `claude -p` invocations against a cumulative trajectory DB, asserting cross-step DB continuity across the whole user journey. Continuity is DB-driven (bro re-reads `issues`, `tasks`, `discussions`, `audit`, and world-model state on every cold start via `tmb_recovery`), NOT LLM-session-driven — the chain mirrors how real cross-session resume actually works in production.

The 15 chain steps live in `tests/l5-l6/rows/` — the SAME directory L5 runs against. L5 = isolation (applies `setup-l5.ts` to simulate prior-state); L6 = chain (state inherits from prior step's atomic close, `setup-l5.ts` is ignored).

```bash
# Chained run — walks all 15 chain rows against a cumulative trajectory DB.
# Each row fires a fresh `claude -p`; DB continuity drives the chain.
# Per-step logs land at $L6C_RUNS_DIR/<run-id>/ when set, else
# <project>/.claude/tmb/l6-chain-runs/<run-id>/ (<project> = CLAUDE_PROJECT_DIR,
# else the repo root); the chain runs in the project <run-dir>/project/.
# See tests/l5-l6/l6-chain/README.md.
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts                  # full chain
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts --from 7         # resume from row 7
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts --halt-on-fail 0 # don't stop at first fail
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts --self-test      # run-dir + HOME isolation check, no model calls
```

The chain runs with `HOME=<run-dir>/home`; the model cache, mise installs and the OAuth token stay reachable through env (`TMB_MODEL_CACHE_DIR`/`HF_HOME`/`TRANSFORMERS_CACHE`, `MISE_DATA_DIR`/`MISE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`). The run fails at exit, listing the entries, if that HOME holds anything but `.cache/huggingface`.

Run L6 locally before tagging a release candidate; rc tag policy gates on 15/15 chain pass.

### Debugging an L6 chain failure

When an L6 step fails, the failure can come from either the step itself or from prior chain steps that left bad state behind. To isolate, run the same row in L5 mode:

```bash
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l5.ts <NN>-<step-name>     # e.g. 12-consultant
```

L5 applies the step's `setup-l5.ts` to simulate ONLY the prior-state surface (a clean approximation of what the prior chain step should have left), then drives the same prompt + scorers as L6. Two outcomes:

- **L5 passes** — the L6 failure is upstream contamination. Bisect by running the chain `--from` earlier steps; the step whose post-state breaks the next step's L5 pre-conditions is the real culprit.
- **L5 fails** — the step itself is broken (prompt drift, stale scorer, bad `setup-l5.ts`). Fix in isolation, re-run L5 until green, then re-run the chain.

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

Legitimate user-typed slash commands stay verbatim (`/onboard`, `/roundtable …`, `/monitor 123`, `/scan`). Don't have the user type `@bro scan the codebase` — `scan_run` is supposed to be fired implicitly by the world-model-cold gate when bro reaches `task_create_batch`. Asking for it explicitly bypasses the very contract row 4 exists to verify.

## Debug modes

Three opt-in / always-on diagnostic surfaces. Used together they cover the "what was the system doing right before it failed?" question.

| Mode | Surface | Trigger | Purpose |
|---|---|---|---|
| Trajectory capture | `debug_trajectory` SQL table inside the trajectory DB | `TMB_DEBUG_TRAJECTORY=1` | Capture canonical L5 expected-sequence |
| MCP server log | `<project>/.claude/<plugin>/logs/mcp-server.log` (JSONL, file-based) | always-on | Forensics: lifecycle (startup/shutdown/error) + per-tool entry/exit; survives MCP/CC crash |
| SQL query log | `<project>/.claude/<plugin>/logs/sql.log` (JSONL, file-based) | `TMB_DEBUG_SQL=1` | Every `run`/`get`/`all` with sql, params, duration_ms; verbose, off by default |

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
  → L2 + L3 + L5 (add a row under tests/l5-l6/rows/).

Does the change affect cross-step / multi-turn dynamics?
  - cumulative state across multiple bro turns
  - state continuity across `--resume` sessions
  - empty-table regression patterns (world model, discussions, agent_runs, etc.)
  → L2 + L3 + L6 (add a row under tests/l5-l6/rows/ AND an entry to tests/l5-l6/l6-chain/chain-manifest.json).

Does the change introduce a hook or modify hook behavior?
  → L3 (mcp/trajectory-server/src/test/<name>-l3.test.ts).

Does the change touch the schema (DB tables, columns, CHECK constraints)?
  → L2 (test the new shape) + L3 (regression test that callers handle migration).
```

## What each layer cannot catch

- **L2** — bypasses the MCP protocol. Cannot catch schema drift, role enforcement via the SDK (tests pass `agent:'x'` synthetically; production stripping happens before handler sees it), stdio transport bugs, or cross-tool workflow regressions.
- **L3** — deterministic protocol exercise. Cannot catch UX regressions, prompt drift, or whether the LLM *chooses* to call the right MCP at the right time (it tests that the call works when made, not that it's made).
- **L5** — single-shot, slow, non-deterministic. Cannot substitute for L2/L3 (schema/role bugs should be caught in ms). Cannot catch cross-flow drift — that's L6.
- **L6** — multi-turn, slow, non-deterministic. Cannot substitute for L5 (which is faster + tighter for one-flow regressions).

**Regression teeth proof (L3):** removing `requireRoles('task_create_batch', ['bro'], …)` from `tasks.ts` → L3 fails on the next run with *"architect must be forbidden from task_create_batch"*. Verified 2026-04-24.

## Add a new test

| Change | Location | Pattern |
|---|---|---|
| MCP tool handler | `mcp/trajectory-server/src/test/<name>.test.ts` | `node:test` + `node:assert/strict`; helper `tempDB()` in `src/test/helpers.ts` |
| Protocol / role / workflow | `tests/l3-integration/mcp/<name>.test.mjs` | import from `./harness.mjs`; use `startClient()` + `call(name, args)` |
| Hook | `mcp/trajectory-server/src/test/<name>-l3.test.ts` | `node:test` + `node:assert/strict`; `makeSandbox()` + `runGate()` from `src/test/hook-sandbox.ts`, `CLAUDE_PROJECT_DIR` pinned to the sandbox (skeleton below) |
| L5 / L6 row | `tests/l5-l6/rows/<NN>/<row-name>/` (under its family folder) | scaffold per [`EVALUATION.md`](./EVALUATION.md) — `prompt.txt` + `script.json` + `fixture.txt` + optional `setup-l5.ts` (L5-only pre-seed) + `outcome.sql` + `tools-required.json` + `tools-forbidden.json` + `cost-budget.json` + optional `outcome-coherence.json` / `outcome-git.json` / `outcome-files.json`. Add to `tests/l5-l6/l6-chain/chain-manifest.json` if the row should also run in the L6 chain. |

### Hook test skeleton

```ts
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';

describe('<your-gate> l3', () => {
  let sb: Sandbox;

  before(() => {
    sb = makeSandbox('<your-gate>');
  });

  after(() => sb.remove());

  it('describe the scenario', () => {
    const r = runGate('<your-gate>', {
      cwd: sb.dir,
      input: JSON.stringify({ tool_input: { command: '...' } }),
      env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir },
    });
    assert.match(r.stdout + r.stderr, /expected-substring/);
  });
});
```

`hook-sandbox.ts` gives each suite a temp dir with its own `HOME` and `TMPDIR` and a child env that inherits no `CLAUDE_*` / `TMB_*` variable. Pin `CLAUDE_PROJECT_DIR` (or `TRAJECTORY_DB_PATH`) to the sandbox in every hook run, so the hook never resolves the live project trajectory DB. It also exports `noCmdPath()` (a `PATH` without one command), `jsonValues()` and `contextOf()` (a hook's JSON output and its `additionalContext`); `db-test-fixtures.ts` has `migratedDb()` for a current-schema DB.

### Dry runs as assertions (`cli.js assert-sql`)

A dry run or smoke test belongs in a task's `verification[]` as a command that exits non-zero when its expectation fails, so the verification gate and code-reviewer re-run it. The helper ships with the plugin as the `assert-sql` subcommand of `mcp/trajectory-server/dist/cli.js`; point it at a `cp` of the reference data, not the live trajectory DB. In a user project, call it through the plugin root:

```bash
mkdir -p .claude/tmb/tmp && cp .claude/tmb/trajectory.db .claude/tmb/tmp/ref.db
node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" assert-sql .claude/tmb/tmp/ref.db "SELECT count(*) FROM tasks WHERE status = 'closed'" 1 --op ge
```

In this repo, `verification[]` entries can use the path from the plugin root:

```bash
node --experimental-sqlite mcp/trajectory-server/dist/cli.js assert-sql .claude/tmb/tmp/ref.db "SELECT count(*) FROM tasks WHERE status = 'closed'" 1 --op ge
```

`cli.js assert-sql <db> "<sql>" <expected> [--op eq|ge|le]` snapshots the DB with `VACUUM INTO` over a read-only `node:sqlite` connection (so rows still in its `-wal` are included, even while another connection has it open, and the DB and its `-wal` are never written or checkpointed; a WAL-mode DB with no `-wal` is opened immutable, so no `-wal` / `-shm` appears beside it) and queries that private snapshot read-only, requires the query to return a single value, and compares it to `<expected>`: `eq` (default) as strings, `ge` / `le` numerically. It prints one `PASS` / `FAIL` line and exits 0 on a match, 1 on a mismatch or a NULL / no-row result (`got NULL or no rows`, under every op), 2 on a usage error, a missing DB or a SQL error (a write statement fails here too). The snapshot is removed before the query runs, so an interrupted run (INT or TERM) leaves no copy behind. `mcp/trajectory-server/src/test/cli-assert-sql.test.ts` covers eq/ge/le, mismatches, NULL and no-row results, one output line per call, a WAL-mode copy without `-shm`, a row that is only in the `-wal` (with its `-shm` gone, the main file's size and mtime and the `-wal` stay as they were), a row that is only in the `-wal` of a DB held open elsewhere, a missing DB, the read-only guarantee (the DB's mtime is unchanged) and a SIGINT that leaves no temp copy. A spec's `Populated:` line is usually one of these commands.

## L5/L6 sandbox

All L5 (`run-l5.ts`) and L6 (`run-l6-chain.ts`) runs execute inside a network-isolated sandbox. The sandbox is initialized by `tmbTestSandboxInit` (from `tests/l5-l6/lib/sandbox.ts`) before each `claude -p` invocation and torn down by `tmbTestSandboxTeardown` after.

### What the sandbox does

| Layer | Effect |
|---|---|
| PATH prepend | `tests/l5-l6/lib/stubs/` wins over real binaries — `gh`, `glab`, `curl`, `wget`, `git-remote-https`, `git-remote-http` are all stub scripts that exit 1 with `tmb sandbox:` in stderr |
| HOME override | `$HOME` is redirected to `$PROJECT/_home` with a minimal `.gitconfig` (test identity) and empty `.ssh/`. Real `~/.config/gh`, `~/.ssh`, `~/.gitconfig` are unreachable |
| Credential purge | `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `NPM_TOKEN`, `AWS_*` all unset |
| Pseudo-remote | `$TMB_TEST_REMOTE` is a local bare git repo at `$PROJECT/_remote.git`. Bro can push/pull against this URL without hitting GitHub or GitLab |
| HTTP proxy block | `HTTP_PROXY` + `HTTPS_PROXY` point at `http://127.0.0.1:1` (closed port). Stray direct HTTP connections fail instantly |

### The test-mode signal

When `$TMB_TEST_REMOTE` is set (test/sandbox mode), `origin` is a local bare repo at that path. All git push/pull operates against `$TMB_TEST_REMOTE` only. Real-remote operations (`gh repo create`, `glab repo create`, `git push https://...`) will fail loudly with "tmb sandbox" in stderr — that is the test mode signal.

### Isolation test

`tests/l5-l6/lib/sandbox.test.ts` is the acceptance gate. It verifies:

1. `gh repo create` → exit 1 + "tmb sandbox" in stderr
2. `glab repo create` → exit 1 + "tmb sandbox" in stderr
3. `git push https://github.com/...` → exit 1 + sandbox-blocked message
4. After teardown: `PATH`, `HOME`, `TMB_TEST_REMOTE` all restored / unset

Run it directly: `node --experimental-strip-types --test tests/l5-l6/lib/sandbox.test.ts`. It runs automatically as part of `node --experimental-strip-types tests/run-all.ts` (the L5/L6 helper libs step).

## Anti-patterns

- **"L2 is green, ship it."** L2 bypasses the MCP protocol layer. The 0-tool-uses bug in PR #41 had 235 L2 tests green while every bro-only MCP write call in production returned `forbidden` because the schema stripped the `agent` param before the handler saw it. Always validate at the wire level (L3).
- **"L5 will catch it."** L5 is slow (minutes per scenario) and non-deterministic (depends on LLM). Schema bugs, role bugs, and required-arg bugs should be caught in ms by L2/L3. L5 is for what only a real LLM session can reveal.
- **"The handler already validates args, so schema doesn't matter."** It does. The LLM discovers what params to pass from the inputSchema. If `agent` isn't declared there, the LLM won't pass it, and role enforcement silently fails.
- **Adding a new MCP tool without an L3 test.** Ship a test alongside the tool, not after. Every protected tool must have a role-matrix test; every tool used in any agent's workflow must appear in that agent's workflow test.

## Related

- [`EVALUATION.md`](./EVALUATION.md) — L5 + L6 evaluation system reference: scorers, flow / scenario layout, the TODO-CLI end-to-end journey table.
