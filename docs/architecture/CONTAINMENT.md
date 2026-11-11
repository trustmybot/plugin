# Containment

TMB writes nothing outside the project it runs in, whatever scope it is installed at. Every file a hook, a script or the MCP server creates lives under the project root, in the host's state directory. The agents TMB runs are held to the same boundary. This doc states the boundaries, the invariants that keep them, and why; for the code that enforces each one, ask the world model (`world_model_search`).

## The invariant

- **Writes stay in the project.** Nothing is created, modified or deleted under the user's home directory: no Claude Code config, no sentinel, no log, no lock. A project without TMB state gets nothing written at all; gates still run and allow.
- **Reads outside the project are read-only and named.** Hooks read Claude Code's plugin install registry (which install serves this project) and its user settings (to warn about duplicate enabled copies and about hooks left by pre-1.1.0 onboarding). They never write either.
- **A user project's `CLAUDE.md` is never written.** No hook, agent or tool writes, edits or removes anything in it. bro's persona reaches a session as injected context, and the hooks that inject it write only a per-session marker in the state directory.
- **No context or effort settings.** TMB never writes Claude Code's context, model or effort settings into project or user settings. Token savings come from TMB's own design, not from changing how the user's Claude Code runs.

Three exceptions, each declared once:

| Exception | Why |
|---|---|
| The embedding model cache (shared with other Hugging Face tools, relocatable) | A shared, re-downloadable cache; per-project copies would cost gigabytes. It is the only path outside the project the home-write lint allows. |
| The MCP server's runtime dependencies, installed once per plugin install into Claude Code's plugin data dir and linked from each plugin version | The embedding library ships per-platform native builds, so it stays outside the bundle, and a marketplace install runs no package install. The dependencies belong to the install, not to a project. The install hook runs only when the package does not resolve, and its package-manager caches go to the project's state directory when there is one. |
| A Human-run repair command for Claude Code's MCP cache | Its job is fixing Claude Code's own plugin config. It is never a hook and never the server. |

## Artifacts in the project

Everything TMB writes sits in the state directory: the trajectory DB (with its write-ahead-log files beside it), logs, short-lived per-session markers, and the lock directories that dedupe hook calls, show a scope note once, and serialize verification runs. Markers and locks are pruned on a timer. Outside the state directory TMB writes only when the Human says yes to an onboarding question: the opt-in headless enforcement shim and the Tier 0 sandbox block go into the project's local Claude Code settings, each entry stamped as TMB's, and a git work tree that does not ignore that local settings file gets one ignore line so it stays out of commits.

## Test runs never reach the project's trajectory DB

Every hook finds the DB through one resolver, which falls back to walking up from the current directory, so a test run from any checkout inside the project would otherwise resolve the live DB. Under the test flags the resolver never walks: with no explicit DB path or project dir the DB is unresolved, gates allow, nothing is read or written, and one stderr line says why. The scan walker resolves no DB; it writes only the one it is handed, and under a test flag it never spawns the live `claude` or reads the user's MCP config, using fixtures or reporting the inventory unavailable instead.

Test suites pin the DB or project dir to a fixture, and the integration runners put a refusing `sqlite3` shim first on the command search path and fail on any refusal. Rows a past run left behind are reported by a data contract in `trajectory_doctor`, never deleted by an agent: the Human decides.

## One install, one entry point, one execution

A hook can be registered more than once for the same event: a project install beside a user-scope one, two channels, the headless shim beside the plugin's own hooks. Three rules keep that from running a gate twice or at two versions.

