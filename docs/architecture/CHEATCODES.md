# Cheatcode Integration (v0.10.0)

Architecture-of-record for the discover → vet → install → hot-load pipeline that lets bro acquire cheatcodes (skills, MCP toolkits, plugins) on demand. Each stage names the [DETERMINISM.md](../prompt-engineering/DETERMINISM.md) mechanism it lands in.

## Principle

The mechanical pipeline (search → record → vet-signals → install → activate) is **deterministic tools + hooks**. Only the genuinely judgment-bound decisions stay prose:

- **"Do I lack a capability this task needs?"** — classify.
- **"Is this candidate trustworthy enough to install?"** — weigh signals + AskUserQuestion.
- **"Which agent consumes it?"** — resolve a target (or infer by domain).

Everything between those judgments is a tool call, not a checklist.

## Stage map

| Stage | Deterministic layer |
|---|---|
| **Detect gap** | bro spots "task needs capability X I don't have" → grab a cheatcode (`tmb_cheatcode` skill) instead of grinding it out. |
| **Search/rank** | `cheatcode_search` forks `scripts/cheatcode-search.sh` (query tiered registries → parse → deterministic rank), returns ranked candidates + an audit row. One call, like `scan_run`→`scan.sh`. |
| **Vet** | `cheatcode_vet` gathers reputation/security **signals** atomically (tier, relevance, install-surface) + a deterministic `trust_tier`; never decides. |
| **Approve** | `cheatcode_approve` records the per-candidate Human approval. A PreToolUse gate fails closed until that row exists. |
| **Install + materialize** | `cheatcode_install` composite (marketplace/MCP path, no seeding) records the `cheatcodes` row + attachment rows + audit rows in one transaction; idempotent on (name, source_url). With `target=<bro\|swe\|pr-reviewer\|consultant>` it **materializes** the consuming agent (see Attachment). A skill install requires a target; without one it is hard-rejected. |
| **Hot-load** | `cheatcode_activate` returns a deterministic verdict: skills are usable in-session; plugin/MCP kinds load on the next cold start (`restart_required`). |
| **Inspect** | `cheatcode_list` is the read-only registry surface — every builtin + installed capability with its `status`, `kind`, `origin`, `scope`, `trust_tier`. |
| **Uninstall** | `cheatcode_uninstall` reverses one install by `cheatcode_id` in a single transaction (Human-confirmed, not gated). See [Teardown](#teardown--uninstall). |

## Scan-side discovery

The pipeline is the *acquisition* path. A passive path keeps the registry honest: `scan_run` (`scripts/scan.sh`) reconciles **locally-present** capabilities into `cheatcodes` after its repo/file walk — project-local skills (`.claude/skills/<name>/SKILL.md`), enabled plugins (`claude plugin list`), and configured MCP servers (`claude mcp list`). Each not already tracked by `(name, kind)` is inserted with `origin='installed'`, `status='installed'`, `source_url='scan_discovered'`, emitting a `scan_discovered` audit row. Best-effort and bounded: CLI calls run under a short timeout; a missing `claude` binary degrades to the skills-only walk.

## Registries (tiered)

Discovery queries real, reputable registries — no self-built index. Each source carries a **tier** that doubles as its reputation signal; `cheatcode-search.sh` merges normalized candidates, dedupes by `source_url` (keeping the lowest tier number), and ranks.

- **Tier 1 — official:** the MCP registry and the Anthropic plugin marketplace.
- **Tier 2 — curated (best-effort):** PulseMCP, and Smithery only if a stable key-free endpoint is reachable.

Every adapter is best-effort: a short `curl --max-time`, and on any failure (network denied, non-200, bad JSON) it contributes zero candidates and the script continues — a web-denied environment degrades to an empty set, never a crash. Tests stub the merge via `TMB_CHEATCODE_SEARCH_FIXTURE`.

**Reputation = registry tier.** Score = `(tier == 1 ? 200 : 100) + relevance * 10`, where `relevance` is the count of unique query tokens in name + description. Sort by score desc, then name asc — official always outranks curated.

## Permission & safety invariants

- Installs are **human-approved, never silent** — the PreToolUse gate fails closed without an approval record.
- Plugin installs use the **marketplace-install path only** (no seed/copy/`--plugin-dir`).
- Web discovery respects any web-deny posture; sources are surfaced to the Human before install.
- Approval is per-candidate and per-session.

## Attachment — which agent gets the capability

Hot-load loads a cheatcode into the session; *attachment* decides which agent can use it. It is kind-dependent and never violates the prompt-surface review policy (agent/skill/command/CLAUDE.md edits are Human-reviewed, never silently merged upstream). Materialization writes the **user project's `.claude/` only — never the plugin repo**.

| Kind | Attachment |
|---|---|
| **plugin (skill-contributing)** | the marketplace install loads its skills via the manifest — available to an unrestricted agent with no edit. For a restricted `target`, the cheatcode name is added to that agent's `skills:` so its allowlist can load the skill. |
| **plugin (tool-contributing)** | a plugin providing a built-in tool (an LSP plugin provides `LSP`, detected from its cache manifest `.claude-plugin/plugin.json`) grants that tool to the consuming agent's `tools:` allowlist. Writing the name to `skills:` would be inert. |
| **MCP toolkit** | register the server (config); its tools register globally, callable by any agent — no per-agent grant. |
| **standalone skill** | added to a consuming agent's `skills:` frontmatter. For a non-bro target the install copies the global `agents/<target>.md` into `.claude/agents/<target>.md` (if absent) and adds the entry; `target=bro` writes a `.claude/CLAUDE.md` reference instead. |

Default-prefer **plugin / MCP** kinds. Every attachment writes an **attachment record** (kind, target, artifact) to the trajectory DB so `cheatcode_uninstall` can reverse exactly what was wired.

## Teardown — uninstall

Acquisition must be reversible. `cheatcode_uninstall` reverses an install in one transaction:

- Reads the install + its attachment records, reverses each attachment (de-materializes the `skills:`/`tools:` entry or the CLAUDE.md reference), removes the artifact via the marketplace/MCP uninstall path (no manual file deletion), deletes the rows, and emits a `cheatcode_uninstalled` audit row.
- **Idempotent:** removes whatever is present, no-ops on what isn't.
- **Honesty gate:** if teardown fails, keep the row, flip `status → broken`, and report `uninstalled:false` rather than claim a clean removal.

Removal is safer than addition, so uninstall is **bro-proposed + Human-confirmed** (AskUserQuestion), not PreToolUse-gated. If an open task declares a dependency on the cheatcode, surface that before removing.

## Testing mandate

Each capability ships, before merge, with: **L1** lint (shellcheck on new scripts; tsc on new MCP tools); **L2** unit tests per MCP tool handler; **L3** integration tests for new hooks and the forked search/install scripts; **L4** workflow-sim for the composites; **L5/L6** a journey row under `tests/l5-l6/rows/` exercising the real flow, wired into the L6 chain manifest. Discovery/install rows stub the network/registry deterministically — assert audit rows + approval-gate behavior, never live results.
