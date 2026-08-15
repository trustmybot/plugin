# Codex adapter parity declaration

This declaration is required by the
[Platform Adapter Contract](../ADAPTER_CONTRACT.md). It describes what the
Codex adapter enforces today and where it still differs from the Claude Code
workflow.

**Declaration date:** 2026-08-15

**Implemented scope:** Scope 4, explicit project-Agent materialization

**Reference adapter:** Claude Code

## What ships

The Codex package selects an empty Hook manifest, exactly two explicit-only
Skills, and an immutable 15-tool MCP registry.

- `$tmb-bro` uses 13 project-local tools for inventory, scanning, world-model
  reads, label taxonomy, local planning Issues, and Bro-authored discussions.
- `$tmb-agent-setup` uses `agent_materialization_get` and
  `agent_materialization_set` to manage two fixed files:
  `.codex/agents/tmb_swe.toml` and
  `.codex/agents/tmb_pr_reviewer.toml`.

Every MCP call requires a canonical Git worktree root whose `.tmb/` state is
ignored and untracked. Planning state remains below `<project>/.tmb/tmb/`.
Agent setup is the only exception to that state boundary, and it can touch only
the two fixed `.codex/agents` targets.

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

Both templates disable the bundled trajectory server under the static
development plugin identity `tmb@trustmybot-local`. Neither template fixes a
model or reasoning effort. `tmb_swe` requests `workspace-write` and works from a
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
| Functional lifecycle Hooks | **No** | The selected Codex Hook manifest is empty. No activation, source-edit, Git, review, or Push gate ships. |
| Explicit project-local Skills | **Yes** | Exactly `$tmb-bro` and `$tmb-agent-setup`; both set `allow_implicit_invocation: false`. |
| Project-level custom Agents | **Yes, explicit setup** | Setup can materialize exactly `tmb_swe` and `tmb_pr_reviewer`; Bro does not spawn them. |
| Per-Agent sandbox default | **Yes, overridable** | SWE requests `workspace-write`; reviewer requests `read-only`. Parent permissions remain authoritative. |
| Per-Agent TMB MCP isolation | **Static development identity only** | Both templates disable `plugins."tmb@trustmybot-local".mcp_servers."trajectory-server"`. Other plugin identities are not claimed. |
| Authenticated workflow role | **No** | Agent names are labels. No server-issued role or Human-provenance token exists. |
| Native worktree isolation | **Desktop-only host feature** | Scope 4 does not create, switch, or clean worktrees. SWE operates in the worktree supplied by the caller. |
| Writable project state | **Yes** | Planning state is confined to ignored `.tmb/tmb`; setup manages only two `.codex/agents` paths. |
| Trusted validation or Push gate | **No** | Reviewer output is advisory and never becomes a TMB validation record. |

## Enforcement parity

| Gate | Current tier | Scope-4 behavior |
|---|---:|---|
| Project-state ignore and containment | Tier 1 | Every MCP call validates the canonical Git root and ignored, untracked `.tmb/` state before proceeding. |
| Local-only planning writes | Tier 1 | Public schemas omit identity/provenance fields, wrappers inject Bro authorship, and Issue sync is forced off. |
| Agent target allowlist | Tier 1 | The setter accepts no path, Agent name, or content input; only two catalog targets are reachable. |
| Conflict and path safety | Tier 1 within the single-process contract | Unknown bytes, symlinks, directories, and non-regular targets fail closed. Same-user TOCTOU resistance beyond exclusive create remains deferred. |
| Agent MCP isolation | Tier 2 for the static identity | Generated TOML disables the TMB server, but a different installed plugin identity is outside the current claim. |
| SWE scope, branch, and Git-delivery rules | Tier 3 | Developer instructions require a complete brief and protected-branch refusal. No Hook or workflow gate enforces those instructions. |
| Reviewer read-only and independence | Tier 3 | Read-only is a default the parent may override. The reviewer is advisory and cannot return `PASS`. |
| Agent role separation | Tier 3 | The two prompts describe different duties, but neither Agent has authenticated TMB role identity. |
| Branch/worktree orchestration | Tier 3 | No creation, freshness, isolation, or cleanup workflow ships. |
| Task lifecycle and validation records | Tier 3 | Task, status, retry, close, audit, and validation handlers remain absent from the Codex registry. |
| Commit, push, PR, merge, and remote Issue gates | Tier 3 | Scope 4 provides no delivery operation or lifecycle Hook. Repository protection remains external. |

## Identity and spoofing

The MCP server has no authenticated Human or multi-role signal. Scope-3 planning
writes stay bounded because the public schemas reject caller-supplied identity
and the wrappers inject only the fixed Bro label. That label limits the reachable
authority; it does not prove who called the tool.

The two materialized Agent names carry no server authority at all. Disabling the
trajectory server removes the direct TMB write path under the supported static
identity. A later scope must add server-verifiable role identity before exposing
task or validation writes to Codex Agents.

## Security differences from Claude Code

| Difference | Consequence |
|---|---|
| No functional Codex Hooks ship | Native shell, edit, Git, and external MCP paths are outside TMB enforcement. |
| Parent tasks can override Agent sandbox settings | Reviewer read-only cannot be treated as proven independence. |
| No documented Claude-style per-tool allowlist is used | Prompt rules remain advisory outside the fixed TMB MCP disablement. |
| Static plugin identity in generated TOML | MCP isolation is claimed only for `tmb@trustmybot-local`. |
| No Agent authentication | `tmb_swe` and `tmb_pr_reviewer` cannot safely receive TMB workflow-write authority. |
| No lock, rollback, or crash recovery | Setup is single-user and single-process by contract; races or interruption can leave `mixed` or `conflict` state for explicit recovery. |
| No historical template catalog | Any old or edited managed file is a conflict, not an automatic upgrade candidate. |
| Native worktrees are not portable across Codex surfaces | Scope 4 neither promises nor orchestrates isolated execution. |

## Verification evidence

Automated evidence must include exact 2-Skill and 15-tool assertions, catalog
hash checks, TOML parsing, conflict/path/fault-injection tests, installed-cache
cold boot without source `node_modules`, Scope-3 planning regression, and the
full Claude test gate. The local performance harness measures absent, current,
and conflict getter paths with one cold sample, 10 discarded warm-ups, and 100
recorded warm samples per state.

Supported-host acceptance is limited to macOS arm64 Codex CLI and Desktop for
this scope. It must record a fixed implementation SHA, Codex version, plugin
source, template hashes, setup confirmation, new-task Agent discovery, SWE and
reviewer behavior, MCP isolation, removal, and preservation of a third-party
Agent. IDE, cloud, and other operating-system claims remain unverified.

The fixed-SHA acceptance record is added after the implementation commit exists;
it must not be inferred from `tools/list`, template presence, or automated tests
alone.

## Sources and maintenance

- [OpenAI Codex plugin Skills](https://developers.openai.com/codex/plugins/skills)
- [OpenAI Codex Skills](https://developers.openai.com/codex/skills)
- [OpenAI Codex subagents](https://developers.openai.com/codex/subagents)
- [OpenAI Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [`hooks/codex/hooks.json`](../../../hooks/codex/hooks.json)
- [`CODEX_PORT.md`](../../contributing/CODEX_PORT.md)

Update this declaration in the same pull request that changes a Codex
capability, exposes another workflow surface, or adds a functional Codex Hook.
Adapter-doctrine changes require maintainer review and must not be auto-merged;
see [`CONTRIBUTING.md`](../../../CONTRIBUTING.md#platform-adapters).
