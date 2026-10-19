# Installing TMB

## Recommended scope: project

TMB keeps all of its state inside the project it runs in, so install it per project:

```bash
claude plugin install tmb@trustmybot --scope project
```

Inside Claude Code, `/plugin install tmb@trustmybot` asks for the scope; pick **project**. A user-scope install also works — TMB still writes nothing outside the project — but it loads TMB's hooks into every project you open, and SessionStart recommends `--scope project` once per session.

Installing at both scopes is safe. Each project uses exactly one install: its own project (or local) install when there is one, else the user-scope install; with two project installs the newest wins. Every hook registration runs through `scripts/hooks/dispatch.sh`, which executes that install's gate once per event however many registrations fire, so a user-scope or stale install never runs a second copy of a gate or an older version of it. SessionStart says once per session when a user-scope install is ignored in favour of the project's. See [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md).

## What TMB writes, and where

Everything lives under the project root (`CLAUDE_PROJECT_DIR`), which the project's `.gitignore` excludes (`.claude/`):

| Path | Written by | What |
|---|---|---|
| `.claude/tmb/trajectory.db` (+ `world-model.kuzu`) | MCP server | Workflow state and the world model |
| `.claude/tmb/logs/` | MCP server, hooks | `mcp-server.log`, `sql.log`, `issue-sync.log`, `mcp-health.log`, per-session CC logs |
| `.claude/tmb/sessions/<session_id>.plugin-hooks` | SessionStart hook | 0-byte marker: this session runs the plugin's own hooks (pruned after 24 h) |
| `.claude/tmb/sessions/<session_id>.install-notice` | SessionStart hook | 0-byte marker: the install-scope notice was shown this session (pruned after 24 h) |
| `.claude/tmb/sessions/<session_id>.persona` (+ `.persona-notice`) | `session-start-persona.sh`, `user-prompt-persona.sh` | 0-byte marker: bro's persona reached this session (or the notice that it could not); pruned after 24 h |
| `.claude/tmb/locks/events/` | `scripts/hooks/dispatch.sh` | One gate execution per (event, payload, gate); results pruned after 10 min |
| `.claude/tmb/locks/verify-*` | `swe-verification-gate.sh` | One verification run per (task, worktree HEAD) at a time; the run itself is recorded in the trajectory DB (`verification_runs`) |
| `.claude/settings.local.json` (PreToolUse entries only) | `/onboard`, on **Yes** to headless enforcement | The opt-in headless shim (below) |
| `.claude/tmb/resolve-hook.sh` | `/onboard`, on **Yes** to headless enforcement | The resolver the shim entries call |

Nothing is written under `~/.claude` or anywhere else in your home directory. The one path outside the project is the embedding model cache, `TMB_MODEL_CACHE_DIR` (default `HF_HOME`, else `~/.cache/huggingface`) — a shared, re-downloadable cache. `tests/l1-lint/no-home-writes.sh` enforces this; [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md) is the full rule.

## What `/onboard` writes

- **Always:** policy rows in the trajectory DB (`plugin_config`, `repos`) — branching model, PR target, protected branches, remotes, issue sync, the `onboarded` marker, and the `headless_enforcement` answer.
- **Never your `CLAUDE.md`.** TMB does not write, edit or remove anything in `<project>/CLAUDE.md`; bro's persona arrives through hooks (below).
- **Headless enforcement — default No.** Marketplace plugin hooks do not fire in non-interactive `claude -p` runs. Answering **Yes** copies TMB's deny-capable PreToolUse gates into the project's `.claude/settings.local.json` (each entry stamped `"_tmb_managed": true` and `"_tmb_project": "<project root>"`) and materializes `.claude/tmb/resolve-hook.sh`, which execs the active install's `dispatch.sh <gate> --shim`. In an interactive session the plugin's own hooks are active, the SessionStart marker exists, and every shim entry exits without running its gate, so each gate runs once. In a headless run there is no marker and the shim enforces. Answering **No** — or re-onboarding from Yes to No — removes exactly the managed entries and the resolver; the rest of `settings.local.json` is left as it was.

## Where bro's persona comes from

bro's persona and routing table live in the plugin's own `CLAUDE.md`, which Claude Code never loads for a plugin, so two hooks deliver it as session context:

- `session-start-persona.sh` (SessionStart) injects it on startup, resume, `/clear` and compaction, and writes the session's `.persona` marker.
- `user-prompt-persona.sh` (UserPromptSubmit) covers a session that started before the plugin's hooks were loaded: on the first prompt with no marker it injects the persona once. Installed TMB mid-session? Run `/reload-plugins` (or start a new session); your next prompt brings bro in. If the plugin's `CLAUDE.md` cannot be read, it shows a one-time notice to start a new session instead.

Neither hook runs its injection when the project is the TMB source checkout itself, where Claude Code already loads that `CLAUDE.md`. A `<!-- tmb:persona start … -->` … `<!-- tmb:persona end -->` block an older `/onboard` copied into your `CLAUDE.md` is not needed: the injected context carries a one-line note saying so, and you may delete the marked lines whenever you like.

## Leftovers from older versions

Older `/onboard` runs wrote TMB gates into `~/.claude/settings.json` (entries stamped `"_tmb_managed": true`) and a resolver under `~/.claude/tmb-hooks/`. Those fire in every project. At SessionStart, `mcp-health-check.sh` names the file and the groups and gives a `jq` filter that removes them; delete `~/.claude/tmb-hooks/` afterwards. Every hook command there that runs `resolve-hook.sh`, stamped or not, is also named by line in the SessionStart inventory and by `scripts/health.sh`; [UPGRADE.md](./UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks) walks through removing them. TMB does not edit that file itself.
