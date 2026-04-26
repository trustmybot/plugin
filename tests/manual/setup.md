# Manual test setup — two paths

How to stand up a TMB scratch project and verify it works end-to-end. Two distinct paths depending on what you're validating.

> **TL;DR:**
> - **Local dev** (Path A): `claude --plugin-dir <plugin>` — fast iteration, hot-reload, DOES NOT exercise the marketplace install lifecycle.
> - **Marketplace RC** (Path B): `/plugin install tmb-rc@trustmybot` — slow but tests the actual install path that broke v0.2.0 + v0.3.0. **Required before promoting an RC to stable.**

---

## Prerequisites

| Tool | How to check | If missing |
|---|---|---|
| Claude Code | `claude --version` | https://claude.com/claude-code |
| Node 22+ | `node --version` | https://nodejs.org or `nvm install 22` |
| bun | `bun --version` | `curl -fsSL https://bun.sh/install \| bash` |
| sqlite3 CLI | `sqlite3 --version` | `brew install sqlite` (macOS) / `apt install sqlite3` (Linux) |
| Docker (optional, only for L0 install-smoke) | `docker --version` | https://docs.docker.com/desktop |

---

## Path A — Local dev (fast iteration during development)

**Use this when:** you're developing a feature, fixing a bug, debugging a skill, anything where you want changes to land quickly.

**Do NOT use for RC validation** — `--plugin-dir` bypasses CC's marketplace install lifecycle and silently sidesteps the bug class that broke v0.2.0 + v0.3.0.

> ⚠️ **Don't try to "add a local marketplace" with `/plugin marketplace add --local <path>` or `/plugin marketplace add /absolute/path/to/plugin`.**
> CC has no `--local` flag for marketplace add; both forms get silently mangled into a stale marketplace named something like `"--local -Users"` that pollutes `~/.claude/plugins/marketplaces/` and confuses CC's UI for future installs.
> The ONLY two correct local-dev paths are:
> - **Path A (this section):** `claude --plugin-dir <path>` — direct local-tree load, no marketplace involved.
> - **Path B (next section):** the GitHub-source marketplace, `/plugin marketplace add trustmybot/plugin`. For testing your own fork, push to a GitHub branch and add `your-org/your-fork`.

### Setup (one-time per checkout)

```bash
cd ~/Git/GitHub/TMB/plugin   # adjust to your clone path
bun install                  # installs every workspace + builds dist/
```

If `bun install` doesn't build `dist/`, run `bun --filter='*' run build` explicitly. Verify:

```bash
ls mcp/trajectory-server/dist/index.js   # must exist
```

### Run

```bash
# Capture plugin path for later commands
export PLUGIN_PATH="$(pwd)"

# Fresh scratch project
mkdir -p /tmp/tmb-dev-test && cd /tmp/tmb-dev-test
git init -q && git config user.email t@t.t && git config user.name T
echo init > README.md && git add . && git commit -qm init

# Launch CC against the local plugin tree
claude --plugin-dir "$PLUGIN_PATH"
```

Inside CC, type `@bro hello` (or anything addressing bro). Onboarding should fire.

### Verify (after onboarding)

```bash
# In another terminal, from the scratch dir:
sqlite3 .claude/tmb/trajectory.db <<'SQL'   # for tmb-rc installs use .claude/tmb-rc/trajectory.db
.headers on
SELECT human_name, created_at FROM identity;
SELECT key, value_json FROM plugin_config ORDER BY key;
SELECT id, event_type, summary FROM ledger ORDER BY id DESC LIMIT 3;
SQL
```

Expected: 1 identity row (set via `tmb_reonboard`), 3 config rows from the schema seed (`branching_model`, `pr_target`, `protected_branches`), and an empty ledger if no decisions have fired yet.

### Hot reload (apply edits without restart)

```
/reload-plugins
```

Picks up edits to:
- `agents/*.md` (the global swe + pr-reviewer)
- `templates/agents/*.md` (consultant templates)
- `skills/**/SKILL.md` (protocol + default skills)
- `scripts/hooks/*.sh` (hook scripts)
- `.mcp.json`, `hooks/hooks.json`

Does **not** pick up TypeScript edits in `mcp/trajectory-server/src/`. Rebuild first:

```bash
cd "$PLUGIN_PATH" && bun run build
```

Then `/reload-plugins`. The `dist-fresh` lint will fail if you commit a src/ change without rebuilding dist/, so always rebuild before commit anyway.

### Reset between test runs

**DB-only (keeps scratch project, fastest):**
```bash
cd /tmp/tmb-dev-test
rm -rf .claude/tmb .claude/tmb-rc   # cover both channels; next @bro will re-trigger onboarding
```

**Full wipe (true cold-start, includes scratch git history):**
```bash
rm -rf /tmp/tmb-dev-test
mkdir -p /tmp/tmb-dev-test && cd /tmp/tmb-dev-test
git init -q && git config user.email t@t.t && git config user.name T
echo init > README.md && git add . && git commit -qm init
claude --plugin-dir "$PLUGIN_PATH"
```

---

## Path B — Marketplace RC (REQUIRED for RC validation before promoting to stable)

**Use this when:** validating a release candidate (`vX.Y.Z-rc.N` tag pushed, `rc` branch fast-forwarded). This is what real users experience — exercises CC's full install lifecycle including the `bun install --ignore-scripts` step that broke v0.2.0 + v0.3.0.

### Setup (one-time per CC profile)

If you don't already have the marketplace registered:

In CC:
```
/plugin marketplace add trustmybot/plugin
```

