# 3rd-Party Resource Integration (v0.10.0)

Design for the discover → vet → install → hot-load pipeline that lets bro acquire external Claude Code resources (skills, MCP/toolkits, plugins) on demand. Epic #656; sub-issues #657–#660. This doc is the architecture-of-record; every stage below names the [DETERMINISM.md](../prompt-engineering/DETERMINISM.md) mechanism it lands in.

## Principle

The mechanical pipeline (search → record → vet-signals → install → activate) is **deterministic tools + hooks**. Only the two genuinely judgment-bound decisions stay in prose:

- **"Do I lack a capability this task needs?"** — classify (skill prose).
- **"Is this candidate trustworthy enough to install?"** — weigh novel signals (skill prose + AskUserQuestion).

Everything between those two judgments is a tool call, not a checklist.

## Stage map

| Stage | Judgment (mech 7) | Deterministic layer |
|---|---|---|
| **Detect gap (#657)** | bro classifies "task needs capability X I don't have" | — |
| **Search/rank (#657)** | — | `resource_search` composite MCP tool → forks `scripts/resource-search.sh` (web query + parse + deterministic ranking), returns ranked candidates + records an audit row. One call, like `scan_run`→`scan.sh`. |
| **Vet (#658)** | bro weighs "trustworthy enough?" + AskUserQuestion | `resource_vet` tool gathers reputation/security **signals** atomically (stars, age, downloads, maintainer, license, install-surface); never decides. |
| **Install (#659)** | — (approval is the human's, not bro's) | `resource_install` composite (marketplace-install path, no seeding) + **PreToolUse approval gate**: install blocked unless an explicit human-approval record exists for that candidate (mech 3). Records install in trajectory DB. |
| **Hot-load (#660)** | — | `resource_activate` tool attempts in-session load; if CC requires a restart, returns a deterministic `restart_required` verdict and the skill surfaces `claude --resume` (TMB state is in trajectory checkpoints, so resume is safe). |

## Why these boundaries (boundary test applied)

- "Search the web and rank" — strike the verb → "ranked candidate list exists." A fact, reproducible from a query. → composite tool (mech 2), not prose steps.
- "Gather trust signals" — fact-gathering, reproducible. → tool (mech 2). The *verdict* on those signals is judgment → stays prose.
- "Don't install without approval" — "don't proceed until Z." → PreToolUse block (mech 3), not a prose reminder.
- "After install, record it / refresh state" — "after A also do B." → PostToolUse (mech 4) or inside the install composite's transaction.
- "Detect capability gap" / "is it trustworthy" — classify / weigh novel input. → prose (mech 7), no deterministic substitute.

## Permission & safety invariants

- Installs are **human-approved, never silent** — the PreToolUse gate fails closed without an approval record; aligns with the existing permission model.
- Plugin installs use the **marketplace-install path only** (no seed/copy/`--plugin-dir`), per the benchmarks standing rule.
- Web discovery respects any web-deny posture; sources are surfaced to the human before install.
- Approval is per-candidate and per-session (not generalized).

## Testing mandate (every stage)

Each sub-issue ships with, before merge:

- **L1** lint (shellcheck on any new `scripts/` hook/forked script; tsc on new MCP tools).
- **L2** unit tests for each new MCP tool handler (`mcp/trajectory-server/src/test/*.ts`).
- **L3** integration test for each new hook (`tests/l3-integration/hooks/*.sh`) and the forked search/install scripts.
- **L4** workflow-sim for the composite tools.
- **L5/L6**: a **new journey row** per feature under `tests/l5-l6/rows/` exercising the real flow (e.g. `NN-resource-discovery`, `NN-resource-install-approval`), wired into the L6 chain manifest where it carries cumulative state. Discovery/install rows must stub the network/registry deterministically (no live web in CI) — mock the search-script output and the marketplace call, asserting the audit rows + approval-gate behavior, not live results.

## Build order

#657 (search) → #658 (vet) → #659 (install + approval gate) → #660 (hot-load). Each lands its own tools/hooks + full test stack including its L5/L6 row before the next begins.
