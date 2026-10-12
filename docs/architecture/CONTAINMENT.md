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

## Where every artifact lives

Paths are relative to the project root; `<state>` is `.claude/<plugin>/` (Claude Code) or `.tmb/<plugin>/` (Codex).

| Path | Written by | What |
|---|---|---|
| `<state>/trajectory.db` (+ `world-model.kuzu`) | MCP server, hooks via `scripts/hooks/lib/db-write.sh` | Workflow state and the world model |
| `<state>/logs/` | MCP server, hooks | `mcp-server.log`, `sql.log`, `issue-sync.log`, `mcp-health.log`, per-session logs |
| `<state>/sessions/<session_id>.plugin-hooks` | `plugin-hooks-marker.sh` (SessionStart) | 0-byte marker: this session runs the plugin's own hooks; pruned after 24 h |
| `<state>/sessions/<session_id>.install-notice` | `mcp-health-check.sh` (SessionStart) | 0-byte marker: the install-scope notice was shown this session; pruned after 24 h |
| `<state>/locks/events/<key>/` | `scripts/hooks/dispatch.sh` | One gate execution per event: the holder's `result`, `stderr` and `rc`; pruned after 10 min |
| `<state>/locks/scope-notes/<task>/<cksum>/` | `swe-scope-fence.sh`, `swe-boundary.sh` | Empty marker: the swe was told this path is outside its task's `files[]`, so the note shows once per path per task. Scope itself is judged at close by `bro_atomic_close` |
| `<state>/locks/verify-<task>-<sha>/` | `swe-verification-gate.sh` | One verification run per (task, worktree HEAD) at a time; the run itself is recorded in the trajectory DB (`verification_runs`) |
| `.claude/settings.local.json` (PreToolUse entries only) | `/onboard`, on Yes to headless enforcement | The opt-in headless shim, each entry stamped `_tmb_managed` + `_tmb_project` |
| `<state>/resolve-hook.sh` | `/onboard`, on Yes to headless enforcement | The resolver the shim entries call |

## One install, one dispatcher, one execution

A hook can be registered more than once for the same event: a project install beside a user-scope one, two channels, the headless shim beside the plugin's own hooks. Three rules keep that from running a gate twice or at two versions.

1. **One install per project.** [`scripts/hooks/lib/resolve-install.sh`](../../scripts/hooks/lib/resolve-install.sh) picks the install this project uses. A dev checkout — an invoking plugin root outside any plugins cache that no `installed_plugins.json` entry names, as with `--plugin-dir` — always runs its own gates, whatever project or user entries exist. Otherwise it reads `installed_plugins.json`: a `project`/`local` entry whose `projectPath` is this project wins over a `user` entry; between two project entries the newest `installedAt` wins, with a stderr notice naming both; entries whose `installPath` is gone are skipped. With no entry the invoking plugin root is used.
2. **One dispatcher per hook event.** Every `hooks/hooks.json` command is `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh <gate>`, and the headless shim execs `dispatch.sh <gate> --shim`. The dispatcher runs the resolved install's `scripts/hooks/<gate>.sh`, so a stale or user-scope invocation executes the project's version. When the resolved install lacks the gate, the dispatcher's own copy runs, with a stderr notice. An invalid gate name, or a gate found in neither install, exits 1 with a stderr line — a visible hook error, never a silent allow; a fail-closed gate found in neither denies instead (below). [`tests/l1-lint/hooks-via-dispatcher.sh`](../../tests/l1-lint/hooks-via-dispatcher.sh) fails on a registration that calls a gate directly.
3. **One execution per (event, payload, gate).** The dispatcher keys each invocation on the sha256 of event, session, tool name, canonical tool input, tool-use id and gate (SessionStart: session and gate) and takes a `mkdir` lock at `<state>/locks/events/<key>/`. The holder runs the gate and emits its output; a concurrent duplicate waits for the result and replays only a denial, so context and banners appear once. A finished result answers duplicates for a few seconds (`TMB_DISPATCH_WINDOW_S`, default 5); a later identical event runs the gate again.

