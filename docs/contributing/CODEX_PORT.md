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
must still resolve the installed manifest's `skills` path, verify that
directory's exact contents, exercise direct namespaced invocation, and confirm
end-to-end MCP use before those host behaviors can be claimed as verified.
Explicit-only Skills may be absent from a generic model-visible Skill list by
design.

### Scope 4 — explicit project-Agent materialization (GH 1175)

Scope 4 adds one explicit-only setup Skill and two bounded MCP tools. It does
not widen the 13 planning handlers or connect Agents to TMB workflow state.

The Codex package now exposes exactly two Skills:

- `$tmb:tmb-bro` for Scope-3 project understanding and local planning;
- `$tmb:tmb-agent-setup` for inspecting, installing, and removing two fixed
  project-level Agent files after user confirmation.

Both are explicit-only. Acceptance therefore resolves the manifest's `skills`
path, verifies that directory contains exactly these two source directories,
and calls both namespaced Skills directly; it does not treat a generic "list
available Skills" response as the authoritative package surface. The
manifest's empty `commands` array also prevents Codex from migrating the
plugin's Claude commands into additional `source-command-*` Skills. The root
Claude `skills/` and `commands/` directories remain part of the installed
artifact and must not be changed or removed.

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

Both Agent templates shadow the plugin-provided TMB server with a disabled
ordinary `mcp_servers."trajectory-server"` entry. Codex requires transport
metadata even when the entry is disabled, so the templates use inert
`node --version`. This shape hid the TMB tools in live CLI `0.146.0` and
`0.147.0` tests. Each Agent still stops before repository access if its live
tool surface contains a TMB trajectory-server tool. The runtime check is
prompt-level defense in depth, not a server-enforced permission boundary. The
templates inherit model and reasoning settings. SWE
requests `workspace-write` and requires a complete, path-bounded
brief. The reviewer requests `read-only`, never returns `PASS`, and describes
its findings as advisory. Parent permissions can override these sandbox
defaults, and Agent names do not authenticate workflow roles.

The two persona bodies are intentionally authored for this standalone Codex
surface. They do not copy the shared workflow personas, which assume TMB
task authority, isolated worktrees, validation records, and delivery gates.
Their familiar names are labels for users, not claims of workflow equivalence.

Scope 4 deliberately leaves the following work for later scopes or hardening:

- Bro-driven Agent spawning or task lifecycle integration;
- validation records, authenticated roles, or Push-gate evidence;
- worktree creation, branch management, commit, push, PR, merge, or remote
  Issue operations;
- functional Codex Hooks;
- historical-template upgrades and a `stale` state;
- process locking, compensating rollback, fsync, crash recovery, and stronger
  same-user TOCTOU protection;
- a renamed TMB MCP server or broader dynamic MCP policy;
- IDE, cloud, non-macOS, stable-channel, or complete-parity claims.

Automated coverage must include catalog/TOML contracts, byte conflicts,
symlink and non-regular paths, idempotent present/absent reconciliation,
fault-injected partial results, exact Skill/tool surfaces, copied installed-cache
execution, Scope-3 regression, and the full Claude gate. Final host evidence is
recorded separately against a fixed SHA on macOS arm64 Codex CLI and Desktop.
The record must include the host version and the child Agent's observed tool
surface; parsing the generated TOML alone is insufficient.

#### Scope 4 host-version compatibility gate

This narrow gate revalidates the same-name MCP shadow and managed-Agent
lifecycle. Run it before adding a Codex version or client surface to the support
claim, and again when a supported host changes how custom-Agent or plugin MCP
configuration is composed. It does not replace the full fixed-SHA host
acceptance described above.

1. Use a disposable Git project. For CLI testing, also use an isolated
   `CODEX_HOME`. For Desktop, use a disposable local project, record whether the
   exact plugin was already installed, including its source and content hash,
   and capture the before-state sentinels required by `SCOPE_4_PRD.md`.
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
4. Invoke `tmb_swe` and `tmb_pr_reviewer`. Record each child Agent's live tool
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
background monitor or a default `tests/run-all.sh` step.

