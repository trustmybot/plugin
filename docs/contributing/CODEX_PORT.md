# Codex port guardrails

These are hard constraints for every Codex contribution.

The adapter's current contract declaration is maintained in
[`../adapters/codex/PARITY.md`](../adapters/codex/PARITY.md). Any change to a
Codex capability or exposed surface must update that declaration in the same
pull request.

1. **Port, do not fork the product.** Codex is a thin adapter over TMB's shared implementation. Shared behavior remains the source of truth; platform-specific code belongs at the package, dispatch, and host-contract edges.
2. **Claude behavior is protected.** A Codex change must not alter Claude's manifest, root `.mcp.json`, hook contract, entry point, tool registry, state paths, or runtime behavior unless a separately scoped cross-platform change is explicitly approved and validated for Claude.
3. **Expose only completed Codex surfaces.** Do not make Claude tools, skills, agents, or hooks visible in Codex merely because the underlying files exist. Each surface needs an explicit port and its own compatibility evidence.
4. **Keep state project-bound.** Codex runtime state requires an explicit canonical Git worktree root and stays under that project's ignored `.tmb/` directory. It must not write `.claude/`, the installed plugin cache, or the source checkout.
5. **Prove isolation.** Focused tests must cover the Codex surface and the unchanged Claude contracts. Installed-cache tests must exercise a real bundled entry point and a real persistence operation, not only `tools/list`.

If a requested Codex change conflicts with these rules, stop and narrow the scope before implementation.

## Current contribution scope

### Scope 2 — package and project-bound MCP cold boot (GH 1157)

Scope 2 turns the Codex placeholder into a development package while keeping the
Claude adapter as the compatibility baseline.

Delivered in this scope:

- a Codex manifest synchronized with the repository product version;
- a repository development marketplace entry;
- an isolated Codex MCP configuration and bundled entry point;
- an explicitly empty Codex Hook manifest;
- an immutable Codex registry exposing only `runtime_initialize`;
- explicit Git worktree selection through an absolute `project_root`;
- project state confined to `<project>/.tmb/tmb/`;
- real SQLite schema verification with optional graph support kept lazy;
- bounded, project-keyed runtime reuse and deterministic cleanup;
- stable machine-readable validation and initialization errors;
- installed-cache integration coverage that does not use source `node_modules`;
- regression coverage for Claude entry points, registries, logging, database
  behavior, and protected manifests.

Still outside this scope:

- Claude workflow tool exposure in Codex;
- Codex agents, skills, or the `tmb-bro` workflow;
- functional Codex enforcement Hooks;
- worktree orchestration, review gates, or Push gates;
- Claude state adoption or migration;
- public Plugin Directory, stable-channel, or full Codex support claims.

Automated validation proves package containment, installed-copy MCP cold boot,
project isolation, SQLite persistence, optional dependency degradation, and
Claude compatibility. Evidence from a supported live Codex host must still be
recorded separately before claiming that host or installation surface as
verified.

### Scope 3 — explicit `tmb-bro` planning (HAR-1)

Scope 3 adds one explicitly invoked Codex-native Skill and a narrow planning
surface. It reuses shared scan, world-model, issue, and discussion handlers
through adapter-owned wrappers; it does not import the Claude registry or copy
Claude persona/doctrine bodies.

The immutable MCP allowlist is:

- `runtime_initialize`;
- `project_inventory`, `project_scan`;
- `world_model_get`, `world_model_search`;
- `planning_label_taxonomy_get`, `planning_label_taxonomy_set`;
- `planning_issue_create`, `planning_issue_get`, `planning_issue_list`,
  `planning_issue_resume`;
- `planning_discussion_append`, `planning_discussion_list`.

Every schema requires `project_root` and disallows additional properties. The
wrapper removes role/provenance fields from the public contract, rejects any
caller attempt to supply `agent`, `author`, `verified_human`, `role`, or
`provenance`, and injects the fixed `bro` identity internally. Scan routing is
fixed to the validated project root and `bro_auto_initial`. Configuration is
limited to an atomic replacement of the classification and priority arrays
through the shared config foundation; the replacement is advertised as
destructive and arbitrary keys remain unreachable. Planning issue creation
reads both taxonomy rows from one SQLite snapshot and accepts either the
backward-compatible default
classification/priority inputs or one mutually exclusive exact `labels` array
containing at least one configured classification and priority plus any explicit
extra labels, writes `issue_sync="off"` before calling the shared issue handler,
and does not accept remote linkage arguments. Discussion append and reads call the
shared discussion handlers with server-fixed Bro authorship; the optional
embedding dependency remains external to the installed bundle and degrades to
FTS-only behavior when absent, so the Scope-3 workflow requires no dependency
installation step.

