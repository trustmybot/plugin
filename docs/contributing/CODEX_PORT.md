# Codex port guardrails

These are hard constraints for every Codex contribution.

The adapter's current contract declaration is maintained in
[`../adapters/codex/PARITY.md`](../adapters/codex/PARITY.md), and its MCP tools
in [`../adapters/codex/TOOLS.md`](../adapters/codex/TOOLS.md). Any change to a
Codex capability or exposed surface must update that declaration in the same
pull request. Scope history and planned work live in GH 1151 (the Codex adapter
parent issue).

1. **Port, do not fork the product.** Codex is a thin adapter over TMB's shared implementation. Shared behavior remains the source of truth; platform-specific code belongs at the package, dispatch, and host-contract edges.
2. **Claude behavior is protected.** A Codex change must not alter Claude's manifest, root `.mcp.json`, hook contract, entry point, tool registry, state paths, or runtime behavior unless a separately scoped cross-platform change is explicitly approved and validated for Claude.
3. **Expose only completed Codex surfaces.** Do not make Claude tools, skills, agents, or hooks visible in Codex merely because the underlying files exist. Each surface needs an explicit port and its own compatibility evidence.
4. **Keep state project-bound.** Codex runtime state requires an explicit canonical Git worktree root and stays under that project's ignored `.tmb/` directory. It must not write `.claude/`, the installed plugin cache, or the source checkout.
5. **Prove isolation.** Focused tests must cover the Codex surface and the unchanged Claude contracts. Installed-cache tests must exercise a real bundled entry point and a real persistence operation, not only `tools/list`.

If a requested Codex change conflicts with these rules, stop and narrow the scope before implementation.

## Scope 4 host-version compatibility gate

This narrow gate revalidates the same-name MCP shadow and managed-Agent
lifecycle. Run it before adding a Codex version or client surface to the support
claim, and again when a supported host changes how custom-Agent or plugin MCP
configuration is composed. It does not replace the full fixed-SHA host
acceptance in
[`PARITY.md`](../adapters/codex/PARITY.md#verification-evidence).

1. Use a disposable Git project. For CLI testing, also use an isolated
   `CODEX_HOME`. For Desktop, use a disposable local project, record whether the
   exact plugin was already installed, including its source and content hash,
   and capture before-state sentinels: digests of the project's Skills, Agents
   (including one third-party Agent), Git state, `.claude/`, and `.tmb/`.
2. If TMB is absent, install the plugin from the exact candidate commit and mark
   it as introduced by this check. If the installed plugin already matches the
   candidate source and content hash, reuse it without replacing it. If another
   TMB build is installed, or the match cannot be proved, stop without changing
   the active profile and use an isolated profile or a later test window. Start
   a fresh parent task or CLI session so the positive control cannot use a stale
   plugin instance.
3. From that fresh parent, successfully call the read-only
   `agent_materialization_get` tool and record the response as the positive
   control that the candidate plugin MCP is active. Confirm that its expected
   template hashes match the candidate commit. Materialize both Agents and start
   a fresh child-discovery task.
4. Invoke `tmb_swe` and `tmb_code_reviewer`. Record each child Agent's live tool
   surface and fail the gate if any TMB `trajectory-server` tool is visible.
   Ask each child to attempt the read-only `agent_materialization_get` operation;
   require explicit unavailable or refused evidence, zero successful TMB MCP
   events, and unchanged `.tmb` before/after sentinels. Otherwise record the
   isolation result as unverified.
5. Remove the managed Agents, start another fresh task, and confirm that both
   TMB Agents are gone while an unrelated third-party Agent remains unchanged.
6. If this check installed the plugin into an existing Desktop profile, remove
   that exact plugin through the normal plugin-removal flow. Compare the
   before/after sentinels and preserve every plugin and profile entry that
   existed before the check.

Do not infer a pass from generated TOML, the parent task's tool list, or an
older Codex version. A pass proves only the tested child MCP isolation and
managed-Agent lifecycle; a full support claim still requires the SWE, reviewer,
and evidence checks listed in the fixed-SHA acceptance record. If this gate
fails, open a compatibility issue and keep the last passing evidence scoped to
the versions it actually tested. This is a credentialed local-host check, not a
background monitor or a default `tests/run-all.ts` step.

Record the candidate SHA, Codex client and build version, operating system and
architecture, plugin source, template hashes, parent positive control, both
child tool surfaces, before/after sentinels, and cleanup result in the candidate
PR or its linked compatibility issue.
