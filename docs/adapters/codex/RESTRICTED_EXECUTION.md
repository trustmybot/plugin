# Restricted Codex command execution

**Known host blocker:** Unmodified Codex CLI `0.151.0` and `0.153.4` report
`exec_command` to the Hook as `Bash` with only the command string. They do not
provide the resolved launch settings needed to verify restricted execution, so
the Hook rejects their command-only Bash calls, including file reads and `pwd`.
Git, forge and validation execution through these releases remains unavailable.

The candidate policy supports a companion host patch that supplies top-level
`execution_context`. Eight local integration scenarios passed with the installed
plugin, covering the patched CLI and an unmodified CLI comparison. The host API
has not been merged or released, and the complete Desktop matrix and L6 acceptance
remain pending. The contract below
describes the companion integration, not support in an unmodified CLI.

The unpublished Scope 5 candidate runs Git, forge and validation commands through
an installed macOS runner. The Hook checks the command, branch and paths. The
runner applies the process restrictions before starting the executable. Ordinary
reviewed shell reads require the same verified launch settings. Native tools
and contained patches retain their separate Hook policies.

## Calling the runner

With the companion host patch, the Hook receives `Bash` and exactly
`tool_input: { "command": ... }`, plus a separate top-level `execution_context`
from the host's prepared invocation. The current acceptance target is macOS
arm64. The launch check requires local execution with
`kind: "exec_command"`, `shell_mode: "direct"`, `is_remote: false`,
`login: false` and `tty: false`. The resolved `argv` must be exactly
`["/bin/sh", "-c", command]`. Its canonical `cwd` must match the Hook's canonical
cwd. `environment_id` must be nonblank, at most 256 UTF-8 bytes, and contain no
ASCII control characters.

These checks run before classifying any Bash command. A read such as
`cat marker.txt` must not be checked in one checkout and then executed in another.
Missing, invalid or extra launch fields reject even shell builtins such as `pwd`.
Native file reads, Codex diagnostics and exact plugin removal remain available.

Codex's requested `shell` parameter selects a shell type; it does not guarantee
the executable path. A different selected `sh` program is rejected even if the
caller requested `/bin/sh`. Values placed inside `tool_input`, including a
model-supplied `execution_context`, cannot establish the launch settings.

The existing static `tools.exec_command` call inside `functions.exec` remains
available for hosts that separately qualify that contract. Every nested
`exec_command`, including `cat`, `pwd` and `true`, must explicitly supply
`shell: "/bin/sh"`, `login: false`, `tty: false` and a canonical `workdir` exactly
matching the Hook's canonical cwd. Omitting a field or using an invalid value
rejects the call. This path does not establish compatibility with the unmodified
CLI versions above.

Git, forge and validation commands under either contract must match the installed
bundle's canonical `makeRestrictedCommand` output exactly: `/usr/bin/env -i`, the reviewed host
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

Codex may supply the plugin data path before creating its directory. The Hook
resolves its existing directory ancestor and pins the future path without
creating it. That path remains protected. The runner rejects a pin that becomes
invalid or resolves to a different target.

If the outer host sandbox prevents `sandbox-exec` from applying a profile,
execution fails before the target starts. On the static nested path, only the
exact wrapper may request `sandbox_permissions: "require_escalated"` with an
explanation. The host still decides that request. The companion patch likewise
retains the host's existing sandbox and approval decisions; `execution_context`
does not grant an approval. Neither path removes the runner's inner restrictions
or provides an unsandboxed fallback.

Host compatibility requires trustworthy execution parameters that match the
launch. The companion patch's `argv` describes the resolved shell command before
the existing execution manager applies sandbox or platform shell wrappers. This
policy accepts only the local direct `/bin/sh -c` subset; remote execution,
zsh-fork and other shells remain outside this contract. The command's `env -i`
runs after the outer shell has started and cannot prove which startup files it
loaded. The adapter does not infer launch settings from the command string,
caller name or a mutable session log.

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

Forge and push processes can contact `com.apple.trustd.agent` for macOS TLS
certificate verification. This is an exact service permission; it grants no
general access to system services. HTTPS push can also read the two fixed files
required by Apple's Git: `/private/etc/ssl/openssl.cnf` and
`/private/etc/ssl/cert.pem`. This does not permit reading the rest of that
directory. Other execution modes cannot read these files. Certificate checks
remain enabled.

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

The runner's process restrictions have been tested locally on macOS arm64;
other platforms deny runner execution. The existing configured-branch reader also has explicit
[WAL compatibility limits](SCOPE_5_PRD.md). Tests requiring network services,
arbitrary host files, custom Git helpers or nested operating-system sandboxes
may fail under these restrictions. A command signature does not promise that
every project's test suite is compatible.

Eight local scenarios used real CLI processes and the installed plugin, with
deterministic Responses events from a local server. Nine installed files
matched the candidate byte for byte, and the Hook was reviewed and trusted
through the normal `/hooks` UI in an isolated profile. These runs exercised the
CLI's Hook and execution paths; they did not supply synthetic payloads directly
to the dispatcher.

The permitted read returned the expected checkout's marker. After the Hook
rejected a raw Node test, the fixture used its recovery arguments in a direct
`exec_command` call with `/bin/sh`, `login: false`, `tty: false` and the matching
workdir. The test ran, wrote an ordinary file and confirmed that the inner
sandbox denied a write to `.git/forbidden-marker`.

Wrong cwd, login enabled, TTY enabled and the default shell were each rejected
before a command started. Unmodified CLI `0.153.4` also rejected the read with the
same installed plugin and trust state. Under the host's outer read-only sandbox,
the patched runner failed with `EPERM` while creating private scratch and exited
125; the test's write target was not created. These results cover the eight
scenarios, not the complete CLI/Desktop matrix. The upstream patch is still
unreleased, and L6 acceptance remains pending.

The local tests exercise mutable Node source and its child, npm lifecycle
scripts, real Git staging/commit and clean filters, protected paths, aliases,
signal handling and configuration binding. Real `gh` credential export is
tested with fake credentials in an isolated directory. Real `glab`, remote
push/PR writes and the complete clean-SHA CLI/Desktop installation and trust
matrix remain unverified. This documentation does not declare release acceptance
or Claude workflow parity.