Machine-enforced controls are the exact tool allowlist, immutable registry,
strict schemas and identity rejection, project-root validation, safe state-path
checks, local-only issue sync, and the absence of mutation handlers outside the
planning slice. The Skill supplies sequencing, clarification, and the stop
instruction; those prompt-level controls are not claimed as hard enforcement.

Still outside Scope 3:

- task creation, execution, retry, close, or status mutation;
- SWE/reviewer/consultant spawning and validation records;
- branch or worktree orchestration;
- commit, push, merge, PR, or remote issue operations;
- onboarding, arbitrary configuration, cheatcode, roundtable, report, and
  enforcement Hook surfaces;
- Human-authored records or authenticated multi-role calls;
- state adoption or migration from Claude;
- public Plugin Directory, stable-channel, or full Codex support claims.

Automated coverage must freeze the manifest and tool allowlists, reject identity
spoofing and out-of-scope operations with stable codes, prove remote sync stays
off, exercise a real local planning flow, and repeat that flow from an
installed-cache copy without source `node_modules`. A supported live Codex host
must still verify Skill discovery, explicit invocation, and end-to-end MCP use
before those host behaviors can be claimed as verified.

### Scope 4 — explicit project-Agent materialization (GH 1175)

Scope 4 adds one explicit-only setup Skill and two bounded MCP tools. It does
not widen the 13 planning handlers or connect Agents to TMB workflow state.

The Codex package now exposes exactly two Skills:

- `$tmb-bro` for Scope-3 project understanding and local planning;
- `$tmb-agent-setup` for inspecting, installing, and removing two fixed
  project-level Agent files after user confirmation.

The immutable registry now contains 15 tools. The only additions are
`agent_materialization_get` and `agent_materialization_set`. Their schemas
accept an absolute `project_root`; the setter also accepts only
`desired_state="present"` or `desired_state="absent"`. Callers cannot supply a
path, Agent name, template body, role, identity, or provenance.

The single catalog owns the canonical bytes for:

- `.codex/agents/tmb_swe.toml`;
- `.codex/agents/tmb_pr_reviewer.toml`.

The getter reports `absent`, `current`, `conflict`, or overall `mixed` without
creating `.tmb` or `.codex`. A file is current only when its full UTF-8 bytes
match the catalog. Conflict responses disclose no current hash or file body.
The setter revalidates the project and paths, blocks the whole call on a
preflight conflict, uses exclusive no-follow creation, rechecks exact bytes
before deletion, preserves every other Agent, and returns stable error codes.
Once one managed directory entry changes, any later failure is reported as
`agent_materialization_partial` with the original cause code and final known
states.

Both Agent templates disable the TMB trajectory server under the static
development identity `tmb@trustmybot-local`. Scope 4 requires Codex 0.147.0 or
newer: 0.146.0 can parse the same TOML while leaving the TMB tools exposed.
Setup checks the CLI version before installation, and each Agent stops before
repository access if its live tool surface still contains a TMB trajectory-server
tool. The runtime check is prompt-level defense in depth, not a server-enforced
permission boundary. The templates inherit model and reasoning settings. SWE
requests `workspace-write` and requires a complete, path-bounded
brief. The reviewer requests `read-only`, never returns `PASS`, and describes
its findings as advisory. Parent permissions can override these sandbox
defaults, and Agent names do not authenticate workflow roles.

Scope 4 deliberately leaves the following work for later scopes or hardening:

- Bro-driven Agent spawning or task lifecycle integration;
- validation records, authenticated roles, or Push-gate evidence;
- worktree creation, branch management, commit, push, PR, merge, or remote
  Issue operations;
- functional Codex Hooks;
- historical-template upgrades and a `stale` state;
- process locking, compensating rollback, fsync, crash recovery, and stronger
  same-user TOCTOU protection;
- dynamic Marketplace plugin identities;
- IDE, cloud, non-macOS, stable-channel, or complete-parity claims.

Automated coverage must include catalog/TOML contracts, byte conflicts,
symlink and non-regular paths, idempotent present/absent reconciliation,
fault-injected partial results, exact Skill/tool surfaces, copied installed-cache
execution, Scope-3 regression, and the full Claude gate. Final host evidence is
recorded separately against a fixed SHA on macOS arm64 Codex CLI and Desktop.
The record must include the host version and the child Agent's observed tool
surface; parsing the generated TOML alone is insufficient.
