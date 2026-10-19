# Containment

TMB writes nothing outside the project it runs in, whatever scope it is installed at. Every file a hook, a script, or the MCP server creates lives under the project root (`CLAUDE_PROJECT_DIR`), in the host's state directory: `.claude/<plugin>/` under Claude Code, `.tmb/<plugin>/` under Codex (see [`../adapters/ADAPTER_CONTRACT.md`](../adapters/ADAPTER_CONTRACT.md) Rule 3).

## The invariant

- **Writes stay in the project.** Nothing is created, modified, or deleted under `$HOME` — not `~/.claude`, not a sentinel, not a log, not a lock. A project without TMB state (no trajectory DB) gets nothing written at all; gates still run and allow.
- **Reads outside the project are read-only and named.** Hooks read Claude Code's `~/.claude/plugins/installed_plugins.json` (which install serves this project) and `~/.claude/settings.json` (to warn about leftover `_tmb_managed` hook groups from older versions). They never write either file.

Two exceptions, each declared once:

| Exception | Why | Where it is declared |
|---|---|---|
| Embedding model cache, `TMB_MODEL_CACHE_DIR` (default `HF_HOME`, else `~/.cache/huggingface`) | A shared, re-downloadable model cache; per-project copies would cost gigabytes | The only path outside the project the lint allows |
| [`scripts/maintenance/heal-mcp-cache.sh`](../../scripts/maintenance/heal-mcp-cache.sh) | A Human-run repair tool whose job is fixing Claude Code's own plugin config | [`tests/l1-lint/no-home-writes.allowlist`](../../tests/l1-lint/no-home-writes.allowlist); never a hook, never the server |

## Test runs never reach the project's trajectory DB

Every hook and `scripts/scan.sh` find the DB through one resolver, `tmb_db_path` in [`scripts/hooks/lib/query-task.sh`](../../scripts/hooks/lib/query-task.sh): `TRAJECTORY_DB_PATH`, else `CLAUDE_PROJECT_DIR`, else a walk up from the current directory — so a test run from any checkout inside the project would resolve the project's live `.claude/tmb/trajectory.db`. Under the test flags (`TMB_FORBID_LIVE_SYNC=1` or a set `TMB_TEST_RUN_ID`, `tmb_test_flag`) the resolver never walks: with neither variable set the DB is unresolved (gates allow, nothing is read or written) and it prints one stderr line, `tmb: trajectory DB unresolved: <flag> is set and neither TRAJECTORY_DB_PATH nor CLAUDE_PROJECT_DIR is (walk-up discovery disabled)`. scan.sh rides the same rule: with no DB resolved under a flag it exits 2 with `scan: TRAJECTORY_DB_PATH is required under TMB_FORBID_LIVE_SYNC/TMB_TEST_RUN_ID (walk-up discovery disabled) unless CLAUDE_PROJECT_DIR names a project with a DB`; it never spawns the live `claude` (plugins come from the `TMB_SCAN_PLUGIN_JSON` fixture, else `plugin_inventory.status: unavailable`) and reads MCP servers from the `TMB_SCAN_MCP_JSON` fixture instead of `~/.claude.json` (`mcp_inventory.status: unavailable` without one). Unit tests that fork scan.sh pin both through `pinScanEnv` in `mcp/trajectory-server/src/test/helpers.ts`; every L3 hook test pins `CLAUDE_PROJECT_DIR` or `TRAJECTORY_DB_PATH` to its fixture; the L3 runners put a refusing `sqlite3` shim first on `PATH` ([`tests/lib/live-db-shim.sh`](../../tests/lib/live-db-shim.sh)) and fail on any refusal. Rows a past run left behind are reported by the `no_fixture_rows_in_inventory` data contract (`trajectory_doctor`), never deleted by an agent: the Human decides.

## Where every artifact lives

Paths are relative to the project root; `<state>` is `.claude/<plugin>/` (Claude Code) or `.tmb/<plugin>/` (Codex).

