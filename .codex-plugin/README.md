# TMB Codex adapter

> **Scope 5 candidate:** local Bro planning, explicit project-Agent setup, and a
> bounded repository-write Hook. Release support still requires fixed-commit CLI
> and Desktop acceptance.

The Codex manifest selects three isolated components:

- `adapters/codex/.mcp.json` starts the bundled Codex-only MCP entry point;
- `adapters/codex/skills/` contains exactly `tmb-bro` and `tmb-agent-setup`;
- `hooks/codex/hooks.json` loads the Codex-only `PreToolUse` dispatcher. Its
  runtime is pinned by digest and does not load the Claude Hook set.

Invoke `$tmb:tmb-bro` for project-local planning. Invoke `$tmb:tmb-agent-setup` to inspect,
install, or remove `.codex/agents/tmb_swe.toml` and
`.codex/agents/tmb_pr_reviewer.toml`. Both Skills are explicit-only. Setup shows
the fixed paths and asks for confirmation before writing or deleting either
file; when a file changes, start a new Codex task or CLI session.

Each generated Agent shadows the plugin-provided `trajectory-server` with a
disabled same-name entry in its own `mcp_servers` table. Codex requires a
complete transport shape, so that entry uses inert `node --version` metadata;
it is never started while disabled. Each Agent also blocks before repository
access if a TMB trajectory-server tool remains visible at runtime.

The adapter exports an immutable 15-tool allowlist. Thirteen tools retain the
Scope-3 planning contract. Its only planning configuration write
is `planning_label_taxonomy_set`, which atomically replaces the two project-local
label arrays when the user explicitly requests it. Before creating a local
planning issue, `planning_label_taxonomy_get` reports the exact labels accepted
by the project. `planning_issue_create` keeps its default
classification/priority inputs and also accepts a mutually exclusive exact
`labels` array containing the required configured categories plus any explicitly
requested extra labels. Two additional tools inspect and converge the fixed
project Agent files. Unknown file bytes are conflicts; the materializer neither
overwrites them nor deletes them. Symlink and non-regular paths fail closed, and
other `.codex/agents` entries stay untouched.

The generated Agents are standalone Codex roles, not TMB task-workflow roles.
Their same-name MCP shadow hides the TMB trajectory server in tested CLI hosts.
They also run a prompt-level live tool-surface check and stop if isolation is
missing. They do not receive authenticated identity or create task or
validation records.
The reviewer is advisory even though its template requests a read-only sandbox.
The adapter still exposes no Agent spawn orchestration, branch/worktree setup,
Git delivery, remote Issue operations, or workflow-lifecycle Hooks. Scope 5 is
limited to repository-write policy: primary checkouts are read-only, while a
linked worktree gets contained `apply_patch` plus a small validation-entrypoint
allowlist. Project-level `.codex/config.toml` disables TMB MCP calls because the
Hook cannot authenticate a same-name provider. A 4-second launcher watchdog
returns deny before Codex's 5-second process timeout. See the linked contract
documents for host and sandbox boundaries.

Every MCP tool requires an absolute `project_root`. Planning state stays under
`<project>/.tmb/tmb/`, and local Issue creation forces `issue_sync="off"`. The
shared database, graph, scan, Issue, and discussion handlers remain the
source of truth. Codex packaging and argument translation are thin edge
adapters and do not change the Claude entry point or registry. See
[`../docs/contributing/CODEX_PORT.md`](../docs/contributing/CODEX_PORT.md) and
[`../docs/adapters/codex/PARITY.md`](../docs/adapters/codex/PARITY.md).
