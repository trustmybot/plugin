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

Installing at both scopes is safe; the project install wins, and SessionStart says so once per session. TMB needs Node.js 22+ on PATH: without it, SessionStart prints `TMB DEGRADED: missing node …`. See [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md).

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
| `.claude/tmb/logs/` | MCP server, hooks | `mcp-server.log`, `sql.log`, `issue-sync.log`, `mcp-health.log`, per-session Claude Code logs |
| `.claude/tmb/sessions/<session_id>.plugin-hooks` | SessionStart hook | 0-byte marker: this session runs the plugin's own hooks (pruned after 24 h) |
| `.claude/tmb/sessions/<session_id>.install-notice` | SessionStart hook | 0-byte marker: the install-scope notice was shown this session (pruned after 24 h) |
| `.claude/tmb/sessions/<session_id>.persona` (+ `.persona-notice`) | `session-start-persona`, `user-prompt-persona` | 0-byte marker: bro's persona reached this session (or the notice that it could not); pruned after 24 h |
| `.claude/tmb/locks/events/` (+ `events.sweep`) | the hook router, the headless shim's included | One run per hook call; results pruned after 10 min, a dead holder's lock at its deadline; `events.sweep` holds the last sweep's time, so the sweep runs at most once per `TMB_DISPATCH_SWEEP_S` (default 60 s) |
| `.claude/tmb/locks/verify-*` | `swe-verification-gate` | One verification run per (task, worktree HEAD) at a time; the run itself is recorded in the trajectory DB |
| `.claude/settings.local.json` (PreToolUse entries) | `/onboard`, on **Yes** to the headless-enforcement consent | The opt-in headless shim (below) |
| `.claude/settings.local.json` (`sandbox` block and `env` entries) | `/onboard`, on **Yes** to the Bash sandbox | The opt-in Bash sandbox (below) |
| `.claude/tmb/cache/` (`npm/`, `bun/`) | npm and bun, under the Bash sandbox | Their caches, moved into the project by the sandbox `env` entries |
| `.claude/tmb/resolve-hook.mjs` | `/onboard`, on **Yes** to the headless-enforcement consent | The resolver the shim entries call |
| `.gitignore` (one `.claude/settings.local.json` line) | `/onboard`, when it creates `settings.local.json` in a git work tree that does not ignore it | Keeps the local settings file out of commits (below) |

Nothing is written under `~/.claude` or anywhere else in your home directory. The one path outside the project is the embedding model cache, `TMB_MODEL_CACHE_DIR` (default `HF_HOME`, else `~/.cache/huggingface`) — a shared, re-downloadable cache. `tests/l1-lint/no-home-writes.test.mjs` enforces this; [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md) is the full rule.

## What `/onboard` writes

- **Always:** policy rows in the trajectory DB (`plugin_config`, `repos`) — branching model, PR target, protected branches, remotes, issue sync, the `onboarded` marker, and the `headless_enforcement`, `sandbox_enforcement` and `bug_report_consent` answers. Branching model and PR target are per repo: `/onboard` first scans every repo offline (branches, merge history, CI files, `CONTRIBUTING.md`), shows what it found above each question and pre-selects the option the evidence supports, then asks once when every repo points the same way and repo by repo otherwise.
- **Never your `CLAUDE.md`.** TMB does not write, edit or remove anything in `<project>/CLAUDE.md`; bro's persona arrives through hooks (below).
- **Headless enforcement — on request, not an `/onboard` question.** Marketplace plugin hooks do not fire in non-interactive `claude -p` runs. When you mention `claude -p`, headless or CI runs on an onboarded project, bro asks one consent question naming `.claude/settings.local.json` and the number of entries. Answering **Yes** writes one shim entry per PreToolUse hook of the plugin into the project's `.claude/settings.local.json`, each stamped `"_tmb_managed": true`, plus the resolver `.claude/tmb/resolve-hook.mjs`, which finds the active install and runs its gates. In an interactive session the plugin's own hooks run and the shim steps aside, so each gate runs once; in a headless run the shim enforces. With no resolvable install, or `node` off PATH, the shim lets the call through. Answering **No** writes nothing, and a later No removes exactly the managed entries and the resolver, leaving the rest of `settings.local.json` as it was. [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md) has the details.
- **Bash sandbox — default Yes (Recommended) where the recorded probe passed and no remote uses SSH, else No.** Answering **Yes** writes a `sandbox` block into the project's `.claude/settings.local.json` (Bash writes only in the project and the model cache, network only to the hosts TMB needs and your HTTPS remotes, `allowLocalBinding` so `/dashboard` can listen on loopback; on macOS also `enableWeakerNetworkIsolation`) plus `env` entries `npm_config_cache` and `BUN_INSTALL_CACHE_DIR` under `.claude/tmb/cache/`. Answering **No** removes exactly what TMB added. [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md) has the full block and the platform gate.
- **`.gitignore`, when TMB creates `settings.local.json`.** If the sandbox or the headless shim creates `.claude/settings.local.json` in a git work tree that does not already ignore it, TMB appends `.claude/settings.local.json` to the project's `.gitignore`. A settings file that already existed, a path git already ignores, or a project outside git leaves `.gitignore` alone.

## Where bro's persona comes from

bro's persona and routing table live in the plugin's own `CLAUDE.md`, which Claude Code never loads for a plugin, so two hooks deliver it as session context:

- `session-start-persona` (SessionStart) injects it on startup, resume, `/clear` and compaction, and writes the session's `.persona` marker. After a compaction it also appends bro's state from the DB: the issue, its live tasks and its newest decision, which the PreCompact hook `session-handoff` recorded for that session.
- `user-prompt-persona` (UserPromptSubmit) covers a session that started before the plugin's hooks were loaded: on the first prompt with no marker it injects the persona once. Installed TMB mid-session? Fully quit and relaunch Claude Code; your next prompt brings bro in. If the plugin's `CLAUDE.md` cannot be read, it shows a one-time notice to start a new session instead.

Neither hook runs its injection when the project is the TMB source checkout itself, where Claude Code already loads that `CLAUDE.md`. A `<!-- tmb:persona start … -->` … `<!-- tmb:persona end -->` block an older `/onboard` copied into your `CLAUDE.md` is not needed: the injected context carries a one-line note saying so, and you may delete the marked lines whenever you like.

## Leftovers from older versions

Older `/onboard` runs wrote TMB gates into `~/.claude/settings.json`, where they fire in every project; SessionStart and the health check name each one. [UPGRADE.md](./UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks) walks through removing them by hand; TMB does not edit that file itself.

## Operating systems

| OS | Claude Code workflow | Bash sandbox | `/onboard` sandbox default |
|---|---|---|---|
| macOS | Supported | Supported; the recorded network probe ran here | **Yes (Recommended)**, unless a repo remote uses SSH |
| Linux | Supported (CI runs the suite on Linux) | Not yet validated on a Linux host; the network probe is macOS-only | **No**; answering Yes still writes the block |
| Windows | WSL 2 only, which is the Linux case; native Windows is untested | None on native Windows | As Linux |