CC clones the marketplace from GitHub and reads `.claude-plugin/marketplace.json` from the default branch (main).

### Install the RC channel

In CC:
```
/plugin install tmb-rc@trustmybot
```

CC fetches whatever commit the `rc` branch points at (per `marketplace.json`'s `tmb-rc` entry), installs into `~/.claude/plugins/cache/trustmybot/tmb/<version>/`. **CC does NOT run postinstall** — this is precisely why we ship `dist/` committed to the repo.

### Verify the install actually delivered working code

**This is the load-bearing check.** v0.2.0 + v0.3.0 both passed this step's expected file but FAILED a deeper invariant. Check both:

```bash
# 1. Pre-built artifacts present
INSTALLED=$(ls -td ~/.claude/plugins/cache/trustmybot/tmb/*/ | head -1)
ls "$INSTALLED/mcp/trajectory-server/dist/index.js"  # must exist
ls "$INSTALLED/mcp/trajectory-server/dist/schema.sql" # must exist

# 2. Server actually spawns + handles a real DB call
( echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"identity_get","arguments":{"agent":"bro"}}}'
  sleep 1
) | TRAJECTORY_DB_PATH=/tmp/rc-smoke.db \
  node --experimental-sqlite "$INSTALLED/mcp/trajectory-server/dist/index.js" 2>&1 \
  | grep -q human_name && echo "✓ MCP responds" || echo "✗ MCP broken — abort RC validation, file v<X.Y.Z>-rc.N+1"
rm -f /tmp/rc-smoke.db
```

If either fails, the published artifact is broken — don't run the scenarios; cut a fix RC.

### Run the scenario walkthrough

In CC, set up a **fresh scratch project** and walk every item in [`scenarios.md`](./scenarios.md):

```bash
# In a new terminal:
mkdir -p /tmp/tmb-rc-test && cd /tmp/tmb-rc-test
git init -q && git config user.email t@t.t && git config user.name T
echo init > README.md && git add . && git commit -qm init
claude   # bare CC, no --plugin-dir; uses the marketplace install
```

Then `@bro hello` and walk the 10-item checklist in [`scenarios.md`](./scenarios.md). After completing all 10:

```bash
export MANUAL_DOGFOOD_PASSED=v<X.Y.Z>   # the FINAL tag, not the rc.N tag
```

This sets the gate that `scripts/release.sh` checks before tagging the stable release.

### Reset between test runs

**Re-pull the latest RC (CC may cache the install):**
```
/plugin update tmb-rc@trustmybot
```

**Fresh scratch + restart CC** between RCs:
```bash
rm -rf /tmp/tmb-rc-test
# (set up scratch + relaunch claude as above)
```

**Force re-install (rare — only if cache feels corrupted):**
```bash
rm -rf ~/.claude/plugins/cache/trustmybot/tmb/<broken-version>
# then in CC: /plugin install tmb-rc@trustmybot
```

---

## Path C — Docker install-smoke (CI's L0 — also runnable locally)

This is the automated test that simulates Path B without Claude Code in the loop. Useful for catching install-path bugs at PR time.

```bash
cd "$PLUGIN_PATH"
bash tests/docker/run-install-smoke.sh
```

Builds a fresh `node:22-slim` Docker image, copies the plugin tree as if from a marketplace fetch, runs `bun install --frozen-lockfile --ignore-scripts` (CC's actual install behavior), then asserts:

- `dist/index.js` + `dist/schema.sql` present
- MCP server spawns
- `tools/list` returns `identity_get`
- A real `tools/call identity_get` round-trips with a `human_name` field
- All hooks executable + syntactically valid
- `.mcp.json`'s referenced paths exist

**This test would have caught both v0.2.0 and v0.3.0** — both bugs were pre-existing before either release shipped, but the test wasn't running with `--ignore-scripts`. v0.3.1 fixed the test to match CC's actual behavior. **Run this locally before any release-related PR.**

---

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Bro responds but says "MCP tools not available" | dist/ missing in install | Path A: `bun run build`. Path B: file `vX.Y.Z-rc.N+1` to fix the artifact. |
| Bro doesn't trigger on `@bro hello` | Plugin not loaded | Check `claude --plugin-dir <path>` resolved correctly OR `/plugin install tmb@trustmybot` succeeded |
| Onboarding asks but doesn't persist | MCP server can't open DB | Check `TRAJECTORY_DB_PATH` env, write permissions on `<scratch>/.claude/<plugin-name>/` (`tmb` for stable, `tmb-rc` for the RC channel) |
| `/reload-plugins` doesn't pick up TS edit | TS source needs build | `bun run build` from plugin repo root, then `/reload-plugins` |
| `git-guards.sh` blocks legitimate commit | On a configured protected branch | Switch to feature branch OR `config_set` `protected_branches` |
| Multiple installed versions in cache | CC keeps old caches per version | Safe to leave OR `rm -rf ~/.claude/plugins/cache/trustmybot/tmb/<old-version>` |

---

## Related

- [`scenarios.md`](./scenarios.md) — the 10-item L5 checklist (what to test during Path B RC validation)
- [`../README.md`](../README.md) — automated test suites (L0–L4 + L6) and `bash tests/run-all.sh`
- [`../../CONTRIBUTING.md` § Release ritual](../../CONTRIBUTING.md#release-ritual) — Path 1 hotfix vs Path 2 RC, with explicit promotion sequence
- [`../../docs/architecture/FLOWS.md`](../../docs/architecture/FLOWS.md) — workflow flowcharts the scenarios exercise