| Path | Written by | What |
|---|---|---|
| `<state>/trajectory.db` (+ `world-model.kuzu`) | MCP server, hooks via `scripts/hooks/lib/db-write.sh` | Workflow state and the world model. The DB runs in WAL mode; its `-shm` and `-wal` files always sit beside it in `<state>/`, including the ones a gate read creates when no process holds the DB open (`tmb_gate_read`) |
| `<state>/logs/` | MCP server, hooks | `mcp-server.log`, `sql.log`, `issue-sync.log`, `mcp-health.log`, per-session logs |
| `<state>/sessions/<session_id>.plugin-hooks` | `plugin-hooks-marker.sh` (SessionStart) | 0-byte marker: this session runs the plugin's own hooks; pruned after 24 h |
| `<state>/sessions/<session_id>.install-notice` | `mcp-health-check.sh` (SessionStart) | 0-byte marker: the install-scope notice was shown this session; pruned after 24 h |
| `<state>/sessions/<session_id>.persona` (+ `.persona-notice`) | `session-start-persona.sh` (SessionStart), `user-prompt-persona.sh` (UserPromptSubmit) | 0-byte marker: bro's persona reached this session (or the notice that it could not); pruned after 24 h |
| `<state>/locks/events/<key>/` | `scripts/hooks/dispatch.sh` | One gate execution per event: the holder's `result`, `stderr` and `rc`; pruned after 10 min |
| `<state>/locks/scope-notes/<task>/<cksum>/` | `swe-scope-fence.sh`, `swe-boundary.sh` | Empty marker: the swe was told this path is outside its task's `files[]`, so the note shows once per path per task. Scope itself is judged at close by `bro_atomic_close` |
| `<state>/locks/verify-<task>-<sha>/` | `swe-verification-gate.sh` | One verification run per (task, worktree HEAD) at a time; the run itself is recorded in the trajectory DB (`verification_runs`) |
| `.claude/settings.local.json` (PreToolUse entries only) | `/onboard`, on Yes to headless enforcement | The opt-in headless shim, each entry stamped `_tmb_managed` + `_tmb_project` |
| `<state>/resolve-hook.sh` | `/onboard`, on Yes to headless enforcement | The resolver the shim entries call |

A user project's `CLAUDE.md` is never written: no hook, no agent and no tool writes, edits or removes anything in it. bro's persona reaches a session as injected context, from `session-start-persona.sh` (SessionStart) and, for a session with no persona marker, once from `user-prompt-persona.sh` (UserPromptSubmit); both read the plugin's `CLAUDE.md` and write only the session marker. `onboard_apply` takes no `persona` argument.

## No context or effort settings

TMB never writes Claude Code's context or effort settings (`autoCompactWindow`, `model`, `effortLevel`) into the user's project or user settings. Token savings come from TMB's own design, not from changing how the user's Claude Code runs.

## One install, one dispatcher, one execution

A hook can be registered more than once for the same event: a project install beside a user-scope one, two channels, the headless shim beside the plugin's own hooks. Three rules keep that from running a gate twice or at two versions.

1. **One install per project.** [`scripts/hooks/lib/resolve-install.sh`](../../scripts/hooks/lib/resolve-install.sh) picks the install this project uses. A dev checkout — an invoking plugin root outside any plugins cache that no `installed_plugins.json` entry names, as with `--plugin-dir` — always runs its own gates, whatever project or user entries exist. Otherwise it reads `installed_plugins.json`: a `project`/`local` entry whose `projectPath` is this project wins over a `user` entry; between two project entries the newest `installedAt` wins, with a stderr notice naming both; entries whose `installPath` is gone are skipped. With no entry the invoking plugin root is used.
2. **One dispatcher per hook event.** Every `hooks/hooks.json` command is `"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" <gate>`, and the headless shim execs `dispatch.sh <gate> --shim`. The dispatcher runs the resolved install's `scripts/hooks/<gate>.sh`, so a stale or user-scope invocation executes the project's version. When the resolved install lacks the gate, the dispatcher's own copy runs, with a stderr notice. An invalid gate name, or a gate found in neither install, exits 1 with a stderr line — a visible hook error, never a silent allow; a fail-closed gate found in neither denies instead (below). [`tests/l1-lint/hooks-via-dispatcher.sh`](../../tests/l1-lint/hooks-via-dispatcher.sh) fails on a registration that calls a gate directly.
3. **One execution per (event, payload, gate).** The dispatcher keys each invocation on the sha256 of event, session, tool name, canonical tool input, tool-use id and gate (SessionStart: session and gate) and takes a `mkdir` lock at `<state>/locks/events/<key>/`. The holder runs the gate and emits its output; a concurrent duplicate waits for the result and replays only a denial, so context and banners appear once. A finished result answers duplicates for a few seconds (`TMB_DISPATCH_WINDOW_S`, default 5); a later identical event runs the gate again.