Record the candidate SHA, Codex client and build version, operating system and
architecture, plugin source, template hashes, parent positive control, both
child tool surfaces, before/after sentinels, and cleanup result in the candidate
PR or its linked compatibility issue.

### Scope 5: bounded repository-write Hook

Scope 5 adds one broad `PreToolUse` matcher and a dispatcher without npm dependencies.
The runtime is limited to:

- `hooks/codex/hooks.json`;
- `adapters/codex/hooks/dispatcher.mjs`;
- `adapters/codex/hooks/repo-policy.mjs`;
- `adapters/codex/hooks/branch-policy.mjs`;
- `adapters/codex/hooks/restricted-runner.mjs`;
- `adapters/codex/hooks/restricted-profile.mjs`;
- `adapters/codex/hooks/forge-binding.mjs`;
- `adapters/codex/tool-names.mjs`.

The digest covers these seven ESM files and the normalized Hook manifest.
The Hook and MCP registry import the same tool-name data module. A fixed
4-second launcher watchdog returns a deny before the host's `timeout: 5`. The
host timeout limits the Hook process's lifetime; Codex may still continue the
tool call after it expires.

Runtime modules may import each other and Node built-ins without loading
`node_modules`. Hook decisions must not use network access or log writes; only
the runner's forge and push modes permit network access. The branch-policy
module is loaded only by patch, validation, and delivery gates. It reads existing
Codex state through macOS system SQLite in a sandbox that denies writes and
network access. It never initializes or migrates a database. Installed-cache tests must run the
dispatcher with `NODE_PATH` empty and `PLUGIN_ROOT` set to the cached package.
The manifest checks absolute host PATH candidates in order and then fixed
system locations, skipping unsafe candidates. It resolves recognized
version-managed Node launchers through `process.execPath`,
rejects launchers or resolved binaries inside the checkout, plugin cache, Git
metadata, or `node_modules/.bin`, and starts the dispatcher with a minimal
environment. It resolves the canonical worktree root with fixed `/usr/bin/git`
and sanitized Git configuration, so a repository shim stays rejected from a
nested cwd. Failure to resolve a trusted Node executable must deny the call.
The manifest command is covered by both the host's Hook-definition trust and
the normalized-manifest digest. A digest assertion or copied-cache
test does not replace a real installation and fresh-session host check.

The following command rules describe implemented policy. CLI `0.151.0` cannot
execute restricted Git, validation, or forge commands, including an unchanged
copy of the Hook's recovery call. It exposes only the nested `Bash {command}`
projection to the Hook and omits shell, login, TTY, and workdir parameters.
Release is blocked; Desktop remains independently unverified.

At the policy level, protected branches use a reviewed query allowlist. Valid
branch policy also
permits creating a recognized feature branch with `git switch -c`, `git switch
--create`, or `git checkout -b`. Unknown tools, unknown payloads, scripts,
interpreters, compound shell syntax, redirection, and direct write tools deny.
Branch classification combines fixed names and prefixes with `protected_branches`,
`target_branch`, optional legacy `pr_target`, and matching task `parent_branch_id`
values from `<acting-worktree>/.tmb/<Codex manifest name>/trajectory.db`. Resolve
the name from the trusted `.codex-plugin/plugin.json`, and match the `repos` row
by canonical worktree path. Do not borrow a primary checkout's database or read
Claude state. Task parents include the matching repo's tasks and every valid
`tasks.repo IS NULL` entry in the acting database, regardless of its registration
count. Missing databases retain the fixed baseline. A valid database without a
matching registration still contributes its NULL-repo task parents. Normalize
configured keys and candidate branch names with `.normalize("NFC").toLowerCase()`
before comparison, including branch-creation targets. This conservative rule
also applies on filesystems that distinguish case or canonical Unicode variants;
do not substitute exact string equality based on the current filesystem.
Ambiguous registration, malformed policy, unsafe paths, and unreadable existing
state deny all write-related gates. With valid policy, explicit-path
`git restore --staged -- <files>` remains available on protected branches;
unavailable policy blocks that recovery command too.

