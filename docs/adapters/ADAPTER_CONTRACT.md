# Platform Adapter Contract

The normative standard every TMB platform adapter must satisfy. Claude Code is the reference adapter and ships today; the OpenAI Codex adapter is in progress (GH 1151); Cursor, OpenCode, and Gemini CLI follow when demand justifies them.

This document owns the **rules**. [`../reference/MULTI_PLATFORM.md`](../reference/MULTI_PLATFORM.md) owns the **strategy** — why TMB is single-repo with thin per-platform manifests, what is already portable, and when an adapter gets built. Read that for context; conform to this.

**MUST**, **MUST NOT**, and **SHOULD** carry their RFC 2119 force. A pull request that breaks a MUST is non-conformant and is rejected on that ground alone, regardless of how good the rest of it is. A SHOULD may be traded away with a rationale recorded in the pull request and in the adapter's parity matrix.

## 1. Scope & definitions

Two terms carry the whole document.

**Protected core.** The parts of TMB that exist once, mean the same thing on every host, and are not an adapter's to change:

- The **doctrine chain** — Human → bro → SWE with bro as the task gate and pr-reviewer as the push gate.
- The **trajectory DB schema** — [`../../mcp/trajectory-server/src/schema.sql`](../../mcp/trajectory-server/src/schema.sql) and its migrations.
- The **MCP tool contracts** — tool names, argument shapes, role scoping, and return shapes served by `mcp/trajectory-server/`.
- The **shared skills and agent-persona bodies** — `skills/*/SKILL.md`, the prose bodies of `agents/*.md`, and `templates/agents/*.md`.
- The **world model** — the kuzu graph, its node/edge shape, and the scan that populates it.

**Adapter.** The per-platform edge, and nothing more:

- The host's plugin **manifest** (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and their peers).
- The host's **hook wiring** — event names, the decision protocol, and the per-host hook config that maps doctrine gates onto native events.
- The host's **persona file** (`CLAUDE.md`, `CODEX.md`, `CURSOR.md`, `GEMINI.md`) — the bro doctrine expressed in that host's tool grammar and trigger mechanism.
- The host's **state-location config** — where TMB writes the trajectory DB, the world model, and worktrees on that host.

Everything an adapter needs to change lives in that second list. If a change seems to require touching the first list, it is a core change: file it as core work under its own issue, land it as core, and let every adapter inherit it.

## 2. Rule 1 — Core invariance (MUST)

**Adapter development MUST NOT change core functionality or philosophy.** Adapters consume the core; they never fork it. Bringing up a new host is a translation exercise, not a redesign: if a doctrine step is awkward on your host, the answer is a declared degradation (rule 4), a new capability flag (rule 5), or a core change proposed on its own merits — never a quiet local variant.

This rule is mechanized, not left to reviewer vigilance. **Every adapter pull request MUST keep the full Claude Code test suite green** — L0–L4, plus L6 where the change touches a surface the chain exercises. CI enforces no-cross-host regression: the reference host's suite is the tripwire that catches an adapter reaching into shared code. A red Claude suite on an adapter pull request is a non-conformance, and "it only affects my host" is not a defence — if that were true, the reference suite would still be green.

## 3. Rule 2 — Adapter isolation (MUST)

**No adapter may create, modify, or depend on another adapter's environment.** Installing, running, or breaking the Codex adapter MUST leave a Claude Code user's setup untouched, and the reverse holds identically.

Concretely, in both directions:

- Codex-adapter code MUST NOT create, read, write, or delete anything under `~/.claude` or a project's `.claude/`.
- Claude Code adapter code MUST NOT create, read, write, or delete anything under `~/.codex`, `.codex/`, `.agents/`, or `.tmb/`.
- The same ban extends to every future adapter for every other adapter's directories. The list above enumerates today's hosts; the rule is general.

**Host-specific side effects MUST sit behind an explicit runtime-context host check.** A module decides what host it is running under at call time, from the runtime context, and only then touches a host directory. **Module-import-time side effects are forbidden** — a top-level `mkdir` of a host directory, a directory probe that creates on miss, or any filesystem write that happens merely because a file was imported. Importing a module MUST be inert. This matters most for shared code that both adapters load: an import-time `mkdir` in a shared path plants one host's directory in the other host's project the moment the module is pulled in, and no amount of downstream branching undoes it.

## 4. Rule 3 — Env compatibility (MUST)

**TMB state MUST live in the location the host prescribes.** Under Claude Code that is `.claude/<plugin>/` inside the project; under Codex it is `<project>/.tmb/<plugin>/`. An adapter that hardcodes another host's path — or that reaches for a single global location shared across hosts — is non-conformant.