**Gates fail closed.** Claude Code (2.1.295 and later) treats a command hook that crashes, times out, or exits non-zero without valid JSON as continue unless its registration carries `"onFailure": "block"`, so every deny-capable registration in `hooks/hooks.json` carries that key and observe-only hooks (hints, prescan, nudges, metering, logging) keep the default. The dispatcher reads the same key: for such a gate, a missing script, a non-zero exit other than 2 without a deny, or an error in the dispatcher itself becomes a blocking decision (PreToolUse `permissionDecision: "deny"`, other events `decision: "block"`) with exit 0 and a stderr line naming the cause, so older clients fail closed too; a gate's own deny printed before a non-zero exit is kept. [`tests/l1-lint/hook-onfailure.sh`](../../tests/l1-lint/hook-onfailure.sh) derives the deny-capable set from the scripts (a deny JSON, `exit 2`, a `tmb_deny_*`-style helper from a sourced library, or a deny-capable script it runs) and fails when one lacks the key.

**Ordered gates, and no jq.** Claude Code runs the hooks.json entries of one matcher in parallel, so a gate can act on a call another gate denies — an observation row or a verification run written for a call that never happens. The trajectory-server gates are therefore one registration, `dispatch.sh trajectory-gates`, which runs `agent-arg-matches-caller`, `swe-brief-gate` and the tool's own gate (`swe-verification-gate`, `reviewer-identity-observe`, `cheatcode-install-approval`) in that order and stops at the first deny; each gate keeps its own dedupe key and lock, runs under a watchdog at its own timeout (an overrun is killed and denies), and a duplicate chain whose waiter gives up ends without running later gates. A chain is fail-closed whatever hooks.json says, so the headless shim, which copies no `onFailure`, gets the same behaviour. The dispatcher reads `timeout` and `onFailure` from hooks.json with awk, so on a host without jq a fail-closed gate denies naming jq instead of allowing, and the SessionStart prescan names the missing jq.

At SessionStart, `mcp-health-check.sh` says once per session when a user-scope install is ignored in favour of the project install, or recommends `--scope project` when only a user-scope install exists.

## Runtime containment: agents write only under their run's root

The invariant above covers what TMB itself writes. The agents it runs are held to the same boundary, in three layers.

**Run root.** Every `agent_runs` row carries `root_dir`: the project root for bro rows (opened by `task_create_batch`, `task_provision`, `task_retry`), the task's worktree (`<repo>/.claude/worktrees/<slug>`) for the swe row the Agent spawn opens (`record-swe-spawn.sh`; `task_brief` opens it when the spawn did not). Rows also carry `host`, the dominant `model` and, once closed, an `exit_reason` (see [`../contributing/ENUMS.md`](../contributing/ENUMS.md)).