An existing database currently requires `/usr/bin/sqlite3` and
`/usr/bin/sandbox-exec` on macOS. Use SQLite read-only/query-only mode with
`trusted_schema=OFF`, no startup file, a clean environment, and an OS profile
that denies file writes and network access. Only ordinary `repos` and `tasks`
tables with the required columns are accepted. The reader has a 500 ms budget
and a 64 MiB combined database/sidecar limit per snapshot. It rejects rollback
journals, orphan sidecars, and incomplete WAL/SHM pairs. For WAL state, load the
bounded database, WAL, and SHM bytes before querying. Validate the WAL header
and cumulative frame checksums, salts, and final commit boundary. Both SHM
headers and checksums, `mxFrame`, `nPage`, `aFrameCksum`, page/hash indexes, and
backfilled database pages must agree with those bytes. SQLite query success
alone is insufficient because recovery can ignore a damaged suffix and select
an older checkpoint.

Support is limited to complete committed WAL generations, consistent
PASSIVE/FULL backfills, and closed sidecar-free databases. The last case uses
immutable mode; accepted WAL state uses ordinary read-only access. Reject valid
empty WAL files left by TRUNCATE with an open connection, header-only files,
uncommitted or rolled-back tails, and old generation tails left by RESTART.
Treat these as compatibility limits, not necessarily corrupt data. Retrying the
same state does not guarantee recovery. The Hook must not checkpoint, truncate,
repair, or remove sidecars to make a call pass.

Compare file identities, metadata, and hashes around both queries and fail
closed on change. These checks detect changes but do not provide an atomic
filesystem snapshot. Unsupported platforms with existing databases deny
write-related calls. Reviewed reads and diagnostics do not load this module or
query SQLite.

The fixed 15-tool TMB MCP surface remains available only under an exact observed
host prefix, when its canonical
`project_root` matches the current branch-backed checkout, and when no
project-level `.codex/config.toml` exists between the cwd and repository root.
The Hook event does not carry separate provider identity, so user or enterprise
same-name server composition must be requalified for each supported host. Its server
and materializer continue to enforce their own project write boundaries.

In a branch-backed primary checkout or linked worktree, a recognized feature
branch may use `apply_patch` only after every add, update, delete, and move target
passes canonical containment. Reject protected branches, detached worktrees,
absolute and parent paths, symbolic or hard-link aliases, mixed-case reserved
paths, parse failures, Git/TMB state, Hook configuration, and the two
materialized Agent files. Validation uses a separate command allowlist. Go test
targets must use explicit local forms such as `.` or `./...`; package names, `all`, and
`std` are outside the allowlist. Fixed command signatures run only from the
worktree root; direct test paths resolve from the actual Hook cwd and must stay
inside the worktree. Command classification checks the entrypoint; the macOS
runner constrains what the actual process and its descendants can do. Raw Git,
validation, and forge execution is denied.

Validation permits writes to ordinary checkout files and fresh scratch space,
but denies Git, TMB, host configuration, plugin, and outside-file writes. It
also denies reads of checkout `.tmb`, `.claude`, and `.codex` state and network
access. Approved runtime and toolchain roots remain readable. The runner checks
writable trees for aliases before execution. Git-read mode denies repository
writes, including attempts made by configured clean/process filters;
`--no-ext-diff --no-textconv` alone does not disable those filters. Local Git
delivery permits Git metadata writes but denies process forks and rejects
configured hooks, filters, signing, and executable repository hooks. Preserve
these refusals rather than silently dropping user configuration.

Forge and push use fixed trusted executables, clean configuration, and a token
bound to the unique `origin` on `github.com` or `gitlab.com`. Authentication reads
the matching host's default stored credentials through a bounded read-only
step; it does not log in or change user configuration. Forge commands execute
from scratch, support JSON output, and reject jq/template output filters. The
target restriction is enforced by checked arguments, configuration, and
credential preparation, not an OS network-host filter. The local machine lacks
`glab`, so GitLab CLI execution still needs real-host verification.

