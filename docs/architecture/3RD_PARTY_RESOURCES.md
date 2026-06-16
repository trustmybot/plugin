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
| **Detect gap (#657)** | bro spots "task needs capability X I don't have" — grab a cheatcode (`tmb_cheatcode` skill) instead of grinding it out | — |
| **Search/rank (#657)** | — | `resource_search` composite MCP tool → forks `scripts/resource-search.sh` (query tiered registries + parse + deterministic ranking), returns ranked candidates + records an audit row. One call, like `scan_run`→`scan.sh`. |
| **Vet (#658)** | bro weighs "trustworthy enough?" + AskUserQuestion | `resource_vet` tool gathers reputation/security **signals** atomically (stars, age, downloads, maintainer, license, install-surface); never decides. |
| **Install (#659)** | — (approval is the human's, not bro's) | `resource_install` composite (marketplace-install path, no seeding) + **PreToolUse approval gate**: install blocked unless an explicit human-approval record exists for that candidate (mech 3). Records install in trajectory DB. |
| **Hot-load (#660)** | — | `resource_activate` tool attempts in-session load; if CC requires a restart, returns a deterministic `restart_required` verdict and the skill surfaces `claude --resume` (TMB state is in trajectory checkpoints, so resume is safe). |

## Why these boundaries (boundary test applied)

- "Search the web and rank" — strike the verb → "ranked candidate list exists." A fact, reproducible from a query. → composite tool (mech 2), not prose steps.
- "Gather trust signals" — fact-gathering, reproducible. → tool (mech 2). The *verdict* on those signals is judgment → stays prose.
- "Don't install without approval" — "don't proceed until Z." → PreToolUse block (mech 3), not a prose reminder.
- "After install, record it / refresh state" — "after A also do B." → PostToolUse (mech 4) or inside the install composite's transaction.
- "Detect capability gap" / "is it trustworthy" — classify / weigh novel input. → prose (mech 7), no deterministic substitute.

## Registries (tiered)

Discovery queries real, reputable registries — there is no self-built index. Each source carries a **tier** that doubles as its reputation signal; the ranker trusts the tier, not invented star/download counts. `scripts/resource-search.sh` merges the normalized candidates, dedupes by `source_url` (keeping the lowest tier number = most trusted), and ranks.

**Tier 1 — OFFICIAL:**

- **MCP registry** — `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=<urlenc query>&limit=50`. Each server maps to `{name, description, source_url: .repository.url // .websiteUrl, kind:"mcp", registry:"mcp-official", tier:1}`.
- **Anthropic marketplace** — `GET https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json`. Each plugin entry maps to `{name, description, source_url, kind:"plugin", registry:"anthropic-official", tier:1}`.

**Tier 2 — CURATED (best-effort; skipped silently if unreachable or auth-gated):**

- **PulseMCP** — `GET https://api.pulsemcp.com/v0beta/servers?query=<q>&count_per_page=50` → `{name, description, source_url, kind:"mcp", registry:"pulsemcp", tier:2}`.
- **Smithery** — included only if a stable public, key-free search endpoint is reachable (`registry:"smithery", tier:2`); omitted otherwise. No API key is hardcoded.

Every adapter is best-effort: a short `curl --max-time` timeout, and on any failure (network denied, non-200, bad JSON) it contributes zero candidates and the script continues — an offline/web-denied environment degrades gracefully to an empty candidate set, never a crash. Tests stub the whole merge step via `TMB_RESOURCE_SEARCH_FIXTURE` (no network in CI).

**Reputation = registry tier.** The deterministic score is `(tier == 1 ? 200 : 100) + relevance * 10`, where `relevance` is the count of unique query tokens appearing in name + description. Candidates sort by score desc, then name asc. Signals returned per candidate: `{registry, tier, relevance}`. Official always outranks curated regardless of relevance ties.

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
- **L5/L6**: a **new journey row** per feature under `tests/l5-l6/rows/` exercising the real flow (e.g. `40-cheatcode`, `NN-resource-install-approval`), wired into the L6 chain manifest where it carries cumulative state. Discovery/install rows must stub the network/registry deterministically (no live web in CI) — mock the search-script output and the marketplace call, asserting the audit rows + approval-gate behavior, not live results.

## Build order

#657 (search) → #658 (vet) → #659 (install + approval gate) → #660 (hot-load). Each lands its own tools/hooks + full test stack including its L5/L6 row before the next begins.
