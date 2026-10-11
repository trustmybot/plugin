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
| `<state>/locks/verify-<task>-<sha>/` | `swe-verification-gate.sh` | One verification run per (task, worktree HEAD); the verdict is kept beside the lock |
| `.claude/settings.local.json` (PreToolUse entries only) | `/onboard`, on Yes to headless enforcement | The opt-in headless shim, each entry stamped `_tmb_managed` + `_tmb_project` |
| `<state>/resolve-hook.sh` | `/onboard`, on Yes to headless enforcement | The resolver the shim entries call |

## One install, one dispatcher, one execution

A hook can be registered more than once for the same event: a project install beside a user-scope one, two channels, the headless shim beside the plugin's own hooks. Three rules keep that from running a gate twice or at two versions.

1. **One install per project.** [`scripts/hooks/lib/resolve-install.sh`](../../scripts/hooks/lib/resolve-install.sh) reads `installed_plugins.json` and picks the install this project uses: a `project`/`local` entry whose `projectPath` is this project wins over a `user` entry; between two project entries the newest `installedAt` wins, with a stderr notice naming both; entries whose `installPath` is gone are skipped. With no entry (a dev checkout, `--plugin-dir`, tests) the invoking plugin root is used, and a root outside any plugins cache is never redirected.
2. **One dispatcher per hook event.** Every `hooks/hooks.json` command is `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh <gate>`, and the headless shim execs `dispatch.sh <gate> --shim`. The dispatcher runs the resolved install's `scripts/hooks/<gate>.sh`, so a stale or user-scope invocation executes the project's version. [`tests/l1-lint/hooks-via-dispatcher.sh`](../../tests/l1-lint/hooks-via-dispatcher.sh) fails on a registration that calls a gate directly.
3. **One execution per (event, payload, gate).** The dispatcher keys each invocation on the sha256 of event, session, tool name, canonical tool input, tool-use id and gate (SessionStart: session and gate) and takes a `mkdir` lock at `<state>/locks/events/<key>/`. The holder runs the gate and emits its output; a concurrent duplicate waits for the result and replays only a denial, so context and banners appear once. A finished result answers duplicates for a few seconds (`TMB_DISPATCH_WINDOW_S`, default 5); a later identical event runs the gate again.

At SessionStart, `mcp-health-check.sh` says once per session when a user-scope install is ignored in favour of the project install, or recommends `--scope project` when only a user-scope install exists.

## Enforcement

| Check | What it fails on |
|---|---|
| [`tests/l1-lint/no-home-writes.sh`](../../tests/l1-lint/no-home-writes.sh) | Any write under the home directory from `scripts/`, `skills/*/scripts/` or the server |
| [`tests/l1-lint/hooks-via-dispatcher.sh`](../../tests/l1-lint/hooks-via-dispatcher.sh) | A hooks.json command that is not `dispatch.sh <gate>`, or a gate script that is missing or not executable |
| L3 runners (`tests/l3-integration/hooks/run.sh`, `tests/l3-integration/mcp/run.sh`) | Anything left in the empty temp `HOME` they run under |
| [`tests/l3-integration/hooks/dispatch.test.sh`](../../tests/l3-integration/hooks/dispatch.test.sh) | A duplicate execution, a duplicated banner, a lost denial, or the wrong install's gate |
