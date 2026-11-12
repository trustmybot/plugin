# Cheatcode Integration

Architecture-of-record for the discover → vet → install → hot-load pipeline that lets bro acquire cheatcodes (skills, MCP toolkits, plugins) on demand. Which layer enforces each stage follows [DETERMINISTIC_LAYER.md](../prompt-engineering/DETERMINISTIC_LAYER.md). The tools that implement the stages are the `cheatcode_*` family in `mcp/trajectory-server/src/tools/` (`cheatcode.ts`, `cheatcode-search.ts`); the user-side procedure is the `tmb_cheatcode` skill, and the lifecycle at design level is flow 10 in [`FLOWS.md`](./FLOWS.md).

## Principle

The mechanical pipeline (search → record → vet signals → install → activate) is **deterministic tools + hooks**. Only the genuinely judgment-bound decisions stay prose:

- **"Do I lack a capability this task needs?"** — classify.
- **"Is this candidate trustworthy enough to install?"** — weigh signals + ask the Human.
- **"Which agent consumes it?"** — resolve a target (or infer by domain).

Everything between those judgments is a tool call, not a checklist.

## Stages

| Stage | What happens |
|---|---|
| **Detect gap** | bro spots that a task needs a capability it lacks and reaches for a cheatcode instead of grinding it out. |
| **Search/rank** | One call queries the tiered registries, ranks the candidates deterministically and records an audit row. |
| **Vet** | Gathers reputation and security signals and a deterministic trust tier. It reports, never decides. |
| **Approve** | Records the Human's per-candidate approval. A PreToolUse gate fails closed on install until that record exists. |
| **Install + materialize** | One transaction records the capability, every attachment and the audit rows, and wires the consuming agent (see Attachment). Idempotent per candidate. A skill install without a target is refused. |
| **Hot-load** | A deterministic verdict by kind: skills are usable in-session; plugin and MCP kinds load on the next cold start. |
| **Reconcile** | The server checks recorded capabilities against the real runtime and audits drift. |
| **Uninstall** | Reverses one install in a single transaction (see Teardown). |

## Scan-side discovery

The pipeline is the *acquisition* path. A passive path keeps the registry honest: `scan_run` reconciles **locally present** capabilities into the `cheatcodes` table — project-local skills, enabled plugins and configured MCP servers — recording each one not already tracked with an audit row. It is best-effort: a missing `claude` CLI degrades it to the skills-only walk.

## Registries (tiered)

Discovery queries real, reputable registries — no self-built index. Each source carries a **tier** that doubles as its reputation signal, and official sources always outrank curated ones.

- **Tier 1 — official:** the MCP registry and the Anthropic plugin marketplace.
- **Tier 2 — curated:** PulseMCP.

Every registry adapter is best-effort: on any failure it contributes no candidates and the search continues, so a web-denied environment degrades to an empty result, never a crash.

## Permission & safety invariants

- Installs are **human-approved, never silent** — the PreToolUse gate fails closed without an approval record.
- Plugin installs use the **marketplace-install path only** (no seed, copy or `--plugin-dir`).
- Web discovery respects any web-deny posture; sources are surfaced to the Human before install.
- Approval is per candidate.

## Attachment — which agent gets the capability

Hot-load loads a cheatcode into the session; *attachment* decides which agent can use it. It is kind-dependent and never violates the prompt-surface review policy (agent, skill, command and CLAUDE.md edits are Human-reviewed, never silently merged upstream). Materialization writes the **user project's `.claude/` only — never the plugin repo**.

| Kind | Attachment |
|---|---|
| **plugin (skill-contributing)** | The marketplace install loads its skills; a restricted target agent also gets the name in its `skills:` allowlist. |
| **plugin (tool-contributing)** | A plugin that provides a built-in tool grants that tool to the target agent's `tools:` allowlist. |
| **MCP toolkit** | Registering the server is the attachment: its tools are callable by any agent. |
| **standalone skill** | Added to the target agent's `skills:` frontmatter, through a project-local copy of the agent file; a bro target gets a project `CLAUDE.md` reference instead. |

Prefer plugin and MCP kinds. Every attachment is recorded in the trajectory DB so uninstall can reverse exactly what was wired.

## Teardown — uninstall

Acquisition must be reversible. Uninstall reverses an install in one transaction:

- It reverses each recorded attachment, removes the artifact through the marketplace or MCP uninstall path (no manual file deletion), deletes the rows and audits the removal.
- **Idempotent:** removes whatever is present, no-ops on what isn't.
- **Honesty gate:** if teardown fails, the row stays and is marked broken, and the result says it was not uninstalled rather than claim a clean removal.

Removal is safer than addition, so uninstall is **bro-proposed + Human-confirmed**, not PreToolUse-gated. If an open task depends on the cheatcode, surface that before removing.

## Testing mandate

Each capability ships with tests at every level its change reaches — unit tests per tool handler, integration tests for new hooks and engines, workflow simulations for composites, and a journey row for the real flow — with the network and registries stubbed deterministically: assert audit rows and approval-gate behavior, never live results.
