# Local Testing — Setup Guide

How to stand up a scratch project and exercise the TMB plugin end-to-end. This is the canonical manual-testing path for contributors and dogfooders. For automated test suites, see [`tests/README.md`](../tests/README.md).

## Prerequisites

- **Claude Code** — `claude --version` should work. [Install instructions](https://claude.com/claude-code).
- **Node 20+** — the bundled MCP server runs on Node.
- **bun** — used to build the MCP server. `curl -fsSL https://bun.sh/install | bash`.
- **sqlite3** — for inspecting the trajectory DB. Usually preinstalled; `brew install sqlite3` if not.

Verify the MCP server builds cleanly before doing anything else:

```bash
cd plugin/mcp/trajectory-server
bun install
bun run build
```

If that fails, fix it first — the plugin won't load a broken MCP server.

---

## Two install modes

Pick one. Mode A is tighter for iteration; Mode B matches the release path end users experience.

### Mode A — dev mode with hot reload (recommended for contributor iteration)

Launch Claude Code against the plugin source directly:

```bash
mkdir -p /tmp/tmb-scratch  # or anywhere disposable
cd /tmp/tmb-scratch
git init && git commit --allow-empty -m "init"

claude --plugin-dir $PLUGIN_PATH
```

Edits to agent prompts, skills, or hook scripts are picked up after `/reload-plugins` inside the session. TypeScript edits under `mcp/trajectory-server/src/` require a rebuild (`bun run build`) then `/reload-plugins`.

No install, no cache, no marketplace.

### Mode B — marketplace install (matches end-user flow)

```bash
mkdir -p /tmp/tmb-smoke && cd /tmp/tmb-smoke
git init && git commit --allow-empty -m "init"

claude                                   # launch CC
```

Inside the session:

```
/plugin marketplace add $PLUGIN_PATH
/plugin install tmb@trustmybot
```

This is what downstream users do with `trustmybot/plugin` as the marketplace path. Useful for verifying the install UX, not for rapid iteration.

---

## First-run expectations

On the first prompt in a fresh project, the `gatekeeper` should:

1. Introduce itself in one short paragraph.
2. Seed the project's domain-role templates at `./.claude/agents/ceo.md` + `cto.md`.
3. Ask 2–3 onboarding questions:
   - Branching model (trunk / gitflow / feature-branch)
   - PR target + protected branches
   - Identity for commits and agent comments

After the answers are captured, verify they persisted to SQLite:

```bash
sqlite3 ~/.config/claude-code/plugin-data/tmb/trajectory.db <<'SQL'
  SELECT key, value_json FROM plugin_config;
  SELECT * FROM identity;
SQL
```

Expected rows: `branching_model`, `pr_target`, `protected_branches`, and an `identity` row with `gatekeeper_name` + `human_name`.

If nothing is written, the MCP server didn't connect — check `claude --plugin-dir` output for MCP errors.

---

## Hot reload within a session

```
/reload-plugins
```

Picks up edits to:
- Agent prompts (`plugin/agents/*.md`)
- Skills (`plugin/skills/**/SKILL.md`)
- Hook scripts (`plugin/scripts/hooks/*.sh`)
- Template content (`plugin/templates/**/*`)

Does **not** pick up TypeScript edits in the MCP server. Rebuild first:

```bash
cd plugin/mcp/trajectory-server && bun run build
```

Then `/reload-plugins`.

---

## Reset between tests

```bash
# Inside Claude Code (if installed via marketplace):
/plugin marketplace remove trustmybot

# Outside CC — always reset the DB:
rm ~/.config/claude-code/plugin-data/tmb/trajectory.db
```

The DB persists across sessions and across plugin updates. Stale onboarding state is the #1 source of "why isn't first-run triggering" confusion — delete the DB whenever you want a truly fresh run.

---

## End-to-end dogfood checklist

Manual scenarios to walk before shipping a change. Tick each after running.

| # | Scenario | Expected |
|---|---|---|
| 1 | Fresh install in empty project | Gatekeeper introduces itself; onboarding triggers |
| 2 | Read-only question (`list files in src/`) | Gatekeeper answers inline; no agent spawn |
| 3 | Simple code change | Gatekeeper triages `simple` → architect double-checks → task row created via `task_create_batch(spec_body=...)` → SWE in worktree reads via `task_get` |
| 4 | Architecture-affecting change | Gatekeeper triages `difficult` → architect updates `architecture/manual/` ADR → task row (standard template) |
| 5 | `/tmb reonboard` phrase | Skill re-prompts branching + identity |
| 6 | Identity rename (`call yourself alex`) | `identity_set` persists; subsequent responses use new name |
| 7 | Architecture regen (`refresh architecture docs`) | 4 files regenerated at `docs/trustmybot/architecture/auto/` with generated-header |
| 8 | Commit on protected branch | `git-guards.sh` blocks |
| 9 | Push to `feature/*` branch | Always allowed (issue #13) |
| 10 | Push to dev/main with unsigned completed tasks | `require-review-sign.sh` blocks until pr-reviewer records `validation_record(verdict='pass')` |

Any failure here is a bug a downstream user will hit identically — file an issue.

---

## Common pitfalls

- **"MCP server not connected"** — almost always a build failure. Run `cd plugin/mcp/trajectory-server && bun run build` and check for errors.
- **"Onboarding didn't fire"** — stale DB. Delete `~/.config/claude-code/plugin-data/tmb/trajectory.db` and relaunch.
- **"Agent changes didn't take effect"** — forgot `/reload-plugins`, or CC cached a previous install (Mode B). Try Mode A for cleaner iteration.
- **"Hook didn't block"** — hook path mismatch. Check `plugin/hooks/hooks.json` points at the script you edited and that the script is executable (`chmod +x`).
- **"git-guards blocked my legitimate commit"** — check `plugin_config.protected_branches` — you're on a configured protected branch. Override intentionally or switch to a feature branch.

---

## Related

- [`tests/README.md`](../tests/README.md) — automated MCP + hook test suites (`bash tests/run-all.sh`)
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — branch workflow, pre-PR checklist, design principles
- [`mcp/trajectory-server/docs/CONFIG_KEYS.md`](../mcp/trajectory-server/docs/CONFIG_KEYS.md) — every `plugin_config` key the plugin reads or writes
