# Codex adapter parity declaration

This declaration is required by the
[Platform Adapter Contract](../ADAPTER_CONTRACT.md). It describes what the
Codex adapter enforces today and where it still differs from the Claude Code
workflow.

**Declaration date:** 2026-08-26

**Implemented scope:** Scope 5, bounded repository-write Hook

**Reference adapter:** Claude Code

## What ships

The Codex package selects one synchronous `PreToolUse` dispatcher, exactly two
explicit-only Skills, and an immutable 15-tool MCP registry.

- `$tmb:tmb-bro` uses 13 project-local tools for inventory, scanning, world-model
  reads, label taxonomy, local planning Issues, and Bro-authored discussions.
- `$tmb:tmb-agent-setup` uses `agent_materialization_get` and
  `agent_materialization_set` to manage two fixed files:
  `.codex/agents/tmb_swe.toml` and
  `.codex/agents/tmb_pr_reviewer.toml`.

The manifest also declares an empty `commands` surface. This prevents Codex
from migrating the plugin's Claude commands into `source-command-*` Skills.
Because both package Skills disable implicit invocation, a generic model-visible
Skill list may omit them; package inspection plus direct namespaced invocation
is the acceptance contract.

Every MCP call requires a canonical Git worktree root whose `.tmb/` state is
ignored and untracked. Planning state remains below `<project>/.tmb/tmb/`.
Agent setup is the only exception to that state boundary, and it can touch only
the two fixed `.codex/agents` targets.

The Hook runtime is a zero-dependency Node ESM pair loaded from the installed
plugin cache. Its manifest pins the two runtime files by SHA-256, wraps the
complete launcher in a 4-second deny watchdog, and leaves Codex's hard process
timeout at 5 seconds. The manifest resolves a host Node launcher to
`process.execPath`, rejects checkout- and plugin-local shims, then starts the
dispatcher with a minimal environment. A primary checkout gets a strict read-only command allowlist
that rejects shell expansion, long-lived read modes, and helper-spawning flags.
A branch-backed linked worktree additionally permits canonical `apply_patch`
targets inside the current root and a small set of non-interactive validation
entrypoints. Git/forge writes, direct write tools, persistent command receivers,
follow-up stdin, unknown tools, malformed input, and digest drift fail closed.
`permission_mode=bypassPermissions` does not relax this policy.
Shell execution accepts only the observed exact `Bash {command: string}` shape.
TMB MCP names must match one of three exact observed host prefixes and their
canonical `project_root` must match the current branch-backed checkout. Because
the Hook event has no separate provider-identity field, the policy denies these
calls whenever a project-level `.codex/config.toml` could shadow the bundled
server. User and enterprise host configuration remains a trusted boundary.

The materializer recognizes two safe per-file states: absent and an exact match
for the current built-in bytes. Every other regular-file value is a conflict.
It rejects symlinks and unexpected file types, never force-overwrites a
conflict, preserves third-party Agents, and reports a partial result if one
managed target changes before a later failure. Scope 4 does not include
historical-template upgrades, a process lock, rollback, fsync, or crash
recovery.

## Agent capability boundary

`tmb_swe` and `tmb_pr_reviewer` are native Codex custom Agents that become
discoverable in a new task after setup. They are not TMB workflow principals.
Their names do not authenticate a role, and they cannot create TMB tasks,
validation records, audit entries, or delivery state.

The names intentionally reuse familiar role labels, but the persona bodies are
separately authored for this narrower Codex surface. They are standalone
adapter personas, not edited copies or translations of the shared workflow
principals in `agents/swe.md` and `agents/pr-reviewer.md`. Those shared Agents
assume task lifecycle, isolated worktrees, validation records, and delivery
gates that Scope 4 does not expose. A later scope must move Codex to a shared
host-neutral source or mechanical edge translation before granting either
Agent workflow authority.