The runner has a ten-minute deadline and an 8 MiB output cap. It attempts to
terminate the process group on completion, cancellation, timeout, or excess
output. A descendant that leaves the group retains the same OS restrictions,
but may continue writing paths its mode permits. Do not claim that every
descendant is reclaimed, or equate subprocess restriction inheritance with
Codex Agent Hook inheritance. Unsupported hosts and sandbox setup failures
fail closed. See [restricted execution](../adapters/codex/RESTRICTED_EXECUTION.md)
for the exact profiles and command contract.

The policy defines a bounded delivery lane for recognized feature branches: explicit-path
`git add`, explicit-path `git restore --staged`, one-message `git commit`, a
non-force push of the current branch to `origin`, `gh pr create/edit/ready`, and
`glab mr create`. Shared branches, broad staging, merge/rebase/reset, force-push,
PR/MR merge, remote Issue writes, and every other Git/forge mutation deny. The
Hook does not parse Human approval text or persist an approval token; the main
task carries the Human's original directive, as in the Claude Code flow. Bare
shells, REPLs, TTY shapes, command-bearing later stdin, unauditable code-mode
wrappers, and model-driven collaboration spawn also deny. `write_stdin` accepts
only empty polling or a single Ctrl-C. Do not allow collaboration spawn until a
fixed host build proves the child receives the same Hook before its first tool call.
The delivery surface belongs to the root task. Standalone Agent delivery
remains forbidden by persona instructions, and the TMB MCP registry exposes no
delivery or trusted validation tools.

Ordinary reviewed reads accept the observed exact `Bash {command: string}`
shape or one audited nested `exec_command`. Sensitive commands require
`makeRestrictedCommand` to construct the installed runner's exact `env -i`
command, then one static `functions.exec` call to `exec_command` with an explicit
matching workdir, `shell: "/bin/sh"`, `login: false`, and `tty: false`. The
interpreter, runner path, environment, cwd, and digest must match the installed
bundle. An optional `sandbox_permissions: "require_escalated"` is accepted only
for that pinned wrapper; raw reads cannot request outer sandbox escalation.
Do not replace the wrapper with host `updatedInput` behavior or an unrestricted
fallback after sandbox setup fails.

Do not remove the execution-parameter check to accommodate CLI `0.151.0`, or
infer shell defaults from its command-only event. The `env -i` prefix runs after
the outer shell has started. Safe execution requires a host interface that
preserves trusted parameters or launches the reviewed executable directly.
The positive host tests below remain acceptance requirements; they are not
passing evidence for this CLI.

Within the reviewed inner command, path-qualified executables, extra execution
fields, shell expansion syntax, and unqualified shell aliases deny. File reads
must use finite argument shapes; content-reading tools accept only ordinary
repository files, while external decompression, follow/watch, credential-display,
and web-launch flags deny. `rg` requires `--no-config`; directory searches and
`--files` also require `--no-ignore`. Both inline and file-backed `jq` filters
reject the words `import` and `include`, even inside strings and comments.
File-backed filter source must be at most 256 KiB and pass ordinary-file
containment. Complex filters without module loading remain allowed; this check
does not bound expression execution time. External programs must resolve outside
the checkout and common shim directories. Git queries must carry the fixed no-pager,
no-optional-locks, no-lazy-fetch, fsmonitor-off, hooks-off prefix; diff-like queries
also disable external diff and text conversion. Git arguments must match the
reviewed grammar exactly; abbreviated options and explicit or implicit
`--no-index` comparisons outside the repository deny. Validation commands use
exact package signatures or repository-relative test targets; cwd/prefix/manifest
redirection and additional runtime loaders deny.
These checks apply to parsed shell commands. They do not constrain native
`Read` payloads or establish a general repository confidentiality boundary.
Forge commands have a separate checked `origin` binding; that does not extend
the runner's confidentiality boundary to other tools.