| Tier | Layer | What it holds |
|---|---|---|
| 0 | Claude Code's Bash sandbox, written by `/onboard` (`sandbox_enforcement`, default **no**) | OS-level: Bash, in the main loop and in every subagent, writes only to the working directory, the sandbox temp dir and `sandbox.filesystem.allowWrite` (the project and `TMB_MODEL_CACHE_DIR`), and reaches only the hosts in `sandbox.network.allowedDomains`. Does not cover the Write/Edit tools. |
| 1 | Server tools (host-neutral) | `task_provision`, `pr_monitor_worktree` and `cheatcode_install` refuse a path outside the project with `{"error":"outside_project"}`; `cheatcode_install` refuses `scope=global` the same way (install project-local instead). `pr_monitor_worktree` checks the commit out under `<repo>/.claude/worktrees/pr-review-<sha>`. |
| 2 | [`scripts/hooks/containment-guard.sh`](../../scripts/hooks/containment-guard.sh) (PreToolUse Write/Edit/MultiEdit/NotebookEdit/Bash) | Denies a write outside the run's root, resolved from the caller's identity, never its cwd: a swe's root is the `root_dir` of its own run — the swe row whose `spawn_id` is the payload `agent_id`, bound at its first `task_brief` (`tmb_caller_run`); a swe with an `agent_id` but no bound run is denied every write (devices aside) with the instruction to call `task_brief` first and never widens to the project; a swe payload with no `agent_id` (headless or legacy) falls back to the open swe row of the task its cwd's worktree resolves to; pr-reviewer and bro get `CLAUDE_PROJECT_DIR`. File tools by the canonical `file_path`; Bash by its `cwd` (not for a swe with an `agent_id`: its spawn cwd is the main checkout, so a bound swe's Bash is judged by its write targets alone) and every write position [`lib/cmd-analysis.sh`](../../scripts/hooks/lib/cmd-analysis.sh) finds (redirects, `tee`, `cp`/`mv`/`rsync`/`install` destinations, `mkdir`, `rm`, `touch`, both ends of a link — `ln`, `ln -s`, `link`, `cp -s`, `cp -l` — `git worktree add`, `git clone`, `sed -i`, interpreter one-liners and programs fed to an interpreter through a heredoc) in each statement's own `cd` dir; data heredocs and quoted text are data. Paths are canonicalized the way the kernel resolves them (`realpath -m`): each existing symlink is followed before a later `..` applies, so `<root>/link/../x` with `link` pointing outside is outside; `..` collapses lexically only inside the part that does not exist yet. Writes are allowed under the roots in the table below, plus `/dev/null`-style devices; reads are not judged. Each denial writes a `containment_denied` audit row naming the tool, path, root and task (an unbound swe's row has a null root and `reason` `unbound_caller`). |

### Allowed write roots

| Root | Why |
|---|---|
| The run's root — a swe's own task worktree (none until its run is bound), else the project | The work itself |
| `TMB_MODEL_CACHE_DIR` (default `HF_HOME`, else `~/.cache/huggingface`) | The shared embedding model cache, the one TMB path outside the project |
| Host-owned: the host's temp dir, `$TMPDIR` when the host sets it, and its realpath | Ephemeral space the Claude Code sandbox itself leaves writable (`/tmp/claude-<uid>`). `/tmp` outside it is denied. TMB's own scripts and server never write there (`no-home-writes.sh`). |
| Host-owned, **main session only**: Claude Code's per-project dir `~/.claude/projects/<slug>/` (the project path with every non-alphanumeric character turned into `-`, e.g. `-Users-Zax-Git-GitHub-TMB`) and its plans dir `~/.claude/plans/` (`$CLAUDE_CONFIG_DIR` replaces `~/.claude` when set) | Claude Code's own state — auto-memory, session files, plan mode — not TMB's artifacts. Allowed when no `agent_type` (or `bro`) is on the payload, wherever its cwd is; swe, pr-reviewer and consultants keep the strict rule. Every other path under `~/.claude`, and another project's slug, stays denied. |

The hook is a parser, not a jail. A program fed to python, node, perl, ruby or sh through a heredoc (`python3 - <<'EOF'`) is analysed like a one-liner; a data heredoc (`cat > f <<EOF`) is never read. A variable in a write target resolves from assignments earlier in the same command (`OUT=/x; cat > "$OUT"` is judged as `/x`); `$PWD` is the statement's own dir (the cwd, or the dir a preceding `cd` set), `$OLDPWD`, within the `&&` chain of a `cd`, the dir before it (`cd -` swaps the two; elsewhere it is unknown, since a failed `cd` leaves the shell's own), and `$HOME`, `$TMPDIR` and `$TMB_MODEL_CACHE_DIR` are the host's. A `for` or `while read` loop variable fed by a glob or by one `find`, `ls`, `git ls-files`, `git diff --name-only`, `rg --files` or `fd` whose literal path arguments (else the dir it runs in) all lie inside the root is judged where the listed files lie, the listed paths themselves included, so a bulk `sed -i` over the worktree passes while `"$f/.."` or `"$f.bak"` of the root does not (for a non-`prompt_bearing` swe, `swe-boundary.sh` denies a listing that starts above the root's prompt-surface dirs without excluding them); a source outside the root, a pipeline, `$(cat list)` or a variable source leaves the variable unresolvable. A write target with `..` after a glob component is denied: the glob may match a symlink, so where the `..` lands is unknown. A `VAR=value` prefix does not reach its own command's words, as in the shell, so `HOME=/inside cat > "$HOME/.bashrc"` is judged on the real `~/.bashrc`; a target behind a variable the command does not set, or built by `$( )`, is allowed only when the literal directory before the variable is inside the root, else denied with the variable named (`swe-boundary.sh` denies it outright for a non-`prompt_bearing` swe). Variables set in an earlier Bash call and programs an interpreter reads from a file are not followed. Tier 0 is the layer that cannot be talked around for Bash; the hook adds the file tools, the swe-worktree boundary (the sandbox allows the whole project) and the audit trail.

