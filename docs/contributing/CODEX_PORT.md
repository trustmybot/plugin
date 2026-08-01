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
