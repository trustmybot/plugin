# Installing TMB

## Recommended scope: project or local

TMB keeps all of its state inside the project it runs in, so install it per project, at one of two scopes:

- **project** — a team install, shared through the project's `.claude/settings.json`.
- **local** — a personal install, kept in `.claude/settings.local.json`. Use this for the dev and rc channels.

**User scope is not recommended.** TMB still writes nothing outside the project, but a user-scope install loads TMB's hooks into every project you open, and SessionStart recommends `--scope project` once per session.

`claude plugin install` defaults to user scope and `claude plugin update` picks one on its own, so always pass `--scope`. Run these from the project root, with `<s>` set to `project` or `local`:

```bash
claude plugin marketplace add trustmybot/marketplace --scope <s>
claude plugin install tmb@trustmybot --scope <s>
claude plugin update tmb@trustmybot --scope <s>
claude plugin marketplace update trustmybot   # no scope flag
```

For another channel, swap in its marketplace: `trustmybot/marketplace-rc` with `tmb@trustmybot-rc`, or `trustmybot/marketplace-dev` with `tmb@trustmybot-dev`.

After any install, update, enable, disable or uninstall, fully quit and relaunch Claude Code: a plugin change applies only on a fresh start. TMB gives these commands only in their CLI form, because the in-session plugin command does not work in Claude Desktop and a full restart is needed either way.

Installing at both scopes is safe. Each project uses exactly one install: its own project (or local) install when there is one, else the user-scope install; with two project installs the newest wins. Every `hooks/hooks.json` command but the Stop `liveness-sentinel`, a report-only idle watcher, is the TypeScript router (`node dist/hooks.js <Event> [part]`), which hands the call to that install and runs its gates once per call however many registrations fire, so a user-scope or stale install never runs a second copy of a gate or an older version of it. SessionStart says once per session when a user-scope install is ignored in favour of the project's. With `node` off PATH no router can start, so the SessionStart and WorktreeCreate commands open with a `command -v node` guard that prints `TMB DEGRADED: missing node …` and exits 2: install Node.js 22 or later on PATH and restart Claude Code. See [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md).

## Recommended effort

Run bro's session at **medium** effort. Three of TMB's skills raise it to high for the turn that loads them: `tmb_planning` for planning, `tmb_spec-authoring` for each spec bro writes, and `tmb_recovery` for failure recovery. The session drops back to medium on the next turn.

- Leave `CLAUDE_CODE_EFFORT_LEVEL` unset: it overrides skill effort, so these skills would run at its level instead.
- `maxEffortLevel`, or a cap your organization sets, still limits the level a skill can raise to.
- TMB never writes an effort setting; you choose the session level. See [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md).

## What TMB writes, and where

Everything lives under the project root (`CLAUDE_PROJECT_DIR`), which the project's `.gitignore` excludes (`.claude/`):

| Path | Written by | What |
|---|---|---|
| `.claude/tmb/trajectory.db` | MCP server | Workflow state and the world model |
| `.claude/tmb/logs/` | MCP server, hooks | `mcp-server.log`, `sql.log`, `issue-sync.log`, `mcp-health.log`, per-session CC logs |
| `.claude/tmb/sessions/<session_id>.plugin-hooks` | SessionStart hook | 0-byte marker: this session runs the plugin's own hooks (pruned after 24 h) |
| `.claude/tmb/sessions/<session_id>.install-notice` | SessionStart hook | 0-byte marker: the install-scope notice was shown this session (pruned after 24 h) |
| `.claude/tmb/sessions/<session_id>.persona` (+ `.persona-notice`) | `session-start-persona`, `user-prompt-persona` | 0-byte marker: bro's persona reached this session (or the notice that it could not); pruned after 24 h |
| `.claude/tmb/locks/events/` (+ `events.sweep`) | the router (`mcp/trajectory-server/src/hooks/router/dedupe.ts`), the headless shim's included | One run per call; results pruned after 10 min, a dead holder's lock at its `deadline` file; `events.sweep` holds the last sweep's time, so the sweep runs at most once per `TMB_DISPATCH_SWEEP_S` (default 60 s) |
| `.claude/tmb/locks/verify-*` | `swe-verification-gate` | One verification run per (task, worktree HEAD) at a time; the run itself is recorded in the trajectory DB (`verification_runs`) |
| `.claude/settings.local.json` (PreToolUse entries) | `onboard_apply`, on **Yes** to the headless-enforcement consent | The opt-in headless shim (below) |
| `.claude/settings.local.json` (`sandbox` block and `env` entries) | `/onboard`, on **Yes** to the Bash sandbox | The opt-in Bash sandbox (below) |
| `.claude/tmb/cache/` (`npm/`, `bun/`) | npm and bun, under the Bash sandbox | Their caches, moved into the project by the sandbox `env` entries |
| `.claude/tmb/resolve-hook.mjs` | `onboard_apply`, on **Yes** to the headless-enforcement consent | The resolver the shim entries call |
| `.gitignore` (one `.claude/settings.local.json` line) | `onboard_apply`, when it creates `settings.local.json` in a git work tree that does not ignore it | Keeps the local settings file out of commits (below) |

