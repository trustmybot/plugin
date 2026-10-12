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
| `.claude/tmb/locks/events/` | `scripts/hooks/dispatch.sh` | One gate execution per (event, payload, gate); results pruned after 10 min |
| `.claude/tmb/locks/verify-*` | `swe-verification-gate.sh` | One verification run per (task, worktree HEAD) at a time; the run itself is recorded in the trajectory DB (`verification_runs`) |
| `.claude/settings.local.json` (PreToolUse entries only) | `/onboard`, on **Yes** to headless enforcement | The opt-in headless shim (below) |
| `.claude/tmb/resolve-hook.sh` | `/onboard`, on **Yes** to headless enforcement | The resolver the shim entries call |
| `CLAUDE.md` (the marked persona block only) | `/onboard` | The bro persona (below) |

Nothing is written under `~/.claude` or anywhere else in your home directory. The one path outside the project is the embedding model cache, `TMB_MODEL_CACHE_DIR` (default `HF_HOME`, else `~/.cache/huggingface`) — a shared, re-downloadable cache. `tests/l1-lint/no-home-writes.sh` enforces this; [`../architecture/CONTAINMENT.md`](../architecture/CONTAINMENT.md) is the full rule.

## What `/onboard` writes

- **Always:** policy rows in the trajectory DB (`plugin_config`, `repos`) — branching model, PR target, protected branches, remotes, issue sync, the `onboarded` marker, and the `headless_enforcement` answer.
- **Always: the bro persona block in the project's `CLAUDE.md`.** Claude Code loads the project's own `CLAUDE.md`, never a plugin's, so `onboard_apply` copies the plugin's `CLAUDE.md` (bro's persona and routing table) into `<project>/CLAUDE.md` between two markers:

  ```markdown
  <!-- tmb:persona start v1.0.3 -->
  …the plugin's CLAUDE.md…
  <!-- tmb:persona end -->
  ```

  With no block it is appended after your own text (one blank line between; the file is created when missing). A block from another plugin version, or with another body, is replaced in place. An identical block is left alone, so re-running `/onboard` changes nothing. Text outside the markers is never touched, CRLF files stay CRLF, and the write is atomic and keeps the file's mode. A start marker without an end marker is reported in the result (`persona.reason`) and the file is left as it was. Each change writes one `persona_block_written` audit row. To remove the block, call `onboard_apply` with `persona: false` (or delete the marked lines yourself; the SessionStart prescan then prints `Persona: project CLAUDE.md has no tmb persona block — run /onboard` until the block is back). When the project root is the plugin source checkout, its `CLAUDE.md` is the source and is never rewritten (`persona.action: "skipped_source"`).
- **Headless enforcement — default No.** Marketplace plugin hooks do not fire in non-interactive `claude -p` runs. Answering **Yes** copies TMB's deny-capable PreToolUse gates into the project's `.claude/settings.local.json` (each entry stamped `"_tmb_managed": true` and `"_tmb_project": "<project root>"`) and materializes `.claude/tmb/resolve-hook.sh`, which execs the active install's `dispatch.sh <gate> --shim`. In an interactive session the plugin's own hooks are active, the SessionStart marker exists, and every shim entry exits without running its gate, so each gate runs once. In a headless run there is no marker and the shim enforces. Answering **No** — or re-onboarding from Yes to No — removes exactly the managed entries and the resolver; the rest of `settings.local.json` is left as it was.

## Leftovers from older versions

Older `/onboard` runs wrote TMB gates into `~/.claude/settings.json` (entries stamped `"_tmb_managed": true`) and a resolver under `~/.claude/tmb-hooks/`. Those fire in every project. At SessionStart, `mcp-health-check.sh` names the file and the groups and gives a `jq` filter that removes them; delete `~/.claude/tmb-hooks/` afterwards. TMB does not edit that file itself.
