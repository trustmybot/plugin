# TMB Codex adapter

> **Local Scope 5 candidate `1.0.6-rc.1`:** Bro planning, explicit project-Agent setup, and a
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
requested extra labels. Two additional tools inspect, install, and remove the
fixed project Agent files. Unknown file bytes are conflicts; the materializer neither
overwrites them nor deletes them. Symlink and non-regular paths fail closed, and
other `.codex/agents` entries stay untouched.

The generated Agents are standalone Codex roles, not TMB task-workflow roles.
Their same-name MCP shadow hides the TMB trajectory server in tested CLI hosts.
They also run a prompt-level live tool-surface check and stop if isolation is
missing. They do not receive authenticated identity or create task or
validation records.
The reviewer is advisory even though its template requests a read-only sandbox.
The MCP registry and standalone Agents expose no Agent spawn orchestration,
branch/worktree setup, Git delivery, remote Issue operations, or workflow
lifecycle gates. The root task has a separate, limited Hook command surface for
the Human's requested Git/PR delivery. Both primary and linked checkouts permit
contained `apply_patch` and a small validation-entrypoint allowlist on recognized
feature branches. Protected branches permit reviewed queries; valid branch policy
also permits controlled feature-branch creation and explicit-path unstaging.
`write_stdin` permits only empty polling or one Ctrl-C.

Git, validation, and forge commands use an explicit macOS restricted runner.
Generate its exact `env -i` command with `makeRestrictedCommand` and pass it
through one static `functions.exec` call to `exec_command`, with an explicit
workdir, `shell: "/bin/sh"`, `login: false`, and `tty: false`. Only that pinned
wrapper may request outer sandbox escalation. Raw sensitive commands and runner
execution on unsupported hosts are denied; ordinary reviewed shell reads remain
available.

Validation can write ordinary source and scratch files, but cannot write Git,
TMB, host configuration, plugin, or outside paths. It denies reads of checkout
`.tmb`, `.claude`, and `.codex` state and network access; approved runtime and
toolchain roots remain readable. Git queries cannot write the repository.
Child processes inherit these restrictions. Local Git delivery cannot fork and
rejects configured hooks, filters, signing, and executable repository hooks.
Forge and push use fixed trusted executables and a unique checkout `origin` on
`github.com` or `gitlab.com`, with clean configuration and a host-bound token.
Process-group cleanup is best effort; escaped descendants retain the same
restrictions. The [restricted execution contract](../docs/adapters/codex/RESTRICTED_EXECUTION.md)
documents command construction, authentication, and mode limits.

Branch checks combine the fixed baseline with configured protected, target,
legacy PR-target, and task-parent branches from the acting worktree's
`.tmb/<Codex manifest name>/trajectory.db`. Configured names are compared after
NFC normalization and lowercasing, even on filesystems that distinguish those
spellings. A missing database keeps the baseline. An invalid or unreadable
existing database blocks patch, validation, and delivery calls. The reader uses
macOS system SQLite in a sandbox that denies writes and
network access, with a 500 ms budget, a 64 MiB combined state-file limit, and strict WAL
checks. Some valid SQLite WAL states are unsupported and also block those calls;
see the [PRD's compatibility limits](../docs/adapters/codex/SCOPE_5_PRD.md).
Retrying alone does not guarantee recovery. Existing databases on unsupported
platforms also block write-related calls.
Reviewed reads and diagnostics remain independent of the database check. The
manifest pins seven fixed ESM modules and its normalized Hook definition by
SHA-256. The Hook and MCP registry import the same tool-name data module.
Native read tools and forge queries have no general repository
confidentiality guarantee. Project-level `.codex/config.toml` disables TMB MCP
calls because the Hook cannot authenticate a same-name provider. A 4-second
launcher watchdog returns deny before Codex's 5-second process timeout. See the
linked contract documents for the remaining host and sandbox limits.

Every MCP tool requires an absolute `project_root`. Planning state stays under
`<project>/.tmb/tmb/`, and local Issue creation forces `issue_sync="off"`. The
shared database, graph, scan, Issue, and discussion handlers remain the
source of truth. Codex packaging and argument translation are thin edge
adapters and do not change the Claude entry point or registry. See
[`../docs/contributing/CODEX_PORT.md`](../docs/contributing/CODEX_PORT.md) and
[`../docs/adapters/codex/PARITY.md`](../docs/adapters/codex/PARITY.md).
