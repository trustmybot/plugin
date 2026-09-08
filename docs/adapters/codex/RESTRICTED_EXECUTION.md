# Restricted Codex command execution

The unpublished Scope 5 candidate runs Git, forge and validation commands through
an installed macOS runner. The Hook checks the command, branch and paths. The
runner applies the process restrictions before starting the executable. Ordinary
reviewed file reads, native tools and contained patches retain their separate
Hook policies.

## Calling the runner

Use one static `tools.exec_command` call inside `functions.exec`. Its fields must
include the canonical `workdir`, `shell: "/bin/sh"`, `login: false` and
`tty: false`. The `cmd` value must match the installed bundle's canonical
`makeRestrictedCommand` output exactly: `/usr/bin/env -i`, the reviewed host
PATH, host-pinned plugin data path, canonical Node executable, installed runner,
bundle digest, canonical cwd and one reviewed command. No caller-selected Node
flags, environment variables, entrypoints or additional shell operations are
accepted.

A raw Git, forge or validation call is denied. For short, otherwise-approved
commands on macOS, the denial includes the exact static call for that installed
bundle and cwd. Test and integration code can also call
`makeRestrictedCommand(command, cwd, { pluginRoot, pluginData })`; both host paths
must match the Hook context. The generated call is specific to that installation. Do not copy its
digest or paths between versions, machines or checkouts.

If the outer host sandbox prevents `sandbox-exec` from applying a profile,
execution fails before the target starts. The exact wrapper may request the
host's `sandbox_permissions: "require_escalated"` with an explanation. The host
still decides that request; it does not remove the runner's inner restrictions.
Raw commands cannot request this exception. There is no unsandboxed fallback.

## Process permissions

| Mode | Writable paths | Network | Executable behavior |
|---|---|---|---|
| Validation | Ordinary checkout files and private scratch | Denied | Normal children inherit the sandbox |
| Git query | Private scratch | Denied | Helpers inherit the read-only sandbox |
| Local Git delivery | Git metadata and private scratch | Denied | Process forks denied; configured hooks, filters, signing and executable repository hooks refused before mutation |
| Forge | Private scratch | Allowed for the trusted CLI | Only fixed trusted executables; target and configuration bound before execution |
| HTTPS push | Git metadata and private scratch | Allowed for fixed Git transport executables | Explicit current-branch refspec; arbitrary helpers, SSH and executable repository hooks refused |

Validation cannot write the root's Git metadata, `.tmb`, `.claude`, `.codex`,
installed plugin, or host-pinned plugin data. It cannot read the root
`.tmb`, `.claude`, `.codex`, or pinned plugin data. Other reads are limited to
the checkout, Git metadata, plugin runtime, private scratch and approved
system/toolchain roots. Symlinks do not grant target permissions. The runner
refuses hard-link aliases and special files in writable trees before starting; the profile also
blocks new protected hard links and renaming protected ancestors.

The approved toolchain read roots are system directories, supported installed
toolchains and the selected executable's installation directory. This permits
ordinary runtime and dependency loading. These are trusted host installations;
the runner does not establish a hostile multi-user filesystem boundary. The
fixed Apple Git launcher is allowed despite its system-managed shared inode.
Repository or plugin executables, including case and Unicode aliases, cannot
be selected as trusted host tools. Bootstrap also rejects executables from external
Git and common directories. Version-manager shims resolve the host default Node
from `/` with a sanitized, verified HOME; project-local version configuration is
not loaded before Hook validation.

Local Git author name and email are read through a bounded, read-only preflight.
Only those identity values are passed into the otherwise isolated Git
environment. The runner refuses custom hooks, filters and signing instead of
silently bypassing their configured semantics. Read-only Git helpers cannot
change checkout or Git files, even when Git's display flags do not disable them.

## Forge and push binding

Only one `origin` URL is accepted, on GitHub.com or GitLab.com. An optional push
URL must identify the same repository. Enterprise hosts, multiple URLs,
configuration includes, URL rewrites, proxies, custom credential and transport
helpers, and implicit push options are unsupported and fail explicitly.

The trusted CLI reads the matching stored host credential under a read-only,
network-denied preflight. The command receives the credential only in its
private environment, with a fresh HOME/configuration directory. Forge commands
also run from scratch, so repository CLI aliases and host overrides cannot be
loaded. Credentials are not printed, put in URLs or written to scratch files.
Dynamic `--jq`/`--template` formatters are refused because they can expose the
credential environment; `--json` field output remains available.

`gh` uses its stored credential for the explicit hostname. `glab` uses its
documented global, host-specific token lookup. Environment-only credentials and
custom configuration locations are not inherited. An old CLI configuration
that requires migration is refused by the read-only preflight; migration must
be performed separately through the normal CLI. A numeric current branch cannot
serve as an implicit PR selector; use an explicit numeric PR/MR ID.

Push uses HTTPS, an explicit `HEAD:refs/heads/<current branch>` refspec and the
bound credential header. It does not enable arbitrary credential helpers or
SSH commands. For `-u`/`--set-upstream`, local tracking is configured only after
push succeeds. If that local step fails, the error identifies the successful
push so the caller does not repeat it.

## Limits and validation

The foreground command has a ten-minute deadline and an 8 MiB combined output
limit. Interrupts trigger bounded process-group termination. Cleanup cannot
guarantee termination of a descendant that starts a separate session or process
group. These descendants retain the same sandbox, but the foreground deadline
does not limit their lifetime. The runner enforces process permissions without
providing complete process supervision.

This implementation is qualified locally on macOS arm64. Other platforms deny
this execution surface. The existing configured-branch reader also has explicit
[WAL compatibility limits](SCOPE_5_PRD.md). Tests requiring network services,
arbitrary host files, custom Git helpers or nested operating-system sandboxes
may fail under these restrictions. A command signature does not promise that
every project's test suite is compatible.

The local tests exercise mutable Node source and its child, npm lifecycle
scripts, real Git staging/commit and clean filters, protected paths, aliases,
signal handling and configuration binding. Real `gh` credential export is
tested with fake credentials in an isolated directory. Real `glab`, remote
push/PR writes and the complete clean-SHA CLI/Desktop installation and trust
matrix remain unverified. This documentation does not declare release acceptance
or Claude workflow parity.