### Tier 0 settings block

Only on an explicit **yes** does `onboard_apply` merge into `<project>/.claude/settings.local.json`:

```json
{ "sandbox": { "enabled": true,
               "filesystem": { "allowWrite": ["<project>", "<TMB_MODEL_CACHE_DIR>"] },
               "network": { "allowedDomains": ["github.com", "api.github.com", "*.githubusercontent.com", "registry.npmjs.org", "<host of each HTTPS remote>"] } } }
```

Every other key, and every `allowWrite` path and `allowedDomains` host already present, is kept; TMB never writes `excludedCommands`. What TMB added is recorded in `plugin_config.sandbox_settings` (`enabled_set`, `allow_write`, `allowed_domains`); **no** removes exactly that. Only a project named by the trajectory DB path is written. MCP servers and hooks run outside the sandbox, so the embedding-model download needs no domain.

**Network probe — why the default is still no.** The sandbox sends Bash network traffic through a proxy that, headless, refuses every host not in `allowedDomains` (empty by default), and git over SSH bypasses the proxy. [`tests/l5-l6/probes/sandbox-network-probe.sh`](../../tests/l5-l6/probes/sandbox-network-probe.sh) measures TMB's remote commands in one `claude -p --model haiku` session per setup: **A** is the filesystem-only block, **B** is A plus the allow-list above. `host` runs the same commands outside Claude Code. Claude Code 2.1.303, macOS, 2026-10-18:

| Command | host | A: filesystem only | B: A + allowedDomains |
|---|---|---|---|
| `gh api user --jq .login` | pass | FAIL (1): proxy denies `api.github.com` | FAIL (1): `x509: OSStatus -26276`, the macOS TLS trust service is unreachable |
| `git ls-remote origin HEAD` | pass | FAIL (128): proxy denies `github.com` | pass |
| `git push --dry-run origin HEAD:refs/heads/tmb-probe-noop` | pass | FAIL (128): proxy denies `github.com` | pass |
| `npm view is-number version` | pass | FAIL (1): proxy denies `registry.npmjs.org` | FAIL (1): `EPERM` writing `~/.npm/_cacache` |
| `bun add is-number` | pass | FAIL (1): bun cannot open its temp dir | FAIL (1): bun cannot open its temp dir |

