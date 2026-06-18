# Cheatcode Integration (v0.10.0)

Design for the discover → vet → install → hot-load pipeline that lets bro acquire cheatcodes (skills, MCP/toolkits, plugins) on demand. Epic #656; sub-issues #657–#660. This doc is the architecture-of-record; every stage below names the [DETERMINISM.md](../prompt-engineering/DETERMINISM.md) mechanism it lands in.

## Principle

The mechanical pipeline (search → record → vet-signals → install → activate) is **deterministic tools + hooks**. Only the two genuinely judgment-bound decisions stay in prose:

- **"Do I lack a capability this task needs?"** — classify (skill prose).
- **"Is this candidate trustworthy enough to install?"** — weigh novel signals (skill prose + AskUserQuestion).

Everything between those two judgments is a tool call, not a checklist.

## Stage map

| Stage | Judgment (mech 7) | Deterministic layer |
|---|---|---|
| **Detect gap (#657)** | bro spots "task needs capability X I don't have" — grab a cheatcode (`tmb_cheatcode` skill) instead of grinding it out | — |
| **Search/rank (#657)** | — | `cheatcode_search` composite MCP tool → forks `scripts/cheatcode-search.sh` (query tiered registries + parse + deterministic ranking), returns ranked candidates + records an audit row. One call, like `scan_run`→`scan.sh`. |
| **Vet (#658)** | bro weighs "trustworthy enough?" + AskUserQuestion | `cheatcode_vet` tool gathers reputation/security **signals** atomically (stars, age, downloads, maintainer, license, install-surface); never decides. |
| **Approve (#659)** | — (approval is the human's, not bro's) | `cheatcode_approve` records the per-candidate human approval (a `cheatcode_approved` audit row keyed by `source_url`). The install gate fails closed until this row exists. |
| **Install + materialize (#659)** | — | `cheatcode_install` composite (marketplace-install path, no seeding) records the `cheatcodes` + attachment rows in one transaction. Blocked by a **PreToolUse approval gate** without a `cheatcode_approve` record (mech 3). For a skill, an optional `target=<bro\|swe\|pr-reviewer\|consultant>` **materializes** the consuming agent — copies the global agent md into the project `.claude/agents/<target>.md` (or `.claude/CLAUDE.md` for bro) and adds the skill to its `skills:` frontmatter, writing the user project only. Without a target a skill-kind install returns a proposed-PR payload and writes no agent md. |
| **Hot-load (#660)** | — | `cheatcode_activate` returns a deterministic verdict: skill-kind attachments are usable in-session (activated); plugin/MCP kinds load on the next `claude -p` cold start, returning `restart_required` + a reason. |
| **Inspect (#112/#113)** | — | `cheatcode_list` is the read-only registry surface — every builtin + installed capability with its `status` (`installed`/`active`/`broken`), `kind`, `origin`, `scope`, `trust_tier`. The "do the cheatcodes work / which are installed" check, distinct from the discovery pipeline. |
| **Uninstall (#676)** | — (Human-confirmed) | `cheatcode_uninstall` reverses one install by `cheatcode_id` in a single transaction (see [Teardown](#teardown--uninstall-676)). Bro-proposed + Human-confirmed (AskUserQuestion), not PreToolUse-gated. |

## Scan-side discovery (#124/#846)

The discover→install pipeline is the *acquisition* path. A second, passive path keeps the registry honest: `scan_run` (`scripts/scan.sh`) reconciles **locally-present** capabilities into the `cheatcodes` table after its repo/file walk — project-local skills (`.claude/skills/<name>/SKILL.md`), enabled plugins (`claude plugin list`), and configured MCP servers (`claude mcp list`, with a `~/.claude.json` `mcpServers` fallback). Each capability not already tracked by `(name, kind)` is INSERTed with `origin='installed'`, `status='installed'`, and `source_url='scan_discovered'` (distinguishing it from pipeline-installed rows), emitting a `scan_discovered` audit row. This is a SQLite write into `cheatcodes` only — it does not touch the kuzu world model (which holds Directory nodes). Best-effort and bounded: the CLI calls run under a short timeout and a missing `claude` binary degrades to the skills-only walk.

## Why these boundaries (boundary test applied)

- "Search the web and rank" — strike the verb → "ranked candidate list exists." A fact, reproducible from a query. → composite tool (mech 2), not prose steps.
- "Gather trust signals" — fact-gathering, reproducible. → tool (mech 2). The tool also emits a `trust_tier` that is a *deterministic classification* of the signal set (like the search score), not an install verdict — the "trustworthy enough to install?" *verdict* is judgment → stays prose (skill + AskUserQuestion).
- "Don't install without approval" — "don't proceed until Z." → PreToolUse block (mech 3), not a prose reminder.
- "After install, record it / refresh state" — "after A also do B." → PostToolUse (mech 4) or inside the install composite's transaction.
- "Detect capability gap" / "is it trustworthy" — classify / weigh novel input. → prose (mech 7), no deterministic substitute.

## Registries (tiered)

Discovery queries real, reputable registries — there is no self-built index. Each source carries a **tier** that doubles as its reputation signal; the ranker trusts the tier, not invented star/download counts. `scripts/cheatcode-search.sh` merges the normalized candidates, dedupes by `source_url` (keeping the lowest tier number = most trusted), and ranks.

**Tier 1 — OFFICIAL:**

- **MCP registry** — `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=<urlenc query>&limit=50`. Each server maps to `{name, description, source_url: .repository.url // .websiteUrl, kind:"mcp", registry:"mcp-official", tier:1}`.
- **Anthropic marketplace** — `GET https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json`. Each plugin entry maps to `{name, description, source_url, kind:"plugin", registry:"anthropic-official", tier:1}`.

**Tier 2 — CURATED (best-effort; skipped silently if unreachable or auth-gated):**

- **PulseMCP** — `GET https://api.pulsemcp.com/v0beta/servers?query=<q>&count_per_page=50` → `{name, description, source_url, kind:"mcp", registry:"pulsemcp", tier:2}`.
- **Smithery** — included only if a stable public, key-free search endpoint is reachable (`registry:"smithery", tier:2`); omitted otherwise. No API key is hardcoded.

Every adapter is best-effort: a short `curl --max-time` timeout, and on any failure (network denied, non-200, bad JSON) it contributes zero candidates and the script continues — an offline/web-denied environment degrades gracefully to an empty candidate set, never a crash. Tests stub the whole merge step via `TMB_CHEATCODE_SEARCH_FIXTURE` (no network in CI).

**Reputation = registry tier.** The deterministic score is `(tier == 1 ? 200 : 100) + relevance * 10`, where `relevance` is the count of unique query tokens appearing in name + description. Candidates sort by score desc, then name asc. Signals returned per candidate: `{registry, tier, relevance}`. Official always outranks curated regardless of relevance ties.

## Permission & safety invariants

- Installs are **human-approved, never silent** — the PreToolUse gate fails closed without an approval record; aligns with the existing permission model.
- Plugin installs use the **marketplace-install path only** (no seed/copy/`--plugin-dir`), per the benchmarks standing rule.
- Web discovery respects any web-deny posture; sources are surfaced to the human before install.
- Approval is per-candidate and per-session (not generalized).

## Teardown — uninstall (#676)

Acquisition must be reversible. A `cheatcode_uninstall` composite (mechanism 2) reverses an install in one transaction:

- Reads the install record and its attachment record (below), reverses the attachment, removes the artifact via the marketplace/plugin uninstall path (no manual file deletion), deletes the install record, and emits a `cheatcode_uninstalled` audit row (mechanism 4).
- **Idempotent:** removes whatever is present, no-ops on what isn't — a partially-installed cheatcode tears down cleanly.

Removal is safer than addition, so uninstall is **bro-proposed + Human-confirmed** (AskUserQuestion), not gated by a PreToolUse approval record. Exception: if an open task declares a dependency on the cheatcode, surface that before removing.

## Attachment — which agent gets the capability (#677)

Hot-load (#660) loads a cheatcode into the session; *attachment* decides which agent can use it. It is kind-dependent, and the rule never violates the prompt-surface review policy (agent/skill/command/CLAUDE.md edits are Human-reviewed, never automatic):

| Kind | Attachment | Prompt-surface? |
|---|---|---|
| **plugin** | marketplace install loads its skills/hooks/commands via the plugin manifest — available without editing any agent | no — automatable |
| **MCP toolkit** | register the server (config) + role-route which agents may call the new tools (mechanisms 1/6) | no — automatable behind the install approval gate |
| **standalone skill** | must be added to a consuming agent's `skills:` frontmatter array | **yes** — the pipeline *proposes* the edit as a Human-reviewed PR, never an automatic write |

Default-prefer **plugin / MCP** kinds, which attach without touching prompt-surface. A standalone-skill cheatcode is allowed, but its attachment is a Human-reviewed prompt-surface change like any other — the pipeline opens the PR, it does not self-merge.

Every attachment writes an **attachment record** to the trajectory DB (kind, target agent/role, artifact) so `cheatcode_uninstall` can reverse exactly what was wired.

## Testing mandate (every stage)

Each sub-issue ships with, before merge:

- **L1** lint (shellcheck on any new `scripts/` hook/forked script; tsc on new MCP tools).
- **L2** unit tests for each new MCP tool handler (`mcp/trajectory-server/src/test/*.ts`).
- **L3** integration test for each new hook (`tests/l3-integration/hooks/*.sh`) and the forked search/install scripts.
- **L4** workflow-sim for the composite tools.
- **L5/L6**: a **new journey row** per feature under `tests/l5-l6/rows/` exercising the real flow (e.g. `40-cheatcode`, `NN-cheatcode-install-approval`), wired into the L6 chain manifest where it carries cumulative state. Discovery/install rows must stub the network/registry deterministically (no live web in CI) — mock the search-script output and the marketplace call, asserting the audit rows + approval-gate behavior, not live results.

## Build order

The pipeline shipped in stage order, each stage landing its own tools/hooks + full test stack (L1–L6 row) before the next: #657 (search) → #676/#677 (teardown + attachment contract) → #658 (vet) → #659 (approve + install + approval gate) → #660 (hot-load). The scan-side discovery path (#124/#846) layered on top once the `cheatcodes` registry was the unified catalog (#101).