**Gates fail closed.** Claude Code (2.1.295 and later) treats a command hook that crashes, times out, or exits non-zero without valid JSON as continue unless its registration carries `"onFailure": "block"`, so every deny-capable registration in `hooks/hooks.json` carries that key and observe-only hooks (hints, prescan, nudges, metering, logging) keep the default. The dispatcher reads the same key: for such a gate, a missing script, a non-zero exit other than 2 without a deny, or an error in the dispatcher itself becomes a blocking decision (PreToolUse `permissionDecision: "deny"`, other events `decision: "block"`) with exit 0 and a stderr line naming the cause, so older clients fail closed too; a gate's own deny printed before a non-zero exit is kept. [`tests/l1-lint/hook-onfailure.sh`](../../tests/l1-lint/hook-onfailure.sh) derives the deny-capable set from the scripts (a deny JSON, `exit 2`, a `tmb_deny_*`-style helper from a sourced library, or a deny-capable script it runs) and fails when one lacks the key.

At SessionStart, `mcp-health-check.sh` says once per session when a user-scope install is ignored in favour of the project install, or recommends `--scope project` when only a user-scope install exists.

## Runtime containment: agents write only under their run's root

The invariant above covers what TMB itself writes. The agents it runs are held to the same boundary, in three layers.

**Run root.** Every `agent_runs` row carries `root_dir`: the project root for bro rows (opened by `task_create_batch`, `task_provision`, `task_retry`), the task's worktree (`<repo>/.claude/worktrees/<slug>`) for the swe row `task_brief` opens. Rows also carry `host`, the dominant `model` and, once closed, an `exit_reason` (see [`../contributing/ENUMS.md`](../contributing/ENUMS.md)).

| Tier | Layer | What it holds |
|---|---|---|
| 0 | Claude Code's Bash sandbox, written by `/onboard` (`sandbox_enforcement`, default **no**) | OS-level: Bash, in the main loop and in every subagent, writes only to the working directory, the sandbox temp dir and `sandbox.filesystem.allowWrite` (the project and `TMB_MODEL_CACHE_DIR`). Does not cover the Write/Edit tools. |
| 1 | Server tools (host-neutral) | `task_provision`, `pr_monitor_worktree` and `cheatcode_install` refuse a path outside the project with `{"error":"outside_project"}`; `cheatcode_install` refuses `scope=global` the same way (install project-local instead). `pr_monitor_worktree` checks the commit out under `<repo>/.claude/worktrees/pr-review-<sha>`. |
| 2 | [`scripts/hooks/containment-guard.sh`](../../scripts/hooks/containment-guard.sh) (PreToolUse Write/Edit/MultiEdit/NotebookEdit/Bash) | Denies a write outside the run's root: the open swe/pr-reviewer `root_dir` of the active task, else `CLAUDE_PROJECT_DIR`. File tools by the canonical `file_path`; Bash by its `cwd` and every write position [`lib/cmd-analysis.sh`](../../scripts/hooks/lib/cmd-analysis.sh) finds (redirects, `tee`, `cp`/`mv`/`rsync`/`install` destinations, `mkdir`, `rm`, `touch`, both ends of a link — `ln`, `ln -s`, `link`, `cp -s`, `cp -l` — `git worktree add`, `git clone`, `sed -i`, interpreter one-liners and programs fed to an interpreter through a heredoc) in each statement's own `cd` dir; data heredocs and quoted text are data. Paths are canonicalized the way the kernel resolves them (`realpath -m`): each existing symlink is followed before a later `..` applies, so `<root>/link/../x` with `link` pointing outside is outside; `..` collapses lexically only inside the part that does not exist yet. Writes are allowed under the roots in the table below, plus `/dev/null`-style devices; reads are not judged. Each denial writes a `containment_denied` audit row naming the tool, path, root and task. |

### Allowed write roots