Both templates define a disabled ordinary MCP entry named `trajectory-server`.
It shadows the plugin-provided server in the Agent configuration layer without
depending on a Marketplace ID. Codex requires a complete transport shape even
for a disabled entry, so the template uses inert `node --version` metadata.
Live testing on CLI `0.146.0` and `0.147.0` hid the TMB tools with this shape.
Both Agents still inspect their live tool list before repository access. If a
TMB tool is visible they return `BLOCKED_TMB_MCP_ISOLATION` without continuing.
The self-check is prompt-level defense in depth, not a machine-enforced server
gate.

Neither template fixes a model or reasoning effort. `tmb_swe` requests
`workspace-write` and works from a
complete, path-bounded brief in the current worktree. `tmb_pr_reviewer` requests
`read-only`, reviews a caller-specified diff, and returns advisory findings.

The parent task may override an Agent's sandbox setting. Other MCP servers may
also remain available. For those reasons the reviewer never returns `PASS`,
never creates trusted review evidence, and never acts as a Push gate. Its
non-blocking verdict is `NO_BLOCKING_FINDINGS`, with the permission caveat
included in the response.

## MCP surface

The complete allowlist is:

1. `runtime_initialize`
2. `project_inventory`
3. `project_scan`
4. `world_model_get`
5. `world_model_search`
6. `planning_label_taxonomy_get`
7. `planning_label_taxonomy_set`
8. `planning_issue_create`
9. `planning_issue_get`
10. `planning_issue_list`
11. `planning_issue_resume`
12. `planning_discussion_append`
13. `planning_discussion_list`
14. `agent_materialization_get`
15. `agent_materialization_set`

Closed schemas, deterministic identity-field rejection, fixed Bro arguments,
canonical project routing, safe state paths, local-only Issue creation, and the
fixed Agent catalog are machine-enforced. Skill sequencing, the SWE brief
contract, reviewer behavior, and most Git boundaries are prompt instructions,
not server gates.

## Capability declaration

| Capability | Codex value | Current use and limitation |
|---|---|---|
| Functional lifecycle Hooks | **Partial** | Scope 5 ships one repository-write `PreToolUse` dispatcher. It is not a task, review, or Push lifecycle gate. |
| Explicit project-local Skills | **Yes** | Exactly `$tmb:tmb-bro` and `$tmb:tmb-agent-setup`; both set `allow_implicit_invocation: false`. A generic model-visible list may omit them, so acceptance uses package inspection and direct invocation. |
| Project-level custom Agents | **Yes, explicit setup** | Setup can materialize exactly `tmb_swe` and `tmb_pr_reviewer`; Bro does not spawn them. |
| Per-Agent sandbox default | **Yes, overridable** | SWE requests `workspace-write`; reviewer requests `read-only`. Parent permissions remain authoritative. |
| Per-Agent TMB MCP isolation | **Static same-name MCP shadow** | Both templates define `mcp_servers."trajectory-server"` as disabled with inert transport metadata. Live child tool-surface checks remain required. |
| Authenticated workflow role | **No** | Agent names are labels. No server-issued role or Human-provenance token exists. |
| Native worktree isolation | **Desktop-only host feature** | Scope 4 does not create, switch, or clean worktrees. SWE operates in the worktree supplied by the caller. |
| Writable project state | **Yes** | Planning state is confined to ignored `.tmb/tmb`; setup manages only two `.codex/agents` paths. |
| Trusted validation or Push gate | **No** | Reviewer output is advisory and never becomes a TMB validation record. |
| Primary checkout source-write gate | **Yes, bounded** | Unknown/write-capable tool shapes fail closed; reviewed read-only commands and the fixed TMB MCP surface remain available. |
| Linked-worktree patch containment | **Yes for canonical `apply_patch`** | Targets must remain inside a branch-backed linked worktree and avoid protected paths and symlinks. Approved test scripts still rely on the host sandbox. |