**The trajectory DB DDL MUST be byte-identical on every host.** There is exactly one `schema.sql`. No per-host DDL fork, no host-conditional columns, no "Codex also needs this table" branch. The database that a Claude Code session writes and the database that a Codex session writes have the same shape, so the same migrations, the same MCP handlers, and the same tooling operate on both. Only the *path* to the file varies by host; its *contents* do not.

**Refinement — naming follows the host, writes follow permission.** Config and manifest surfaces adopt the host's naming convention, because that is how the host discovers them. Writable state goes wherever the host actually permits writes, which is not always the host's own directory. Codex is the worked example: it mounts `.codex/` and `.agents/` read-only to the agent, so TMB state cannot live there — hence `<project>/.tmb/<plugin>/`. The host's convention decides the *name*; the host's permission model decides the *place*.

## 5. Rule 4 — Enforcement parity matrix (MUST)

**Every load-bearing gate MUST carry a per-adapter disposition** on a three-tier ladder:

| Tier | Mechanism | When to use it |
|---|---|---|
| **Tier 1** | Server-side gate in the MCP server | Preferred. Every host that speaks MCP inherits it for free, so a Tier-1 gate needs porting exactly zero times. |
| **Tier 2** | Host-native hook or rule | For interception the server cannot see — a shell command about to run, a file about to be written. |
| **Tier 3** | **Declared** degradation, with rationale | When the host cannot express the gate at all. The gate is documented as absent, with what it would have caught and what compensates. |

**Silently skipping a doctrine step is non-conformant. A documented degradation is acceptable.** The failure mode this rule exists to prevent is an adapter that looks compliant because nobody wrote down what it does not enforce. A Tier-3 row is an honest adapter; a missing row is a broken one.

Each adapter MUST publish its own filled-in copy of this table, one row per load-bearing gate:

| Gate | What it enforces | Tier on this host | Mechanism | Notes / degradation rationale |
|---|---|---|---|---|
| `git-push-guard` | Push to a protected branch is refused unless every unsigned commit carries a passing `validation_attempts` row — the pr-reviewer push gate | Tier 2 | PreToolUse hook on the shell tool, inspecting the `git push` command line | Needs command-line interception, so a host without deny-capable pre-tool hooks drops to Tier 3 |
| `swe-verification-gate` | SWE's `task_update_status(completed)` runs the task's typed `verification[]` commands in the worktree and is denied on any non-zero exit | Tier 2 | PreToolUse hook on the MCP status-update tool | Candidate for Tier 1 promotion — the server knows the task's `verification[]` |
| Spawn contract (`task_id` required) | A SWE spawn names a real pending task with a non-empty `spec_body`; no free-form SWE dispatch | Tier 2 | PreToolUse hook on the subagent-spawn tool | Hosts without a spawn-time interception point declare Tier 3 and rely on the server rejecting SWE tool calls that name no task |
| pr-reviewer read-only | The push gate reviews but cannot edit — its verdict is independent of the diff it judges | Tier 2 | Per-agent tool restriction at spawn: the pr-reviewer definition excludes the write and edit tools | Requires per-agent tool restriction (rule 5); a host lacking it declares Tier 3 with prompt-level read-only instruction as the sole barrier |

Adapters add rows for every other gate their host must cover. [`../prompt-engineering/ENFORCEMENT.md`](../prompt-engineering/ENFORCEMENT.md) is the reference host's full inventory of enforced interactions and is the natural source list when filling this table in.

## 6. Rule 5 — Capability declaration, not host-sniffing (MUST)

**Adapters declare host capabilities; core code branches on capability, never on host name.** A conditional that reads "if the host is Codex" is non-conformant even when it happens to be correct — it hardcodes today's host roster into shared code and forces an edit to that code for every host added later. The conformant shape is "if the host cannot deny at pre-tool time", which the next host answers by declaring a flag.

Every adapter MUST declare this initial capability set:

| Capability | Meaning |
|---|---|
| Deny-capable pre-tool hooks | The host can intercept a tool call before it runs and refuse it. |
| Per-agent tool restriction | The host can constrain which tools a given agent may call, enforced at spawn. |
| Structured-question UI | The host offers a native discrete-choice prompt for the Human, not just free-form chat. |
| Subagent spawn with per-child config | The host can spawn a subagent and give that child its own model, tools, and prompt. |
| Native worktree isolation | The host provides isolated per-task working trees, rather than TMB constructing them. |
| Writable project-state dir | The host permits the agent to write to a project-local state directory (rule 3). |
| Trusted human-input signal | The host distinguishes input that genuinely came from the Human from text an agent produced. |

The list grows as hosts reveal new axes of difference. Adding a capability is a core change: add the field, give every existing adapter an honest value, and update the code that branched on the old assumption.

## 7. Rule 6 — Single source, edge translation (MUST)

**Skill bodies, agent personas, and doctrine prose exist exactly once, in the shared tree.** Adapters translate only at the edge: manifests, filenames, tool-name grammar, hook event names.

