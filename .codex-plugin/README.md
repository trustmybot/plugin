# TMB Codex adapter

> **Scope 4 status:** local Bro planning and explicit project-Agent setup.

The Codex manifest selects three isolated components:

- `adapters/codex/.mcp.json` starts the bundled Codex-only MCP entry point;
- `adapters/codex/skills/` contains exactly `tmb-bro` and `tmb-agent-setup`;
- `hooks/codex/hooks.json` remains empty so Claude Hooks cannot load in Codex.

Invoke `$tmb-bro` for project-local planning. Invoke `$tmb-agent-setup` to inspect,
install, or remove `.codex/agents/tmb_swe.toml` and
`.codex/agents/tmb_pr_reviewer.toml`. Both Skills are explicit-only. Setup shows
the fixed paths and asks for confirmation before writing or deleting either
file; when a file changes, start a new Codex task or CLI session.

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
They cannot call the TMB trajectory server under `tmb@trustmybot-local`, do not
receive authenticated identity, and do not create task or validation records.
The reviewer is advisory even though its template requests a read-only sandbox.
Scope 4 still exposes no Agent spawn orchestration, branch/worktree setup, Git
delivery, remote Issue operations, or lifecycle Hooks.

Every MCP tool requires an absolute `project_root`. Planning state stays under
`<project>/.tmb/tmb/`, and local Issue creation forces `issue_sync="off"`. The
shared database, graph, scan, Issue, and discussion handlers remain the
source of truth. Codex packaging and argument translation are thin edge
adapters and do not change the Claude entry point or registry. See
[`../docs/contributing/CODEX_PORT.md`](../docs/contributing/CODEX_PORT.md) and
[`../docs/adapters/codex/PARITY.md`](../docs/adapters/codex/PARITY.md).