## Enforcement parity

| Gate | Current tier | Current behavior |
|---|---:|---|
| Project-state ignore and containment | Tier 1 | Every MCP call validates the canonical Git root and ignored, untracked `.tmb/` state before proceeding. |
| Local-only planning writes | Tier 1 | Public schemas omit identity/provenance fields, wrappers inject Bro authorship, and Issue sync is forced off. |
| Agent target allowlist | Tier 1 | The setter accepts no path, Agent name, or content input; only two catalog targets are reachable. |
| Conflict and path safety | Tier 1 within the single-process contract | Unknown bytes, symlinks, directories, and non-regular targets fail closed. Same-user TOCTOU resistance beyond exclusive create remains deferred. |
| Agent MCP isolation | Tier 2 for tested hosts and the fixed server name | CLI `0.146.0` and `0.147.0` hid the server in live testing. Agent prompts stop if a TMB tool is visible. A future server rename, host config-composition change, and the prompt-level self-check remain outside a hard server gate. |
| SWE scope, branch, and Git-delivery rules | Tier 3 | Developer instructions require a complete brief and protected-branch refusal. No Hook or workflow gate enforces those instructions. |
| Reviewer read-only and independence | Tier 3 | Read-only is a default the parent may override. The reviewer is advisory and cannot return `PASS`. |
| Agent role separation | Tier 3 | The two prompts describe different duties, but neither Agent has authenticated TMB role identity. |
| Primary source-write isolation | Tier 1 for observed Hook surfaces | `apply_patch`, shell redirection or expansion, interpreters, wrappers, package commands, direct writes, checkout-local or common-shim executables, device/FIFO content reads, long-lived/helper-spawning read flags, and unknown payloads deny before execution. Git queries require the no-pager, no-optional-locks, no-lazy-fetch, fsmonitor-off shape. This is not an OS-level filesystem boundary. |
| Linked `apply_patch` containment | Tier 1 within the Hook TOCTOU boundary | Every source and move target is checked against the canonical linked root; protected, absolute, parent, symbolic-link, hard-linked-file, detached, and unparseable paths deny. |
| Git and forge mutation isolation | Tier 1 for direct Hook-visible commands | Git/forge writes and unsafe wrappers deny in every checkout. An approved child process still depends on the host sandbox. |
| Persistent receiver isolation | Tier 1 for observed startup surfaces | Bare shells, REPLs, TTY/session shapes, and `write_stdin` deny. Model-driven collaboration spawn also denies until child Hook inheritance is proved. |
| Branch/worktree orchestration | Tier 3 | No creation, freshness, isolation, or cleanup workflow ships. |
| Task lifecycle and validation records | Tier 3 | Task, status, retry, close, audit, and validation handlers remain absent from the Codex registry. |
| Commit, push, PR, merge, and remote Issue gates | Tier 3 | Scope 5 blocks direct Hook-visible mutations but provides no delivery operation, review proof, or lifecycle gate. Repository protection remains external. |

## Identity and spoofing

The MCP server has no authenticated Human or multi-role signal. Scope-3 planning
writes stay bounded because the public schemas reject caller-supplied identity
and the wrappers inject only the fixed Bro label. That label limits the reachable
authority; it does not prove who called the tool.

The two materialized Agent names carry no server authority at all. On the
tested host baseline, the disabled same-name shadow removes the direct TMB
write path. A later scope must add server-verifiable role identity before exposing
task or validation writes to Codex Agents.

## Security differences from Claude Code