**A pull request that copies shared content into an adapter directory MUST be rejected.** Duplication is the failure this repo's whole structure is built to avoid — the moment a skill body exists twice, the two copies drift, and hosts start behaving differently for reasons nobody chose. When shared content does not fit a host, the fix is to make the shared content host-neutral, or to add an edge translation that rewrites it mechanically at load time. It is never a second copy with edits.

## 8. Rule 7 — Version lockstep (MUST)

**All adapter manifests MUST carry the same plugin version, and the version-bump tooling MUST update every adapter manifest in one atomic operation.** `scripts/maintenance/bump-version.sh` is that tooling; adding an adapter means adding its manifest to the bump script's list in the same pull request that adds the manifest.

**No adapter ships a version the others do not have.** Version numbers identify a state of the shared core, and the core is shared, so a per-host version tells users something false about what they are running. An adapter that cannot support a release ships that release with a declared Tier-3 degradation (rule 4), not with a lagging version number.

## 9. Rule 8 — Host-agnostic identity (SHOULD, until server tokens land)

**Role enforcement SHOULD NOT depend on a host-specific identity channel.** The server decides what bro may do and what SWE may do, so the server needs to know who is calling — and today it knows because the caller says so. That is a host-shaped, spoofable arrangement, and the durable fix is server-verified spawn tokens issued at spawn and checked on every call.

Until those tokens exist, **each adapter MUST document its identity mechanism and its spoofing surface in the parity matrix**: how a caller's role is asserted on that host, what an agent would have to do to claim a role it does not hold, and what else would have to fail for that to cause harm. This is the one rule stated as a SHOULD, because the conformant mechanism is not yet available to conform to. The documentation requirement inside it is a MUST.

## 10. Rule 9 — Conformance is a passing run (MUST)

**An adapter is conformant when the adapter-parameterized conformance suite passes** — not when a reviewer is satisfied. Sign-off by judgment does not survive contributor turnover, and it is exactly what rule 1 mechanizes away for the reference host.

That suite is planned as WS7 of the v1.1.0 program. Until it exists, the following manual checklist applies, and **an adapter pull request MUST walk it item by item in its description**, naming the evidence for each:

- [ ] **Rule 1 — Core invariance.** Full Claude Code suite green (L0–L4, plus L6 where the change touches an exercised surface); the diff touches no protected-core path.
- [ ] **Rule 2 — Adapter isolation.** No reference to another host's directories anywhere in the diff, in either direction; no module-import-time filesystem side effect.
- [ ] **Rule 3 — Env compatibility.** State resolves to the host-prescribed writable location; `schema.sql` is unchanged, or changed once for all hosts.
- [ ] **Rule 4 — Parity matrix.** Every load-bearing gate has a row with a tier; every Tier-3 row carries a rationale.
- [ ] **Rule 5 — Capability declaration.** All seven capability fields declared with honest values; no host-name branch introduced in shared code.
- [ ] **Rule 6 — Single source.** No shared skill, persona, or doctrine prose copied into an adapter directory.
- [ ] **Rule 7 — Version lockstep.** The new manifest carries the current version and is registered with the bump tooling.
- [ ] **Rule 8 — Identity.** Identity mechanism and spoofing surface documented in the parity matrix.

## 11. Rule 10 — Security-delta disclosure (MUST)

**Each adapter MUST document where its host is weaker than the reference host.** TMB's value proposition is enforcement in code rather than convention, so a host that enforces less delivers less — and users are entitled to know which guarantees they actually have. An undisclosed weakness is worse than a disclosed one, because it is priced as a guarantee.

The Codex adapter's disclosure, as an illustration of the expected specificity:

- Codex hooks are officially described as a **guardrail, not a complete enforcement boundary** — the host does not promise that every path to a side effect passes through a hook.
- Codex applies a **per-hash hook trust ceremony**: hooks are inert until the user trusts that exact hook content, so a fresh install enforces nothing until the ceremony is completed, and any edit to a hook re-arms the requirement.
- Codex `PreToolUse` offers **no ask-or-escalate decision** — the host can allow or deny, but cannot hand a borderline call to the Human, so gates that would prefer to ask must choose one side in advance.

Each such delta is paired, in the parity matrix, with the tier it forces and whatever compensates for it.

## See also

- [`../reference/MULTI_PLATFORM.md`](../reference/MULTI_PLATFORM.md) — the multi-platform strategy: repo structure, what is already portable, when adapters get built.
- [`../prompt-engineering/ENFORCEMENT.md`](../prompt-engineering/ENFORCEMENT.md) — the reference host's enforcement layers and full coverage matrix; the source list for a parity matrix.
- [`../architecture/RESPONSIBILITIES.md`](../architecture/RESPONSIBILITIES.md) — the doctrine chain's role boundaries, which every adapter reproduces.
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) — how to get an adapter pull request reviewed and merged.