The allow-list fixes every network denial; no B failure is a missing host. The three left are local to the sandbox (TLS trust for Go's `gh`, npm's home cache, bun's temp dir), so a fresh onboard keeps the default at **no** and `SANDBOX_NETWORK_PROBE` in `onboard-sandbox.ts` records the failed commands. The default becomes **Yes (Recommended)** on a fresh onboard only when a rerun passes every B command and no repo remote is SSH (`git@…` or `ssh://`); with an SSH remote the Yes option says git over SSH bypasses the proxy. A re-onboard defaults to keeping the stored answer.

### Phase-0 finding (Claude Code 2.1.296, 2026-10-11)

The keys are `sandbox.enabled` and `sandbox.filesystem.allowWrite` (siblings `denyWrite`, `allowRead`, `denyRead`; also `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`, `excludedCommands`). A live `claude -p --model haiku` run in a throwaway project with `settings.local.json` = `{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"filesystem":{"allowWrite":["<allowed>"]}}}`, an empty `HOME`, and the OAuth token from the environment:

| Write | Main loop Bash | Subagent Bash (Agent tool, general-purpose) |
|---|---|---|
| `<project>/x.txt` (cwd) | written | written |
| `<allowed>/x.txt` (allowWrite) | written | written |
| `<outside>/x.txt` (sibling of the project) | **blocked**: `operation not permitted`, exit 1 | **blocked**: `operation not permitted`, exit 1 |

(a) The sandbox applies to subagent Bash; (b) a write outside the allow-list is blocked. One caveat: the sandbox's own temp dir (`TMPDIR=/tmp/claude-<uid>`) is writable by default, so a first probe whose "outside" path lay under `/tmp/claude-<uid>` was written. The hook (Tier 2) denies `/tmp` paths outside the root regardless.

## Enforcement

| Check | What it fails on |
|---|---|
| [`tests/l1-lint/no-home-writes.sh`](../../tests/l1-lint/no-home-writes.sh) | Any write under the home directory from `scripts/`, `skills/*/scripts/` or the server |
| [`tests/l1-lint/no-unpinned-scan-in-tests.sh`](../../tests/l1-lint/no-unpinned-scan-in-tests.sh) | A unit test file under `mcp/trajectory-server/src/test/` that references `scan.sh`, `scan_run` or `project_scan` without, outside comments, a `pinScanEnv(` call or a `TRAJECTORY_DB_PATH` assignment (a mention is not a pin) |
| [`tests/l1-lint/hook-tests-pin-project.sh`](../../tests/l1-lint/hook-tests-pin-project.sh) | An L3 hook test that invokes a hook (`scripts/hooks/<hook>.sh`, `dispatch.sh`, the `lib/query-task.sh` resolver) without setting `CLAUDE_PROJECT_DIR` or `TRAJECTORY_DB_PATH` |
| Resolver rule (`tmb_db_path`, [`tests/l3-integration/hooks/db-lookup-no-walkup.test.sh`](../../tests/l3-integration/hooks/db-lookup-no-walkup.test.sh)) | A DB resolved by walking up while `TMB_FORBID_LIVE_SYNC=1` or `TMB_TEST_RUN_ID` is set and neither `TRAJECTORY_DB_PATH` nor `CLAUDE_PROJECT_DIR` is |
| [`tests/l1-lint/hooks-via-dispatcher.sh`](../../tests/l1-lint/hooks-via-dispatcher.sh) | A hooks.json command that is not `dispatch.sh <gate>` (or a chain), or a gate script that is missing or not executable |
| [`tests/l1-lint/hook-onfailure.sh`](../../tests/l1-lint/hook-onfailure.sh) | A deny-capable hooks.json registration without `"onFailure": "block"`, or a deny-capable gate that allows silently without jq (warns on an observe-only one that carries the key) |
| L3 runners (`tests/l3-integration/hooks/run.sh`, `tests/l3-integration/mcp/run.sh`) | Anything left in the empty temp `HOME` they run under |
| L3 runners' `sqlite3` shim ([`tests/lib/live-db-shim.sh`](../../tests/lib/live-db-shim.sh)) | Any `sqlite3` argument (path, `file:` URI, relative path, quoted path in SQL) under `<dir>/.claude/tmb/` for the checkout, its main checkout or any of their ancestors — the real project's DB dir. The shim refuses it (exit 1), logs it, and the runner fails with the refusal list; every other call is exec'd to the real `sqlite3` |
| [`tests/l3-integration/hooks/containment-guard.test.sh`](../../tests/l3-integration/hooks/containment-guard.test.sh) | An agent write outside its run's root that the guard allows, a denial without an audit row, or a read / model-cache write that it denies |
| [`tests/l3-integration/hooks/dispatch.test.sh`](../../tests/l3-integration/hooks/dispatch.test.sh) | A duplicate execution, a duplicated banner, a lost denial, the wrong install's gate, a missing gate that exits 0, a fail-closed gate that dies without a deny, a chain gate that runs after a deny, or a fail-closed gate that allows without jq |