| Difference | Consequence |
|---|---|
| Hook visibility is limited to host tool calls | The dispatcher cannot prove every write performed by an approved validation script or its descendants. |
| Plugin Hook trust is definition-bound | A load-bearing runtime update requires the user to trust the changed Hook again; before that, enforcement is inactive. |
| Model-driven child Hook inheritance is unproved | The observed `collaborationspawn_agent` surface is denied instead of being treated as safe. |
| Parent tasks can override Agent sandbox settings | Reviewer read-only cannot be treated as proven independence. |
| No authenticated workflow permission layer exists | The command allowlist limits direct tool calls, but Agent identity and workflow authority remain advisory. |
| Fixed MCP server name in generated TOML | Isolation depends on the plugin continuing to expose the server as `trajectory-server`; each Agent checks the live tool surface and stops if that assumption fails. |
| Plugin-scoped overrides are unreliable | [openai/codex#35289](https://github.com/openai/codex/issues/35289) documents a related CLI `-c` override failure for plugin-provided MCP servers. It does not reproduce the custom-Agent same-name shadow used here, which remains an empirically tested compatibility behavior rather than a documented Codex guarantee. |
| No Agent authentication | `tmb_swe` and `tmb_pr_reviewer` cannot safely receive TMB workflow-write authority. |
| No lock, rollback, or crash recovery | Setup is single-user and single-process by contract; races or interruption can leave `mixed` or `conflict` state for explicit recovery. |
| No historical template catalog | Any old or edited managed file is a conflict, not an automatic upgrade candidate. |
| Native worktrees are not portable across Codex surfaces | Scope 4 neither promises nor orchestrates isolated execution. |

## Verification evidence

Automated evidence must include exact 2-Skill and 15-tool assertions, catalog
hash checks, TOML parsing, conflict/path/fault-injection tests, installed-cache
cold boot without source `node_modules`, Scope-3 planning regression, and the
full Claude test gate. Scope 5 additionally requires dispatcher digest, payload,
malformed/oversize, primary sentinel, linked containment, persistent receiver,
Git/forge, installed-cache and latency checks. The local Agent performance harness measures absent, current,
and conflict getter paths with one cold sample, 10 discarded warm-ups, and 100
recorded warm samples per state.

Supported-host acceptance is limited to Codex CLI and Desktop on macOS arm64
for this scope. CLI `0.146.0` and `0.147.0` have live evidence for the same-name
shadow; Desktop remains a separate host gate. Each record must include a fixed
implementation SHA, Codex version, plugin
source, template hashes, setup confirmation, new-task Agent discovery, SWE and
reviewer behavior, MCP isolation, removal, and preservation of a third-party
Agent. Each host record must include the child Agent's observed tool surface.
IDE, cloud,
and other operating-system claims remain unverified.

The fixed-SHA acceptance record is added after the implementation commit exists;
it must not be inferred from `tools/list`, template presence, or automated tests
alone.

The repeatable host-version gate lives in
[`CODEX_PORT.md`](../../contributing/CODEX_PORT.md#scope-4-host-version-compatibility-gate).
It revalidates child MCP isolation and managed-Agent lifecycle for a specific
host version. Passing it is necessary but not sufficient for a full support
claim; the fixed-SHA acceptance record above still applies. Static TOML checks
do not establish child MCP isolation.

## Sources and maintenance

- [OpenAI Codex plugin Skills](https://developers.openai.com/codex/plugins/skills)
- [OpenAI Codex Skills](https://developers.openai.com/codex/skills)
- [OpenAI Codex subagents](https://developers.openai.com/codex/subagents)
- [OpenAI Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [`SCOPE_5_PRD.md`](./SCOPE_5_PRD.md)
- [Codex issue #35289: CLI overrides ignored for plugin MCP servers](https://github.com/openai/codex/issues/35289)
- [`hooks/codex/hooks.json`](../../../hooks/codex/hooks.json)
- [`CODEX_PORT.md`](../../contributing/CODEX_PORT.md)

Update this declaration in the same pull request that changes a Codex
capability, exposes another workflow surface, or adds a functional Codex Hook.
Adapter-doctrine changes require maintainer review and must not be auto-merged;
see [`CONTRIBUTING.md`](../../../CONTRIBUTING.md#platform-adapters).