1. **One install per project.** A dev checkout run with `--plugin-dir` always runs its own gates. Otherwise a project-scope install for this project wins over a user-scope one, the newest of two project installs wins with a notice naming both, and installs whose files are gone are skipped. At session start the Human is told once when a user-scope install is ignored, or advised to install at project scope when only a user-scope one exists.
2. **One entry point per hook event.** Every hook registration runs the router, bar the liveness sentinel, whose blocking exit is a wake and not a deny; the headless shim runs the same router. The router hands the call to the resolved install's router, so a stale or user-scope invocation executes the project's version; where that router does not serve the event, the invoking install decides, with a notice. Session start and worktree creation check for node first, so a missing runtime is named rather than a bare error. An unknown gate name is a visible hook error, never a silent allow.
3. **One execution per call.** The router keys each invocation on its event, session, tool, canonical input and part, and takes a lock on that key. The holder runs the gates; a concurrent duplicate waits and replays only a denial, so context and banners appear once. A finished result answers duplicates for a few seconds; a later identical event runs the gate again. A holder past its deadline is dead and its lock reclaimed; a live holder is never reclaimed. A periodic sweep removes old results and dead locks.

**Gates fail closed.** Claude Code treats a command hook that crashes, times out or answers without valid output as continue unless its registration asks to block on failure, so every deny-capable registration asks for it and observe-only hooks (hints, prescan, nudges, metering, logging) do not. The router itself fails closed by gate kind: an enforcement gate that throws, answers unparseably, is unknown, overruns its deadline or is left no budget denies, naming itself; an advisory gate's failure is dropped and logged. Because the router decides this, not the registration, the headless shim gets the same behaviour.

**Ordered gates.** Claude Code runs the hooks of one matcher in parallel, so a gate could act on a call another gate denies, such as recording a verification run for a call that never happens. Each event therefore has one router registration per group, with matchers that never overlap, and the router runs a group's gates in a fixed order and stops at the first deny. A few groups start their gates concurrently for speed, but still read the answers in that order, so the first deny in order answers and an overrunning enforcement gate still denies. Where enforcement and advisory gates share a group, enforcement runs first, so an advisory overrun cannot leave it unrun. A tool no group matches runs no gates.

## Runtime containment: agents write only under their run's root

The agents TMB runs are held to the same boundary, in three layers.

**Run root.** Every agent run records its root: the project for bro, the task's worktree for swe. A write is judged against the root of the caller's own run, resolved from the caller's identity and never from its cwd, because a swe is spawned with the main checkout as its cwd and a cwd says nothing about who is writing. A swe's run is bound to its identity at its first `task_brief`; until then it has no root and every write but one to a device sink is denied with the instruction to call `task_brief`, never widened to the project. A swe payload with no identity (headless or legacy) falls back to the open swe run of the task its worktree resolves to. code-reviewer and bro get the project.

| Tier | Layer | What it holds |
|---|---|---|
| 0 | Claude Code's Bash sandbox, written by `/onboard` on an explicit yes | OS-level and not talked around: Bash, in the main loop and in every subagent, writes only to its working directory, the sandbox temp dir, the project and the model cache, and reaches only allow-listed hosts. It does not cover the file-editing tools, and it allows the whole project, not one worktree. |
| 1 | Server tools, host-neutral | Tools that take a path or install something (`task_provision`, `pr_monitor_worktree`, `cheatcode_install`) refuse a path outside the project, and a global install is refused in favour of a project-local one. PR review checkouts go under the repo's worktrees dir. |
| 2 | The containment guard hook, on file tools and Bash | Denies a write outside the run's root. It adds the file tools, the per-swe worktree boundary and an audit row for every denial. |

### What the guard judges

The guard is a parser, not a jail; its invariant is that a write it cannot prove lands inside the root is denied.