Nothing is written under `~/.claude` or anywhere else in your home directory. The one path outside the project is the embedding model cache, `TMB_MODEL_CACHE_DIR` (default `HF_HOME`, else `~/.cache/huggingface`) — a shared, re-downloadable cache. `tests/l1-lint/no-home-writes.test.mjs` enforces this; [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md) is the full rule.

## What `/onboard` writes

- **Always:** policy rows in the trajectory DB (`plugin_config`, `repos`) — branching model, PR target, protected branches, remotes, issue sync, the `onboarded` marker, and the `headless_enforcement`, `sandbox_enforcement` and `bug_report_consent` answers. Branching model and PR target are per repo: `/onboard` first scans every repo offline (branches, merge history, CI files, `CONTRIBUTING.md`), shows what it found above each question and pre-selects the option the evidence supports, then asks once when every repo points the same way and repo by repo otherwise.
- **Never your `CLAUDE.md`.** TMB does not write, edit or remove anything in `<project>/CLAUDE.md`; bro's persona arrives through hooks (below).
- **Headless enforcement — on request, not an `/onboard` question.** Marketplace plugin hooks do not fire in non-interactive `claude -p` runs. When you mention `claude -p`, headless or CI runs on an onboarded project, the `headless-intent` hint has bro ask one consent question naming `.claude/settings.local.json` and the number of entries; bro then calls `onboard_apply(headless_enforcement='yes')`. Answering **Yes** writes one entry per PreToolUse router entry of the plugin's `hooks/hooks.json` into the project's `.claude/settings.local.json`, with the same matcher, `timeout` and `onFailure`, each stamped `"_tmb_managed": true` and `"_tmb_project": "<project root>"`:

  ```
  node <project>/.claude/tmb/resolve-hook.mjs --marketplace <mp> --hook PreToolUse --shim --project <project root>
  ```

  It also copies the plugin's `mcp/trajectory-server/dist/resolve-hook.mjs` to `.claude/tmb/resolve-hook.mjs`, which finds the active install and runs its router, `node <install>/mcp/trajectory-server/dist/hooks.js PreToolUse --shim` (a router entry with a part adds `--part <part>`), so the group's gates run as they do from the plugin. With no resolvable install, or an install without `dist/hooks.js`, the resolver prints a `failing OPEN` warning and allows the call. With `node` off PATH the entry cannot start, which Claude Code treats as a non-blocking error, so the call goes ahead. Entries an earlier `/onboard` wrote to run `.claude/tmb/resolve-hook.sh` are rewritten to `resolve-hook.mjs` by the next `/onboard`, which also deletes the `.sh` copy. In an interactive session the plugin's own hooks are active, the SessionStart marker exists, and every shim entry exits without running a gate, so each gate runs once. In a headless run there is no marker and the shim enforces. Answering **No** writes nothing; `onboard_apply(headless_enforcement='no')` removes exactly the managed entries and the resolver (`resolve-hook.mjs`, and a leftover `resolve-hook.sh`); the rest of `settings.local.json` is left as it was.
