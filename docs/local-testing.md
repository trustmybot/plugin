# Local Testing — Setup Guide

How to stand up a scratch project and exercise the TMB plugin end-to-end. This is the canonical manual-testing path for contributors and dogfooders. For automated test suites, see [`tests/README.md`](../tests/README.md).

## Prerequisites

- **Claude Code** — `claude --version` should work. [Install instructions](https://claude.com/claude-code).
- **Node 20+** — the bundled MCP server runs on Node.
- **bun** — used to build the MCP server. `curl -fsSL https://bun.sh/install | bash`.
- **sqlite3** — for inspecting the trajectory DB. Usually preinstalled; `brew install sqlite3` if not.

Verify the MCP server builds cleanly before doing anything else. **Run from the plugin repo root** (i.e. `cd` into your clone first):

```bash
bun install         # installs every workspace (mcp/trajectory-server + monitors)
bun run build       # builds every workspace that has a build script
```

If that fails, fix it first — the plugin won't load a broken MCP server.

---

## Two install modes

Pick one. Mode A is tighter for iteration; Mode B matches the release path end users experience.

### Mode A — dev mode with hot reload (recommended for contributor iteration)

Launch Claude Code against the plugin source directly. **Run these from the plugin repo root** (same directory you ran `bun install` in) so `$(pwd)` resolves correctly:

```bash
# Capture the plugin repo path from the current directory — no placeholder to edit.
export PLUGIN_PATH="$(pwd)"
echo "$PLUGIN_PATH"   # sanity-check: should point at your plugin clone

# Use any disposable directory for the scratch project.
mkdir -p /tmp/tmb-scratch && cd /tmp/tmb-scratch
git init && git commit --allow-empty -m "init"

claude --plugin-dir "$PLUGIN_PATH"
```

If you prefer to set `PLUGIN_PATH` from somewhere else, substitute your clone path — e.g. `export PLUGIN_PATH=~/code/trustmybot-plugin`. The literal string `/absolute/path/to/...` is not a real path.

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

After the answers are captured, verify they persisted to SQLite. The DB is project-local at `<your-project>/.claude/tmb/trajectory.db`:

```bash
sqlite3 .claude/tmb/trajectory.db <<'SQL'
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

Does **not** pick up TypeScript edits in the MCP server. Rebuild first, from the plugin repo root:

```bash
bun run build
```

Then `/reload-plugins`.

---

## Reset between tests

```bash
# Inside Claude Code (if installed via marketplace):
/plugin marketplace remove trustmybot

# Outside CC — reset the project-local DB. Run from inside the SCRATCH
# project (e.g. /tmp/tmb-scratch), NOT from the plugin repo:
cd /tmp/tmb-scratch          # your scratch project — NOT your plugin clone
rm -rf .claude/tmb/
```

The DB persists across sessions but is scoped to the project directory you launch CC from. Switch projects → different DB. Delete `.claude/tmb/` whenever you want a truly fresh run. Stale onboarding state is the #1 source of "why isn't first-run triggering" confusion.

**If you accidentally run `rm -rf .claude/tmb/` in the plugin repo itself**: harmless. `.claude/` is gitignored; the only thing that could be there is a stray DB from a headless smoke test, and it's not shared with any real project.

---

## End-to-end dogfood checklist

The full set of manual scenarios — verbatim trigger prompts, prerequisites, expected behavior, verification queries — lives in [**`docs/architecture/SCENARIOS.md`**](architecture/SCENARIOS.md). 30+ scenarios across all 9 workflows from `FLOWS.md`, including all four corner cases of the roundtable flow.

Quick smoke checklist (covers the 80% — see SCENARIOS.md for the full grid):

| # | Trigger | Expected |
|---|---|---|
| 1 | Fresh install + any first prompt | Gatekeeper greets and runs onboarding |
| 2 | Read-only question (`list files in src/`) | Gatekeeper answers inline; no agent spawn |
| 3 | `fix the typo in README` | Simple-task chain: triage:simple → architect → swe → pr-reviewer |
| 4 | `add OAuth login` (or any architecture-touching ask) | Difficult chain: triage:difficult + ADR file + standard template |
| 5 | `change branching model to gitflow` | `tmb-reonboard` skill re-runs onboarding with current values as defaults |
| 6 | `call yourself alex` | `identity_set` persists; gatekeeper signs off as alex |
| 7 | `refresh architecture docs` | 4 files regenerated under `docs/trustmybot/architecture/auto/` |
| 8 | Commit on protected branch | `git-guards.sh` blocks |
| 9 | Push to `feature/*` branch | Always allowed |
| 10 | Push to dev/main with unsigned completed tasks | `require-review-sign.sh` blocks until pr-reviewer signed |

Any failure here is a bug a downstream user will hit identically — file an issue tagged `dogfood` and reference the scenario ID from SCENARIOS.md.

---

## Common pitfalls

- **"MCP server not connected"** — almost always a build failure. From the plugin repo root: `bun run build` and check for errors.
- **"Onboarding didn't fire"** — stale DB. Delete `.claude/tmb/` in your project root and relaunch.
- **"Agent changes didn't take effect"** — forgot `/reload-plugins`, or CC cached a previous install (Mode B). Try Mode A for cleaner iteration.
- **"Hook didn't block"** — hook path mismatch. Check `plugin/hooks/hooks.json` points at the script you edited and that the script is executable (`chmod +x`).
- **"git-guards blocked my legitimate commit"** — check `plugin_config.protected_branches` — you're on a configured protected branch. Override intentionally or switch to a feature branch.

---

## Related

- [`tests/README.md`](../tests/README.md) — automated MCP + hook test suites (`bash tests/run-all.sh`)
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — branch workflow, pre-PR checklist, design principles
- [`mcp/trajectory-server/docs/CONFIG_KEYS.md`](../mcp/trajectory-server/docs/CONFIG_KEYS.md) — every `plugin_config` key the plugin reads or writes