The dispatcher writes nothing for an allow decision. A deny returns
`hookSpecificOutput.hookEventName="PreToolUse"`,
`permissionDecision="deny"`, and a non-empty reason beginning with
`TMB-CODEX-HOOK:`. Codex `0.146.0` rejects an explicit
`permissionDecision="allow"`, so success must remain silent.

#### Scope 5 host-version compatibility gate

`tests/run-all.sh` runs the real Codex installer smoke test in an isolated profile
when a Codex CLI is available. It reports SKIP when no CLI is found, and FAIL
when an explicitly configured `CODEX_BIN` is invalid. The smoke test checks
cache removal, reinstallation, runtime bytes, and the cached dispatcher; it does
not establish the user's trust state or replace fresh-session host acceptance.

Use the same clean candidate commit for CLI and Desktop. Do not install a dirty
working tree into a profile used for release evidence.

1. Record the candidate SHA, runtime digest, Codex build, operating system,
   architecture, plugin source, Hook definition, trust state, and sandbox.
2. Install through the normal local Marketplace flow. Resolve the installed
   cache path and compare the normalized manifest and all seven runtime modules with the
   candidate.
3. In a disposable protected checkout, attempt canonical patch, redirected
   shell, interpreter, wrapper, package/build, dangerous Git/forge write, and
   unknown-tool probes. Hash the target files, index, refs, Git common dir, and
   isolated forge fixture log before and after. Every value must remain
   unchanged except the separately tested feature-branch creation and explicit
   unstaging recovery with valid branch policy. Repeat the write-denial checks
   on configured protected, target, legacy PR-target, and task-parent branches,
   and on invalid database state.
4. In branch-backed primary and linked feature checkouts, require one valid
   in-root patch and the restricted delivery sequence to pass. Pair raw sensitive
   commands with their canonical wrappers to verify the execution boundary.
   Test protected-marker writes from validation imports and Git filters,
   forbidden network access, alias and ancestor-renaming attempts, and profile
   setup failures. Keep real remote delivery checks scoped to approved test
   targets on a supported forge. Absolute, parent,
   symlink, rename, protected-path, detached, broad-stage, force-push, and merge
   probes must deny without unintended side effects.
5. Start bare shell and REPL probes. Require denial before a session ID exists;
   no command-bearing stdin channel may remain available. Separately verify
   empty `write_stdin` polling and a single Ctrl-C, and reject other input.
   Exercise the canonical one-call orchestration form, reject unauditable code
   mode, and check every Bash-like surface exposed by that host.
6. Test untrusted, modified, disabled, `--dangerously-bypass-hook-trust`, and
   `permission_mode=bypassPermissions` separately. The CLI flag skips trust
   review but still runs the Hook. Permission mode never weakens TMB policy.
7. Measure one cold and at least 40 warm manifest invocations with `Bash pwd`.
   This read-path benchmark excludes the SQLite query used by write gates.
   Cold must be at most 1 second, warm median at most 100 ms, warm p95 at most
   250 ms, and the manifest timeout exactly 5 seconds.
8. Uninstall or roll back to the last trusted empty-Hook build. Start a fresh
   task and verify that Scope 4 Skills, MCP tools, Agent files, unrelated profile
   entries, and project state match their before-state.

Any protected-branch or out-of-lane write side effect, missing installed-cache
Hook, post-deny execution, persistent receiver, digest fail-open, or Desktop
mismatch stops the release. A policy edit invalidates the runtime digest and
the previous live record. Recompute the digest, accept the user re-trust cost,
and rerun the full matrix.

The repeatable behavior and known limits are recorded in
[`SCOPE_5_PRD.md`](../adapters/codex/SCOPE_5_PRD.md). Scope 5 never writes
`~/.codex/hooks.json`; plugin Hook discovery is a release prerequisite, not a
reason to expand installation permissions.
