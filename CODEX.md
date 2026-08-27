# TMB on OpenAI Codex

> **Current scope:** local Bro planning, explicit installation of two project-level Agents, and a bounded repository-write Hook.

TMB exposes exactly two Codex Skills, and both require an explicit invocation:

- `$tmb:tmb-bro` inspects a selected Git worktree, builds or queries TMB's project
  inventory and world model, clarifies a request, and saves an approved local
  planning issue with Bro-authored decision records.
- `$tmb:tmb-agent-setup` checks, installs, or removes the fixed `tmb_swe` and
  `tmb_pr_reviewer` Agent files in that project. It previews the exact paths and
  asks before changing them.

The installed package also exposes one broad `PreToolUse` Hook. In a primary
checkout it permits only reviewed read-only commands and the fixed TMB MCP
surface. TMB MCP calls must target that same canonical checkout and are denied
when project-level `.codex/config.toml` could shadow the bundled server.
In a branch-backed linked worktree, canonical `apply_patch` calls may
modify ordinary in-root paths; Git/forge writes, direct write tools, persistent
command receivers, and unknown payloads remain blocked. The Hook is not a
general operating-system sandbox. Approved validation scripts still depend on
the host sandbox for their child processes. The launcher has a 4-second
fail-closed watchdog; Codex's 5-second process timeout is not itself an
authorization decision. See
[`docs/adapters/codex/SCOPE_5_PRD.md`](docs/adapters/codex/SCOPE_5_PRD.md) for
the exact allowlist, failure behavior, trust cost, and residual risks.

Because both Skills set `allow_implicit_invocation: false`, a generic request
to list model-available Skills may omit them. Verify the installed Codex surface
by resolving the manifest's `skills` path and checking that this directory
contains only `tmb-bro` and `tmb-agent-setup`, then invoke each Skill directly by
its namespaced name. The Codex package declares an empty `commands` surface so
Claude commands are not migrated into `source-command-*` Skills during
installation. The package's root `skills/` and `commands/` directories belong
to Claude and must remain unchanged.

Before issue creation, the Skill reads the project's exact classification and
priority taxonomy. Generic projects keep the `Feature` + `Priority: Medium`
default; configured projects require an explicit choice from their own labels.
When the user explicitly asks to configure those labels, the bounded
`planning_label_taxonomy_set` tool atomically replaces both project-local arrays;
no arbitrary configuration surface is exposed.

Every MCP call requires the absolute Git worktree root. TMB rejects a non-root,
unignored, tracked, or unsafe `.tmb/` state path before writing and confines all
state to `<project>/.tmb/tmb/`. Codex never adopts or modifies `.claude/` state.
Planning issue creation forces remote synchronization off even when the project
has a configured Git remote.

Agent setup manages only `.codex/agents/tmb_swe.toml` and
`.codex/agents/tmb_pr_reviewer.toml`. A same-name file is managed only when its
bytes exactly match the current built-in template. Any difference, including
line endings or comments, is a conflict and stops the whole operation. The
setter never force-overwrites a file, edits `.gitignore`, stages the generated
files, or removes another Agent. After a change, start a new Codex task or CLI
session so the host can reload project Agent configuration.

## Install, inspect, and remove Agents

Run `$tmb:tmb-agent-setup` from the Git worktree that should receive the Agents. The
Skill validates the canonical project root, inspects both targets, and explains
the intended change. It calls the setter only after a separate confirmation.
If both files already match the current templates, it reports `current` without
asking for a no-op confirmation or writing either Agent file. Inspection uses
the read-only materialization getter, so checking or removing Agents does not
depend on opening the TMB planning database.

Choose removal through the same Skill. TMB deletes only a target whose bytes
still match the current catalog, leaving `.codex/agents/` and every other file
in place. Generated files can appear in `git status`; decide whether to commit
or ignore them as part of the project. TMB does neither automatically.

## Upgrade conflicts and recovery

Scope 4 has no historical-template upgrade path. After a plugin update, an
older TMB file is therefore a conflict, just like a user-edited or unknown
same-name file. Back up or rename that file yourself, then run
`$tmb:tmb-agent-setup` again. There is no force or adopt option.

Setup is a single-user, single-process operation. It has no lock, rollback,
fsync, or crash recovery. If one target changes before the second operation
fails, the tool returns `agent_materialization_partial` with the changed path,
the original cause code, and both final known states. Run the Skill again to
inspect the project. A safe `mixed` state can be reconciled by confirming the
same desired state; a `conflict` needs manual handling first. Do not delete the
whole `.codex/agents` directory as a recovery shortcut.

Before downgrading to a plugin version without Scope 4, remove the Agents with
the current setup Skill and verify both targets are absent. If the downgrade
already happened, delete only these two files after checking their full bytes
against the canonical catalog from the exact trusted plugin commit. When that
evidence is unavailable, reinstall a trusted Scope-4 build and use its setter
instead of guessing ownership.

## Use the installed Agents

The installed Agents are intentionally independent of TMB workflow state.
`tmb_swe` can implement a complete, path-bounded brief in the current worktree;
`tmb_pr_reviewer` provides an advisory review. Their names are not authenticated
roles, and Bro does not spawn them. Each template shadows the plugin-provided
`trajectory-server` with a disabled same-name entry in its own `mcp_servers`
table. The required transport is the inert `node --version`; it never starts
while the entry is disabled. Each Agent also checks its live tool surface before
it reads the repository and returns `BLOCKED_TMB_MCP_ISOLATION` if a TMB tool is
still visible. That self-check is prompt-level defense in depth, not a server
gate. The reviewer requests read-only sandboxing, but a parent
task can override that default, so its verdict is never a Push gate or a trusted
validation record.

Give `tmb_swe` an objective, allowed paths, acceptance criteria, and required
tests. It refuses protected branches, stops when existing user changes overlap
the allowed paths, and reports `NEEDS_CONTEXT` when the brief is incomplete.
These Agent instructions remain broader than the Hook contract. Scope 5 blocks
model-driven collaboration spawn until child Hook inheritance is proved on the
host; user-started Agent tasks still need their own fresh-session verification.
Review the diff and Git status after every run.

Give `tmb_pr_reviewer` the requirements, an exact working-tree or commit-range
diff boundary, and available test evidence. It reports findings from P0 through
P3 and returns `REQUEST_CHANGES`, `NEEDS_CONTEXT`, or
`NO_BLOCKING_FINDINGS`; a failed MCP preflight returns
`BLOCKED_TMB_MCP_ISOLATION`. It never returns `PASS` because the parent task can
broaden its permissions and Scope 4 records no independent read-only proof.

Scope 5 still does not expose task execution or status mutation, validation
records, branch/worktree orchestration, commit/push/merge, pull-request or remote
Issue operations, onboarding, or Claude-equivalent lifecycle enforcement.
Native Codex shell and patch calls are covered only where the Scope 5 dispatcher
can parse them. External MCP tools and approved validation sub-processes remain
outside its strong containment boundary.

The exact MCP schemas and result states are documented in
[`docs/adapters/codex/TOOLS.md`](docs/adapters/codex/TOOLS.md), and the
contribution boundary is in
[`docs/contributing/CODEX_PORT.md`](docs/contributing/CODEX_PORT.md). Capability,
identity, and security differences are declared in
[`docs/adapters/codex/PARITY.md`](docs/adapters/codex/PARITY.md).