| Root | Why |
|---|---|
| The run's root — the swe's task worktree, else the project | The work itself |
| `TMB_MODEL_CACHE_DIR` (default `HF_HOME`, else `~/.cache/huggingface`) | The shared embedding model cache, the one TMB path outside the project |
| Host-owned: the host's temp dir, `$TMPDIR` when the host sets it, and its realpath | Ephemeral space the Claude Code sandbox itself leaves writable (`/tmp/claude-<uid>`). `/tmp` outside it is denied. TMB's own scripts and server never write there (`no-home-writes.sh`). |
| Host-owned, **main session only**: Claude Code's per-project dir `~/.claude/projects/<slug>/` (the project path with every non-alphanumeric character turned into `-`, e.g. `-Users-Zax-Git-GitHub-TMB`) and its plans dir `~/.claude/plans/` (`$CLAUDE_CONFIG_DIR` replaces `~/.claude` when set) | Claude Code's own state — auto-memory, session files, plan mode — not TMB's artifacts. Allowed when no `agent_type` (or `bro`) is on the payload and the cwd is outside a swe worktree; swe, pr-reviewer and consultants keep the strict rule. Every other path under `~/.claude`, and another project's slug, stays denied. |

The hook is a parser, not a jail. A program fed to python, node, perl, ruby or sh through a heredoc (`python3 - <<'EOF'`) is analysed like a one-liner; a data heredoc (`cat > f <<EOF`) is never read. A variable in a write target resolves from assignments earlier in the same command (`OUT=/x; cat > "$OUT"` is judged as `/x`); `$PWD` is the statement's own dir (the cwd, or the dir a preceding `cd` set), and `$HOME`, `$TMPDIR` and `$TMB_MODEL_CACHE_DIR` are the host's. A `VAR=value` prefix does not reach its own command's words, as in the shell, so `HOME=/inside cat > "$HOME/.bashrc"` is judged on the real `~/.bashrc`; a target behind a variable the command does not set, or built by `$( )`, is allowed only when the literal directory before the variable is inside the root, else denied with the variable named (`swe-boundary.sh` denies it outright for a non-`prompt_bearing` swe). Variables set in an earlier Bash call and programs an interpreter reads from a file are not followed. Tier 0 is the layer that cannot be talked around for Bash; the hook adds the file tools, the swe-worktree boundary (the sandbox allows the whole project) and the audit trail.

### Tier 0 settings block

Only on an explicit **yes** does `onboard_apply` merge into `<project>/.claude/settings.local.json`:

```json
{ "sandbox": { "enabled": true, "filesystem": { "allowWrite": ["<project>", "<TMB_MODEL_CACHE_DIR>"] } } }
```

Every other key, and every `allowWrite` path already present, is kept. What TMB added is recorded in `plugin_config.sandbox_settings`; **no** removes exactly that. Only a project named by the trajectory DB path is written.

**Network caveat — why the default is no.** The block sets no network rules, so with it Claude Code's sandbox network defaults apply to Bash. Phase-0 verified filesystem confinement only; whether those defaults block `gh`, `git push` or package installs (`bun install`) has not been tested. The default becomes **yes** only after a network Phase-0 confirms they keep working.

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
| [`tests/l1-lint/hooks-via-dispatcher.sh`](../../tests/l1-lint/hooks-via-dispatcher.sh) | A hooks.json command that is not `dispatch.sh <gate>`, or a gate script that is missing or not executable |
| [`tests/l1-lint/hook-onfailure.sh`](../../tests/l1-lint/hook-onfailure.sh) | A deny-capable hooks.json registration without `"onFailure": "block"` (warns on an observe-only one that carries it) |
| L3 runners (`tests/l3-integration/hooks/run.sh`, `tests/l3-integration/mcp/run.sh`) | Anything left in the empty temp `HOME` they run under |
| [`tests/l3-integration/hooks/containment-guard.test.sh`](../../tests/l3-integration/hooks/containment-guard.test.sh) | An agent write outside its run's root that the guard allows, a denial without an audit row, or a read / model-cache write that it denies |
| [`tests/l3-integration/hooks/dispatch.test.sh`](../../tests/l3-integration/hooks/dispatch.test.sh) | A duplicate execution, a duplicated banner, a lost denial, the wrong install's gate, a missing gate that exits 0, or a fail-closed gate that dies without a deny |