- **File tools** are judged by their canonical target path. **Bash** is judged by every write target a shell parser finds in the command (redirects, copy and move destinations, deletes, links, directory options, the working tree of a mutating git command, and the targets of inline interpreter programs), each in the directory its own statement runs in. Data heredocs and quoted text are data. Reads are never judged.
- **Paths resolve the way the kernel does**: symlinks are followed before a later `..` applies, so a link that points out of the root is outside. A target that leaves the root and comes back in is denied, since it lands on the root from outside.
- **Unknowns deny unless the literal prefix is inside the root.** A write target with an unknown part (a variable the command does not set to a literal, a command substitution, a relative path after a directory change the guard cannot resolve, a process call in an inline program whose command, arguments or cwd are not all literals, or a held or aliased write function) is allowed only when the literal directory before the unknown part is inside an allowed root, and denied otherwise. A process call whose command, arguments and cwd are all literals is not an unknown: it is judged as the shell command it runs, where it runs.
- **Some targets are never judged.** A command the parser cannot parse, a path a program builds at run time, and an inline program the guard cannot prove (a dynamic import, an evaluated string, introspection or any other call that could hide a write) are denied even behind a literal directory inside the root. Every such deny names which kind of unknown it hit. Only literals count as resolved, so the rules are an allowlist, not a blocklist.
- **Not followed:** variables set in an earlier Bash call, and programs an interpreter reads from a file. Tier 0 covers those for Bash.

### Allowed write roots

| Root | Why |
|---|---|
| The run's root: a swe's own task worktree (none until its run is bound), else the project | The work itself |
| The device sinks (`/dev/null`, the standard streams, the terminal and open file descriptors), for every caller, a swe without a bound run included | They store nothing, so discarding or echoing output cannot leave anything outside the root |
| The embedding model cache | The one TMB path outside the project |
| The host's own temp dirs, including Claude Code's per-user temp root when it is a real directory the user owns | Ephemeral space the sandbox itself leaves writable. The rest of `/tmp` is shared and stays denied. |
| The sanctioned scratch dir inside the root | Throwaway scripts, logs and data dumps; a separate gate denies prose files there, and deny messages name it |
| Main session only: Claude Code's own per-project dir and plans dir | Claude Code's own state (auto-memory, sessions, plan mode), not TMB's artifacts. swe, code-reviewer and consultants keep the strict rule; every other path under Claude Code's config dir, and another project's dir, stays denied. |

### Tier 0 settings

Only on an explicit yes does onboarding merge a sandbox block into the project's local settings: sandbox on, writes allowed to the project and the model cache, network allowed to GitHub, the npm registry and each HTTPS remote's host, and npm's and bun's caches moved from the home directory into the project so the write allowance never widens to the home directory. On macOS it also lets sandboxed Bash reach the system's certificate trust service, which `gh` and other Go tools need; Claude Code documents this as weakening network isolation, and the yes option says so. It also lets sandboxed Bash listen on loopback, so the dashboard starts inside the sandbox; that binds local ports only and opens no outbound host.

The merge keeps every setting the user already has, and TMB never adds sandbox exclusions. What TMB added is recorded, and a later no removes exactly that, keeping any value the user changed since. Nothing goes to user-scope settings. MCP servers and hooks run outside the sandbox, so the model download needs no allowed host.

**The default answer.** The sandbox proxies Bash network traffic and refuses unlisted hosts, and git over SSH bypasses the proxy. A recorded live probe per platform measures TMB's remote commands (GitHub API, git remote, push dry run, npm, bun) with and without the block, against the same commands outside Claude Code. A fresh onboard defaults to yes only when the host platform has a record, that record failed nothing, and no remote uses SSH; otherwise it defaults to no, and with an SSH remote the yes option warns about the bypass. A platform with no record yet defaults to no. A re-onboard keeps the stored answer, and the release gate reruns the probe and fails on a new failure.

**Why the hook still judges `/tmp`.** A live probe showed the sandbox applies to subagent Bash and blocks writes outside its allow-list, but leaves its own temp dir writable by default. The guard denies temp paths outside the host-owned roots regardless.

## Enforcement

Lints and tests hold each invariant above: no home-directory writes from scripts or the server; every unit test that runs the scan walker pins its environment; the resolver never walks up under a test flag; every deny-capable hook registration blocks on failure; the integration runners leave nothing in their empty temp home and refuse any `sqlite3` call on the real project's DB; the guard allows no write outside a run's root, audits every denial, and denies no read or model-cache write; and the router answers with the first deny in group order, denies on an enforcement gate's failure, and dedupes exactly one call per key.