- **Bash sandbox — default Yes (Recommended) where the recorded probe passed and no remote uses SSH, else No.** Answering **Yes** writes a `sandbox` block into the project's `.claude/settings.local.json` (Bash writes only in the project and the model cache, network only to the hosts TMB needs and your HTTPS remotes, `allowLocalBinding` so `/dashboard` can listen on loopback; on macOS also `enableWeakerNetworkIsolation`) plus `env` entries `npm_config_cache` and `BUN_INSTALL_CACHE_DIR` under `.claude/tmb/cache/`. Answering **No** removes exactly what TMB added. [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md) has the full block and the platform gate.
- **`.gitignore`, when TMB creates `settings.local.json`.** If the sandbox or the headless shim creates `.claude/settings.local.json` in a git work tree that does not already ignore it, TMB appends `.claude/settings.local.json` to the project's `.gitignore`. A settings file that already existed, a path git already ignores, or a project outside git leaves `.gitignore` alone.

## Where bro's persona comes from

bro's persona and routing table live in the plugin's own `CLAUDE.md`, which Claude Code never loads for a plugin, so two hooks deliver it as session context:

- `session-start-persona` (SessionStart) injects it on startup, resume, `/clear` and compaction, and writes the session's `.persona` marker. After a compaction it also appends bro's state from the DB: the issue, its live tasks and its newest decision, which the PreCompact hook `session-handoff` recorded for that session.
- `user-prompt-persona` (UserPromptSubmit) covers a session that started before the plugin's hooks were loaded: on the first prompt with no marker it injects the persona once. Installed TMB mid-session? Fully quit and relaunch Claude Code; your next prompt brings bro in. If the plugin's `CLAUDE.md` cannot be read, it shows a one-time notice to start a new session instead.

Neither hook runs its injection when the project is the TMB source checkout itself, where Claude Code already loads that `CLAUDE.md`. A `<!-- tmb:persona start … -->` … `<!-- tmb:persona end -->` block an older `/onboard` copied into your `CLAUDE.md` is not needed: the injected context carries a one-line note saying so, and you may delete the marked lines whenever you like.

## Leftovers from older versions

Older `/onboard` runs wrote TMB gates into `~/.claude/settings.json` (entries stamped `"_tmb_managed": true`, or running `resolve-hook.sh`) and a resolver under `~/.claude/tmb-hooks/`. Those fire in every project. One warning names each such hook object once, by line and `--hook` name: a `Plugin:` line in the SessionStart inventory, and `WARN  legacy-user-hooks` from the health check (`node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" health`). [UPGRADE.md](./UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks) walks through removing them by hand. TMB does not edit that file itself.

## Operating systems

| OS | Claude Code workflow | Bash sandbox |
|---|---|---|
| macOS | Supported | Supported; `/onboard` defaults to Yes |
| Linux | Supported (CI runs the suite on Linux) | Not yet validated; `/onboard` defaults to No |
| Windows | WSL 2 only (native Windows is untested) | As Linux, under WSL 2; none on native Windows |

Details: [Sandbox support](#sandbox-support).

## Sandbox support

| OS | Bash sandbox | `/onboard` default |
|---|---|---|
| macOS | Supported. The recorded network probe ran here (GH 1549). | **Yes (Recommended)**, unless a repo remote uses SSH |
| Linux | Untested. TMB's scripts are portable (temp files use an explicit `mktemp "<dir>/…XXXXXX"` template under `$TMPDIR` that GNU and BSD `mktemp` both honour, GH 1573), but the sandbox block has not been validated on a Linux host and the network probe is darwin-only (`SANDBOX_NETWORK_PROBE` in `onboard-sandbox.ts`). | **No**; answering Yes still writes the block |
| Windows | Through WSL 2 only, which is the Linux case. Claude Code has no sandbox on native Windows, and TMB is untested there. | As Linux |
