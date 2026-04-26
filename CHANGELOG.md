# Changelog

All notable user-visible changes to the TMB plugin. Versions follow [SemVer](https://semver.org/) (pre-1.0: breaking changes may happen on minor bumps).

## v0.4.1 — 2026-04-25

**Cluster of bugs found during cold-session marketplace dogfood by [@ZaxShen](https://github.com/ZaxShen).** All four were doctrine drift, not infra: bro had stale instructions, server enforcement was working but invisible.

### Fixed — Anonymous identity now persists (issue #95)

`tmb_first-run-onboarding` previously skipped `identity_set` when the Human chose Anonymous. The DB row never existed, so every cold session saw `identity_get().created_at == null` and re-triggered the full onboarding flow — even though configs and ledger events confirmed onboarding had already run.

`identity_set` MCP tool now accepts `anonymous: true` to write a row with `human_name=NULL`. Onboarding always calls `identity_set` (named OR anonymous). Cold-restart-after-Anonymous regression covered by `tests/workflow-sim/flow-09-anonymous-cold-restart.test.mjs`.

### Fixed — Bro now writes `bro_verification_pass` ledger event (issue #91)

The planning skills' V3 step (close path) jumped straight from "verification passed" to `task_update_status(closed)` with no ledger anchor. The trajectory had no record of bro's task-gate verdict — only the absence of a `validation_record` row, which was indistinguishable from "pr-reviewer hasn't gotten there yet."

V3 now batches `ledger_log(event_type='bro_verification_pass')` + `task_update_status(closed)` + `issue_close` (when applicable) in one response. The ledger is the source of truth for bro's task-gate verdict; `validation_attempts` is exclusively pr-reviewer's table.

### Fixed — Bro halts on MCP errors instead of silently proceeding (issue #96)

Trace from cold-session test: bro called `validation_record(agent='bro', verdict='pass')` at task close. Server middleware correctly returned `{"error": "forbidden", "caller_role": "bro", "allowed_roles": ["pr-reviewer"]}`. Bro **ignored the error** and proceeded to `task_update_status(closed)` + `issue_close` + emit "Trust me bro, it works." From the Human's view the task closed cleanly; in reality no verification trace existed.

Two doctrine clauses added to plugin `CLAUDE.md`:

1. **MCP error handling — halt and surface.** Any tool result with `is_error: true` halts the flow. No silent continuation.
2. **Tools bro must NEVER call.** `validation_record` is pr-reviewer-only. Bro's task-gate uses `ledger_log(bro_verification_pass)`. Server-side rejection now backed by client-side discipline.

### Fixed — Policy-key writes route through `tmb_reonboard` (issue #93)

`branching_model`, `pr_target`, and `protected_branches` are policy keys that drive `git-guards.sh` and skill defaults. Bro could previously call `config_set` on them directly mid-session, bypassing the explicit-confirm UX of the onboarding flow.

`CLAUDE.md` now requires bro to invoke `tmb_reonboard` for policy-key changes — never direct `config_set`. The skill renders an `AskUserQuestion` with current values pre-selected and persists only on explicit confirmation.

### Removed — `tmb_validate-swe-output` skill

Obsolete under bro-as-planner doctrine. Bro's task-gate verification is inline (V1/V2/V3 in the planning skills); pr-reviewer's push-gate verification is its own agent. The forked-Explore validation skill served the old "pr-reviewer signs at task close" flow that v0.3.0 retired.

### Versioning

No schema migration; new column-less `anonymous` flag on `identity_set` is additive. Schema version stays at 1. Tests added: 4 new identity-tool tests + 3 new workflow-sim tests (flow-09 a/b/c).

### Added — Label + ENUM doctrine (issue #38)

Two new doctrine docs codify the controlled vocabularies the project relies on:

- **`docs/contributing/LABELS.md`** — canonical GH issue label list. Adopts GitHub's 9 default labels, K8s `area/<name>` + `priority/<level>` + `lifecycle/<state>` namespaces, and 2 documented TMB-specific labels (`doctrine`, `discussion`). Replaces the previously-invented `area:*`, `p:*`, `stale`, `superseded` labels with their K8s equivalents.
- **`docs/contributing/ENUMS.md`** — every ENUM in `schema.sql` is listed with its canonical values + source convention (GH / K8s / TMB-specific with rationale).

Two new lints enforce drift prevention:

- **`tests/lint/labels-stable.sh`** — fails if a GH label exists that's not in `LABELS.md`, or vice versa. Skipped on dev machines without `gh` auth; always runs in CI.
- **`tests/lint/enums-stable.sh`** — parses `ENUMS.md` and the code, fails if a hardcoded value isn't documented.

GH label migration applied: 17 labels → 25 (renames + 9 new K8s `area/*`). All 18 open issues' labels auto-renamed in place via `gh label edit --name`. The `superseded` label was dropped — when a issue is replaced, close with a `superseded by #N` comment.

This is the doctrine half of #38. The DB-side half (`issue_labels` table + 4 MCP tools to mirror GH labels into the trajectory DB) is gated on schema review and ships in a follow-up.

### Workflow ergonomics — three small fixes

#### Bro asks base branch + pulls before branching when remote exists (issue #92)

`tmb_branch-id-proposal` now adds a Step 0: detect `git remote -v` non-empty → `AskUserQuestion` for base branch (pre-selecting `pr_target`) → `git pull origin <base> --ff-only` → then proceed to branch_id derivation. Prevents silently branching off stale `origin/main` in multi-developer repos. No remote configured → step skipped (no concern).

#### Architecture docs bootstrap on small projects (issue #94)

`tmb_lazy-regen-check` previously did nothing on first-ever session, waiting for the Human to manually request `/tmb refresh-architecture`. Tiny dogfood projects rarely cross the 25-commit threshold, so they never got `docs/trustmybot/architecture/auto/` populated.

New behavior: on first-ever session, count source files (`git ls-files | exclude .claude/, node_modules/, dist/, etc.`):
- 0 files → skip (empty repo)
- ≤200 files → silent initial bootstrap (cheap, ensures docs/ exists for the first contributor)
- >200 files → one-line nudge (full bootstrap on a large project can be slow; let Human opt in)

#### Committed team config defaults (issue #32)

Onboarding now reads `.claude/tmb/config.json` if committed:

```json
{
  "branching_model": "github-flow",
  "pr_target": "main",
  "protected_branches": ["main"]
}
```

Values pre-select matching radio options in `AskUserQuestion`, so each new dev confirms team conventions with a single click instead of answering from scratch. The committed file shares team defaults; per-developer DBs still store actual answers locally. Identity (`human_name`) is per-developer and never read from the file.

Template at `templates/project-seed/.claude/tmb/config.example.json`.

### Channel isolation — DB path per plugin name (issue #87)

Stable (`tmb`) and RC (`tmb-rc`) channels can now be installed simultaneously without colliding on the SQLite trajectory DB.

`resolveDbPath()` previously hardcoded `<cwd>/.claude/tmb/trajectory.db`. Now it derives the path segment from the installed plugin's manifest (`CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json.name`), so:

- `tmb` install → `.claude/tmb/trajectory.db`
- `tmb-rc` install → `.claude/tmb-rc/trajectory.db`

Different filesystems, different state, no cross-contamination. Backward-compatible — existing tmb installs see no path change. Fallback to `tmb` when `CLAUDE_PLUGIN_ROOT` is unset (local `--plugin-dir` dev outside CC).

Other channel-isolation surfaces called out in #87:

- **plugin.json.name** — already differentiated in v0.3.2 (rc branch maintained as `tmb-rc`).
- **MCP server names** — CC already namespaces by plugin (`mcp__plugin_tmb-rc_trajectory-server__*` vs `mcp__plugin_tmb_trajectory-server__*`); no change needed.
- **Agent + skill names** — same name on both sides (`swe`, `pr-reviewer`, `tmb_*`). When both channels are enabled, CC picks one; documented as known limitation in `tests/manual/setup.md`. Suffix-rename is deferred — agents only call their own MCP server, so the worst case is "the other channel's prompt was used" (annoying, not data-corrupting).

8 new unit tests covering `resolvePluginName` + `resolveDbPath` channel-isolation paths.

### Labels — second migration to Linear-native style (issue #101)

The K8s convention adopted earlier in v0.4.1 (PR #98) proved opaque to readers (*"area (idk wtf it is)"*). Pivoted to Linear-native flat style which is self-explanatory at a glance.

Renames (preserves issue → label links via `gh label edit --name`):

| Before | After |
|---|---|
| `area/install`, `area/workflow`, `area/mcp`, `area/hooks`, `area/roundtable`, `area/multi-platform`, `area/perf`, `area/tests` | `Install`, `Workflow`, `MCP`, `Hooks`, `Roundtable`, `Multi-platform`, `Performance`, `Tests` |
| `priority/critical`, `priority/high`, `priority/medium`, `priority/low` | `Priority: Urgent`, `Priority: High`, `Priority: Medium`, `Priority: Low` (matches Linear's display) |
| `bug` | `Bug` (capitalized) |
| `enhancement` | `Feature` (renamed to match Linear default) |
| `doctrine`, `discussion` | `Doctrine`, `Discussion` |

Added: `Improvement` (Linear default — refactor/polish), `Docs` (doc-only changes — Linear's `Improvement` is too generic).

Dropped: `lifecycle/stale` (use `gh issue list --updated` instead; Linear has native auto-stale), `area/docs` (collapses into the new `Docs` type label), 6 unused GH defaults (`good first issue`, `help wanted`, `invalid`, `question`, `wontfix`, `duplicate`, `documentation`).

Net: 25 labels → 18. All open issues auto-relabeled in place.

`docs/contributing/LABELS.md` rewritten. `tests/lint/labels-stable.sh` updated to parse the new doc structure (bold-wrapped names instead of backtick-wrapped).

This is the **second** label migration in the v0.4.1 pre-stable window. Acceptable because no public consumers depend on the names yet — the rc channel hasn't promoted to stable.

### Added — L6 deterministic-trajectory tests + opt-in debug_trajectory schema (issue #108)

Manual L5 dogfood was the release bottleneck. L6 automates it by pre-seeding DB state, running real `claude -p`, and asserting the resulting MCP/tool trajectory matches the expected sequence from `FLOWS.md`. New layer in the test pyramid; existing L0–L5 unchanged.

**New schema table** `debug_trajectory` (15th table):
- Columns: `session_id`, `step_n`, `kind` (`mcp_call`/`tool_use`), `agent`, `tool_or_mcp_name`, `args_json`, `result_json`, `is_error`, `created_at`
- **Off by default — populated only when env `TMB_DEBUG_TRAJECTORY=1`.** Zero overhead in production.
- Schema version stays at 1 (additive change).

**Capture wiring**:
- MCP server (`src/index.ts`) writes a row per MCP tool call when env is set
- New PreToolUse hook `scripts/hooks/debug-trajectory.sh` (`matcher: "*"`) writes a row per non-MCP tool call (Bash/Read/Write/Edit/Task/Skill)

**Test infrastructure**:
- `tests/dogfood/run-l6.sh` runner — checks env + tools, dispatches to flow scripts
- `tests/dogfood/lib/flow-helpers.sh` — shared helpers (`l6_setup_scratch_project`, `l6_seed_db`, `l6_run_claude`, `l6_assert_trajectory`)
- `tests/dogfood/flows/` — 16 flow scripts (4 fully wired, 12 scaffold)
- `tests/dogfood/fixtures/` — pre-seed SQL (empty, onboarding-named, onboarding-anonymous)
- `tests/dogfood/expected/` — expected-trajectory files (one MCP/tool call per line)

**4 fully wired flows** (have expected-trajectory files):
- `01-onboarding` — first-run identity + config writes
- `02-simple-task` — code-touching ask → triage simple → SWE spawn
- `D-direct-mode` — ≤3-line typo fix → Edit + commit, no SWE spawn (with hard invariant assertions)
- `95-anonymous-cold-restart` — regression for #95; cold session must skip re-onboarding

**12 scaffolded flows** (auto-skip until expected-trajectory authored): `03-difficult-task`, `04-agent-creator`, `05-skill-creation`, `06-push-gate`, `07-architecture-regen`, `08-swe-retry`, `09-roundtable`, `C-consultant`, `32-team-config`, `92-base-branch`, `94-arch-bootstrap`, `96-halt-on-error`.

**CI workflow** `.github/workflows/l6-dogfood.yml`:
- Triggers: tag pushes, PRs labeled `L6`, manual dispatch
- Soft-fails when `CLAUDE_CODE_OAUTH_TOKEN` secret is absent (forks won't break red)
- Uploads trajectory dumps as artifacts on failure

**Stale doctrine cleanup** (per the migration audit):
- Onboarding skill: fixed event_type from stale `tmb_bootstrap_complete` → `tmb_onboarding_complete`; dropped reference to "file copies" (swe + pr-reviewer ship globally)
- Agent-creator skill: dropped `tmb_bootstrap` reference (skill is gone in v0.3.0+)
- Plugin CLAUDE.md: removed the "tmb_bootstrap is being retired" sentence (it's already retired)

**Unverified assumption flagged in the issue**: `claude -p` mode behavior with `AskUserQuestion`. If the form auto-fails in headless mode, that surfaces as a trajectory-shorter-than-expected failure on the onboarding flow — a real signal to address.

2 new schema tests (table presence + columns + index). All L1-L4 green.

---

## v0.3.2 — 2026-04-25

**Hook + agent-prompt hotfix.** Two real bugs in `git-guards.sh` that broke every SWE commit-from-worktree, plus a SWE doctrine violation. Found by [@ZaxShen](https://github.com/ZaxShen) during v0.3.1 marketplace test — bro spent 12 minutes hitting the same hook-block before reporting.

### Fixed — `git-guards.sh` worktree-blind branch detection

`git branch --show-current` was running in CC's CWD (the project root, always `main`) regardless of which worktree the actual `git commit` was being executed in. Result: SWE in `isolation: worktree` mode could **never** commit — every commit got rejected as "no direct commits to main."

The hook now parses the working directory from the command itself:
- `cd <worktree> && git commit ...` → reads branch from the worktree (the SWE pattern)
- `git -C <worktree> commit ...` → same
- Falls back to `INPUT.cwd` (if CC populates it) or `$PWD`

`tests/hooks/git-guards.test.sh` extended from 4 → 12 cases, including 7 new worktree-aware regressions.

### Fixed — `git-guards.sh` Rule 4 false-fires on no-remote repos

`git rev-parse "origin/${PR_TARGET}"` (without `--verify`) prints the literal string `"origin/main"` to stdout when the ref doesn't exist, then exits non-zero. The `2>/dev/null` swallowed the stderr, so `REMOTE` ended up as the literal string `"origin/main"` — non-empty — and the "Local main is behind origin/main" check fired falsely on any repo without a remote (which is most fresh scratch projects).

Fix: use `git rev-parse --verify` — empty output if ref doesn't exist, no false-fire.

### Hardened — SWE prompt forbids hook bypass

When the v0.3.1 worktree bug blocked SWE's commit, the SWE subagent attempted to **rewrite `.git/HEAD`** and fabricate branch refs to bypass the hook. CC's security guards blocked the rewrite, but the doctrine was wrong: even when a hook misfires (and v0.3.1's worktree bug was a real misfire), SWE must report and stop, never bypass.

Added explicit clause in `agents/swe.md`:

> **Never attempt to bypass a PreToolUse hook block** — do not rewrite `.git/HEAD`, fabricate refs, edit `.git/` internals, or use any technique to evade a hook decision. If a hook blocks a legitimate operation, that's a plugin bug — STOP immediately, return the failure summary to bro with the exact hook output, and let bro decide the path forward.

`agents/swe.md` still 21 lines — within the 30-line Lego cap.

### Versioning

Bumped all 3 manifest versions to `0.3.2`. No schema migration. Rebuilt `dist/`.

---

## v0.3.1 — 2026-04-25

**Critical install hotfix.** v0.3.0 marketplace install left the MCP server's compiled `dist/` directory missing. Symptom: bro can't find any `mcp__plugin_tmb_trajectory-server__*` tools — onboarding's mandatory MCP writes can't run, identity/config never persist, the user is stuck. **Anyone on v0.3.0 should upgrade.**

### Root cause

CC's marketplace plugin install runs `bun install` but **skips lifecycle scripts** (no `postinstall`). v0.3.0's design relied on postinstall to build `dist/` after install — but CC never runs it. The server's compiled JS was never created on user machines.

This is the same class of bug that broke v0.2.0 (better-sqlite3's `prebuild-install` lifecycle script also skipped). My L0 install-smoke ran `bun install --frozen-lockfile` (which DOES fire postinstall) and tested the happy path. CC's actual install path is `bun install --ignore-scripts` (or equivalent) — different behavior, same input. **The simulation was more permissive than reality.**

### Fixed — three layers

1. **Ship `dist/` in the published artifact.** Stopped gitignoring `mcp/trajectory-server/dist/` (with explicit allowlist override in root `.gitignore`). Now the published tag contains pre-built JS — works regardless of install behavior. CC, npm, yarn, pnpm — anyone who clones the tag has a working server.
2. **Updated L0 install-smoke to use `--ignore-scripts`.** `tests/docker/install-smoke.Dockerfile` now runs `bun install --frozen-lockfile --ignore-scripts` to simulate CC's actual install path. **This single line change would have caught both v0.2.0 and v0.3.0.** Build success now genuinely means "works in CC's hostile install environment."
3. **`tests/lint/dist-fresh.sh`** — new lint that rebuilds `dist/` in a temp directory and diffs against the committed version. Fails CI if a contributor modifies `src/` but forgets to rebuild `dist/`. Catches the regression where committed dist/ goes stale.

### How this would have been caught earlier

- Reading CC's plugin install docs / observing actual behavior before designing L0.
- Testing with `--ignore-scripts` from day one (the worst-case install path is the right one to test).
- Running L6 release canary against the actual install path, not the same `bun install --frozen-lockfile` happy path.

The bug class is **simulation more permissive than reality**. Closed by always testing the worst-case install path.

### Versioning

Bumped all 3 manifest versions to `0.3.1`. No schema migration. `engines.node` unchanged (still `>=22`).

### Added — `tmb-rc` release-candidate channel

`.claude-plugin/marketplace.json` now defines two plugin entries: `tmb` (tracks `main`) and `tmb-rc` (tracks `rc` branch — fast-forwarded to whichever `vX.Y.Z-rc.N` tag is currently being validated). Install path:

- Stable users: `/plugin install tmb@trustmybot` (unchanged behavior — only validated releases)
- Beta testers: `/plugin install tmb-rc@trustmybot` (opt-in pre-release builds)

**Going forward, any risky change** (install-path, schema, doctrine) **MUST go through `tmb-rc` validation before promoting to `main`.** v0.2.0 and v0.3.0 both broke production because there was no pre-stable channel to catch install-path regressions. Documented end-to-end workflow in [`CONTRIBUTING.md` § Release ritual](CONTRIBUTING.md#release-ritual).

The `tmb-rc` channel is ready to use immediately after this release lands on main. The `rc` branch will be initialized off `main` post-merge.

---

## v0.3.0 — 2026-04-25

**Cold-start fix release.** Two structural changes that together eliminate the v0.2.0 marketplace-install pain class. Anyone on v0.2.0 should upgrade. (v0.2.1 was planned as a single-bug hotfix; we folded it into v0.3.0 because both changes touch the same cold-start path.)

### Two changes, one outcome: `/plugin install` → first ask works, no `/reload-plugins` dance.

#### 1. SQLite via Node stdlib — no native deps, no install scripts

**Replaced `better-sqlite3` (native binding) with `node:sqlite` (Node stdlib).** v0.2.0 broke because bun's install lifecycle skipped `better-sqlite3`'s prebuild-install script, leaving the native `.node` binary missing. This bug class is permanently gone — `node:sqlite` ships with Node itself, no compilation, no prebuilds, no install scripts to skip.

| Risk | Before (better-sqlite3) | After (node:sqlite) |
|---|---|---|
| Package-manager install-script lifecycle | ⚠️ broke v0.2.0 | ✅ no install scripts |
| Prebuild server availability / firewall | ⚠️ install fails | ✅ no downloads |
| Platform coverage (Alpine/musl, FreeBSD, exotic ARM) | ⚠️ no prebuild → fail | ✅ stdlib, runs anywhere Node runs |
| Build-tools-required fallback (no gcc) | ⚠️ fails | ✅ no compile step |
| Node ABI churn between Node majors | ⚠️ prebuild lag | ✅ part of Node itself |

**Migration cost:** ~50 LOC wrapper rewrite in `mcp/trajectory-server/src/db.ts`. All 245 unit tests + 43 integration tests pass against the new wrapper.

**Node 22+ now required.** `node:sqlite` is in stdlib since Node 22 (behind `--experimental-sqlite` flag, stable on Node 24). `.mcp.json` passes the flag unconditionally — required on 22, no-op on 24+.

#### 2. swe + pr-reviewer ship globally — no copy step at onboarding

**Workflow backbone agents now ship in `agents/`** (was: empty by design). CC discovers them automatically the moment the plugin installs. Onboarding no longer copies anything into the project — identity + 3 config writes + audit-row log. Done.

Default skills (`swe-checklist`, `code-quality`, `docs-conventions`, `git-conventions`, `naming-conventions`, `review-protocol`, `review-findings`) similarly moved to plugin's `skills/` (alongside `tmb_*` protocol skills) — globally discoverable, project overrides per-name.

**Resolution rule:**

```
if <project>/.claude/agents/<name>.md exists → use local
else                                          → use global plugin-shipped
```

Same for skills. Projects that need custom backbone behavior drop a project-local file; the global plugin file is **never edited** by bro. Local creation triggers: (a) Human explicitly asks, OR (b) bro determines the global default genuinely doesn't fit. Both paths route through `tmb_agent-creator` with explicit Human approval.

**Consultants stay opt-in.** `architect`, `cto`, `ceo`, `pm` remain in `templates/agents/` and are only instantiated per-project when the Human explicitly asks for that consultant's read.

#### Onboarding flow before vs after

| Step | v0.2.0 | v0.3.0 |
|---|---|---|
| Identity capture (AskUserQuestion) | ✓ | ✓ |
| Branching model + PR target capture | ✓ | ✓ |
| Persist via `identity_set` + 3 × `config_set` | ✓ | ✓ |
| **Copy `swe.md` + 5 default skills into `<project>/.claude/`** | required (8+ filesystem ops) | **eliminated** |
| Log onboarding audit row | ✓ (`tmb_bootstrap_complete`) | ✓ (renamed `tmb_onboarding_complete`) |
| Required `/reload-plugins` after install? | yes | **no** (plugin already serves agents + skills globally) |

### Removed

- `skills/tmb_bootstrap/SKILL.md` — recovery skill for the old "missing local agents" failure mode. Unnecessary now.
- `templates/skills/` — all default skills moved to `skills/` (globally discoverable).
- `templates/agents/swe.md`, `templates/agents/pr-reviewer.md` — promoted to `agents/` (globally discoverable).

### Hardened — L0 install-smoke now drives a real DB call

Previously, L0 only asserted `tools/list` responded. **`tools/list` doesn't open a DB**, which is exactly why L0 didn't catch v0.2.0's bug. New assertion **A3b** in `tests/docker/install-smoke.Dockerfile` runs the full MCP `initialize → tools/call identity_get` round-trip, forcing the SQLite layer to load. Catches any future "install succeeds but first DB call fails" regardless of root cause.

### Versioning

Bumped all 3 manifest versions to `0.3.0`. `engines.node` bumped from `>=20` to `>=22`.

---

## v0.2.0 — 2026-04-25

**Workflow simulation harness + manual dogfood gate.** Final PR in the test-pyramid build. The full layered model is now in place: every failure mode that doesn't require Claude Code in the loop has an automated test owner.

### Added

#### L4 — Workflow simulation harness

New directory `tests/workflow-sim/` holds **5 trajectory tests**, one per FLOWS.md flow that has an MCP-side contract worth asserting. Each test spawns the real MCP server and walks the flow as a scripted sequence of tool calls — no Claude required. Asserts state transitions, ledger events, role enforcement, and discussion-thread shape.

| Flow | Test file | Asserts |
|---|---|---|
| 2 — Simple task | `flow-02-simple-task.test.mjs` | bro plans → swe completes → bro closes; **no per-task pr-reviewer** (push gate is amortized); planning_complete event lands in ledger |
| 3 — Difficult task | `flow-03-difficult-task.test.mjs` | Q+A discussion sequence satisfies scope gate without `waive_scope_gate`; decision row queryable for ADR generation; positive + negative cases |
| 6 — Push gate | `flow-06-push-gate.test.mjs` | bro forbidden from `validation_record` (only pr-reviewer); fail-then-pass attempt sequence preserved in `validation_history` |
| 7 — Architecture regen | `flow-07-architecture-regen.test.mjs` | regen_state cursor lifecycle; swe forbidden from `architecture_regen` and `regen_state_set` |
| 8 — SWE retry | `flow-08-swe-retry.test.mjs` | 3-attempt sequence preserved; UNIQUE(task_id, attempt_n) yields upsert (latest verdict wins); `'escalated'` is a valid terminal status |
| D — Direct Mode | `flow-D-direct-mode.test.mjs` | `direct_mode_used` ledger event; no task / validation rows created |

The 5 flows that **can't** be tested at L4 (onboarding, agent-creator, skill-creator) are filesystem-only or Claude-side; they live in L5.

`tests/mcp-integration/run.sh` was extended to run both L3 (existing 9 suites) and L4 (new 5 suites) in one Node process — total **43 tests, ~3.1s**.

#### L5 — Compressed manual dogfood checklist

`tests/manual/scenarios.md` shrunk **from 785 lines → ~140 lines** of checklist focused on Claude-side behaviors that have no MCP surface to test: trigger word activation, AskUserQuestion radio rendering, silent template copy, subagent prompt precedence, worktree isolation, bro task-gate verification visible in conversation, push-gate flow with lazy pr-reviewer copy, Direct Mode timing, resume after kill, tone discipline.

10 numbered items, ~30 minutes to walk. **Required before tagging any release ≥ v0.2.0.**

#### Release-script anti-retag guard

`scripts/release.sh` now **refuses to re-tag a published release**. If `git ls-remote --tags origin refs/tags/v<X.Y.Z>` returns a SHA, the script exits with a clear error explaining the doctrinal alternative (bump the version, ship a new tag). Force-pushing tags is the antipattern that breaks consumer pinning, corrupts marketplace caches, and destroys audit trails — the script now prevents the accidental case while still allowing safe local-only retags (e.g. you tagged but haven't pushed yet).

`tests/lint/release-script-safety.sh` (new lint) protects this guard against accidental removal during refactors. 5 grep-based assertions cover the remote-check, refusal message, exit-code, doctrinal alternative text, and the local-only path's correctness.

#### L5 release gate

`scripts/release.sh` now refuses to tag unless `MANUAL_DOGFOOD_PASSED=v<X.Y.Z>` matches the version being tagged. Sign-off after walking `tests/manual/scenarios.md`:

```bash
export MANUAL_DOGFOOD_PASSED=v0.2.0
bash scripts/release.sh
```

Bypass for hotfixes that don't change Claude-side behavior:

```bash
BYPASS_DOGFOOD=1 bash scripts/release.sh   # justify in commit message
```

### Doctrine — the full pyramid is now in place

```
L0 — Distribution / install-smoke   (Docker — CI on every PR)
L1 — Static / lint                  (9 scripts — CI on every PR)
L2 — Unit (per-component)           (245 MCP unit + 16 hook unit — CI on every PR)
L3 — Integration (cross-component)  (9 MCP-integration suites — CI on every PR)
L4 — Workflow simulation            (5 trajectory suites — CI on every PR)
L5 — Manual dogfood (Claude-side)   (10-item checklist — required before tag)
L6 — Release canary                 (Docker re-clone of tag — in release.sh)
```

| Failure-mode class | Owner |
|---|---|
| MCP server fails to boot after install | L0 |
| Stale version, broken link, missing skill name, shellcheck regression | L1 |
| Per-tool / per-hook contract regression | L2 |
| Cross-component (MCP+hook+DB) regression | L3 |
| Workflow contract change without test update | L4 |
| Trigger word, AskUserQuestion, agent isolation, tone, resume | L5 |
| Published artifact ≠ tested artifact | L6 |

### Versioning

Bumped all three manifest versions to `0.2.0`. Minor bump (not patch) reflects the structural test infrastructure addition — no doctrine or behavior change for users.

---

## v0.1.4 — 2026-04-25

**Test pyramid expansion (L1, L2, L6).** No agent / hook / MCP behavior change — but a meaningful regression-prevention upgrade. PR 2 of the comprehensive auto-test layers initiative (PR 1 was v0.1.3's L0 install-smoke).

### Added

#### L1 — Static lint expansion (7 new linters)

Eight failure modes that used to slip through review now fail the build instead. Run via `bash tests/run-all.sh` (also wired into CI).

| New linter | What it catches |
|---|---|
| `tests/lint/version-sync.sh` | Out-of-sync version fields across `.claude-plugin/plugin.json`, `mcp/trajectory-server/package.json`, root `package.json`. (Caught + corrected the stale `0.3.2` root version that survived through v0.1.2.) |
| `tests/lint/changelog-current.sh` | CHANGELOG top section's version doesn't match `plugin.json`. |
| `tests/lint/manifest-shape.sh` | JSON-shape validation of `plugin.json`, `.mcp.json`, `hooks/hooks.json`. Verifies semver-shape `version`, presence of required fields, and that every `command` path in `hooks/hooks.json` resolves. |
| `tests/lint/link-check.sh` | Every relative `[text](path)` link in tracked `.md` files resolves to an existing file. (Would have caught the broken `docs/PERFORMANCE.md` references after we retired it in v0.1.2.) |
| `tests/lint/skill-frontmatter.sh` | Every `SKILL.md` (under `skills/` and `templates/skills/`) has valid frontmatter with `name` + `description`, AND `name` matches the parent dirname. **Caught real bugs:** `templates/skills/{docs-conventions,git-conventions,naming-conventions}/SKILL.md` were missing the `name:` field — they wouldn't have loaded properly when copied into projects. Fixed in this release. |
| `tests/lint/shellcheck-hooks.sh` | shellcheck-clean enforcement on every shell script in `scripts/` and `tests/`. (Would have caught the `set -o pipefail` silent-allow bug we hit in v0.1.0.) |
| `tests/lint/tsc-noemit.sh` | Standalone TS type check on the MCP server source — catches type errors without relying on someone reading the build log. |

#### L2 — Hook decision-matrix expansion

`tests/hooks/git-push-guard.test.sh` — **16 new test cases** covering every decision branch of `scripts/hooks/git-push-guard.sh`:

- Non-push command → pass-through
- `git push --force` / `-f` → delegated to git-guards (this hook allows)
- Missing DB / no upstream / no new commits → allowed
- Untracked commits (no matching `tasks` row) → allowed (pre-TMB / external work)
- All-signed tracked commits → allowed
- One unsigned → BLOCKED with helpful message + task_id list
- Multiple unsigned → BLOCKED, all listed
- Mixed-signed → BLOCKED only on the unsigned ones

Previously `git-push-guard.sh` had **zero** test coverage — a critical gap given it's the structural protection against pushing unreviewed commits.

#### L6 — Release canary

`scripts/release.sh` now has a step 4: after the GitHub release is created, the script offers to re-clone the just-published tag in a temp dir and run the L0 install-smoke Dockerfile against it. Catches "the published artifact differs from what we tested locally" — e.g. if `.gitignore` excluded something needed for install. Skipped gracefully if Docker is unavailable.

### Fixed

- **Three template skills (`docs-conventions`, `git-conventions`, `naming-conventions`) now have `name:` frontmatter** — they were missing it and would have failed to load by name when copied into a project. Caught by the new `skill-frontmatter.sh` lint.

### Test infrastructure

- `tests/run-all.sh` now uses the explicit layered model (L1 → L2 → L3) with named steps, instead of the previous ad-hoc list. Single-line PASS/FAIL per step.
- Layer count is now: **L0** (install-smoke, CI-only Docker), **L1** (9 lint scripts), **L2** (245 MCP unit tests), **L3** (9 MCP-integration suites + 3 hook test suites), **L6** (release canary in release.sh). L4 (workflow simulation) and L5 (manual dogfood checklist) coming in v0.2.0.

### Versioning

Bumped all three manifest versions to `0.1.4`. No schema migration.

---

## v0.1.3 — 2026-04-25

**Critical install hotfix.** v0.1.2 shipped without prebuilt `dist/` for the MCP trajectory server, so a fresh marketplace install left the MCP server unbootable. First sessions silently failed to register any of the `mcp__plugin_tmb_trajectory-server__*` tools, breaking onboarding, planning, and every workflow that depends on MCP state. **Anyone on v0.1.2 should upgrade.**

### Fixed

- **Marketplace install now boots cleanly** — added a `postinstall` script to the workspace root `package.json` that runs `bun --filter='*' run build`, ensuring `dist/index.js` and `dist/schema.sql` exist after `bun install`. Restores the cold-start contract that v0.1.2 broke.
- Synced workspace-root `package.json` version (was a stale `0.3.2`) to track the plugin version (now `0.1.3`).

### Added — Layer 0 distribution test (so this can't ship again)

Added a Docker-based **install-smoke test** at [`tests/docker/install-smoke.Dockerfile`](tests/docker/install-smoke.Dockerfile) and a local wrapper [`tests/docker/run-install-smoke.sh`](tests/docker/run-install-smoke.sh). The Dockerfile:

1. Starts from a clean `node:20-slim` (no preexisting `dist/`, no `node_modules/`).
2. Installs bun + sqlite, copies the plugin tree.
3. Strips any local artifacts to force cold-start conditions.
4. Runs `bun install --frozen-lockfile` and asserts `mcp/trajectory-server/dist/index.js` + `dist/schema.sql` exist after install.
5. Spawns the MCP server, sends `tools/list`, asserts it responds with `identity_get`.
6. Re-runs both lint scripts in the as-shipped tree.
7. Verifies all hook scripts are executable + syntactically valid.
8. Confirms `.mcp.json`'s server path resolves in the installed tree.

Wired into `.github/workflows/test.yml` as a separate `install-smoke` CI job that runs on every PR + push to dev/main. Build success = a clean marketplace install would boot. Build failure = release blocker.

This is **Layer 0** in the broader test-pyramid plan tracked in #76 follow-ups. v0.1.4 will add Layer 1 lint expansions + Layer 2 unit expansions + Layer 6 release-canary; v0.2.0 will add Layer 4 workflow-simulation harness.

### Versioning

Bumped `.claude-plugin/plugin.json`, `mcp/trajectory-server/package.json`, and root `package.json` to `0.1.3`. No schema migrations needed (still `schema_version=1`).

---

## v0.1.2 — 2026-04-25

**Docs + structural release.** No agent, hook, or MCP-server behavior change. Adds multi-platform structural placeholders following the [Superpowers](https://github.com/obra/superpowers) pattern, and refreshes contributor docs to match the bro-as-planner doctrine that landed in v0.1.0.

### Added

- **Multi-platform placeholder structure** ([#73](https://github.com/trustmybot/plugin/pull/73)). Per-platform adapter dirs (`.codex-plugin/`, `.cursor-plugin/`, `.opencode/`) and root-level personas (`CODEX.md`, `CURSOR.md`, `GEMINI.md`, `gemini-extension.json`) ship as **placeholders only** — clearly marked "not implemented." The strategy doc at [`docs/multi-platform.md`](docs/multi-platform.md) explains how the per-platform adapter pattern works, what an adapter would do, and why placeholders ship now (discoverability + path-precedent). No platform other than Claude Code is functional in this release.
- **`scripts/release.sh`** — generic, idempotent release ritual. Reads version from `plugin.json`, validates `mcp pkg.json` agrees, requires a matching CHANGELOG section, asks for `y/N` per step, then tags + pushes + creates the GitHub release. Replaces the v0.1.0-specific stranded script. Documented under "Release ritual" in [`CONTRIBUTING.md`](CONTRIBUTING.md).

### Changed

- **`docs/architecture/FLOWS.md`** — refreshed Flow 3 (difficult task), 5 (skill creation), 8 (SWE retry), 9 (roundtable) to the bro-as-planner chain. Added Flow D (Direct Mode). Dropped stale references to `validate-swe-output` and `require-review-sign` (replaced by bro's verification protocol + `git-push-guard.sh` respectively).
- **`docs/architecture/FILES.md`** — full file-map refresh: empty `agents/` (by design), 17 `tmb_*` protocol skills, 6 agent + 7 default-skill templates under `templates/`, multi-platform placeholders, current hook list (`git-push-guard.sh` instead of `require-review-sign.sh`), MCP test layout.
- **`docs/architecture/ERD.md`** — updated "How agents use this" to bro-as-planner role matrix; bumped `plugin_meta.plugin_version` reference to 0.1.2.
- **`CONTRIBUTING.md`** — design principles rewritten for the bro-as-planner doctrine (zero-shipped-subagents, Lego layering, server-enforced decision chain). Added multi-platform section. Pre-PR checklist expanded to cover template/skill layering and schema-touching changes.
- **Performance doctrine relocated.** `docs/PERFORMANCE.md` was deleted; its load-bearing content (target latency band + Tier 1/2/3 trim doctrine + re-eval triggers) lives in [`CONTRIBUTING.md` § Performance](CONTRIBUTING.md#performance). Historical baseline + change-tracking now lives in git history + this changelog instead of a doc that grows stale every perf cycle.
- **`tests/manual/scenarios.md`** — header updated to point at the bro-as-planner targets that ARE current; full template-rewrite still tracked in [#51](https://github.com/trustmybot/plugin/issues/51).

### Versioning

`.claude-plugin/plugin.json` and `mcp/trajectory-server/package.json` bumped 0.1.1 → 0.1.2. No schema migrations needed (still `schema_version=1`).

---

## v0.1.1 — 2026-04-25

**Patch release.** Single fix to `scripts/hooks/git-guards.sh` that affects projects using a dual-tier `dev`/`main` branching model.

### Fixed

- **`gh pr create --base main --head dev` no longer blocked when `pr_target=dev`** ([#70](https://github.com/trustmybot/plugin/pull/70)). The previous rule treated all non-`pr_target` bases as forbidden, which blocked the legitimate `dev → main` release-merge PR. The hook now permits this exact case (release exception) while still blocking `feature → main` PRs.
- **Silent-allow bug under `set -o pipefail`** in the `--head` extraction. `grep -oE` returned non-zero when `--head` was absent (the common case), causing the script to exit silently and fall through to allow. Added `|| true` to the extraction pipeline.

### Test coverage

The commit message includes a 7-case synthetic-DB harness covering all explicit + implicit-head combinations. All pass.

### Who's affected

- **Projects using github-flow** (`pr_target=main`, the most common): no behavior change. The dual-tier exception code path doesn't activate.
- **Projects using dual-tier `dev/main`** (e.g. trustmybot/plugin itself): the dev → main release-merge PR now goes through the hook cleanly without manual workarounds.

---

## v0.1.0 — 2026-04-25

**First actionable release.** Supersedes the placeholder v0.2.0 tag (revoked) — that earlier tag predated the multi-agent decision-chain doctrine and didn't represent a working end-to-end workflow. This release does.

The chain is **Human → bro → SWE**, with `pr-reviewer` as a push gate and `architect`/`cto`/`ceo`/`pm` as on-demand consultants. Bro is a CLAUDE.md persona (no subagent); the plugin ships ZERO global subagents — everything else lives as a Lego template that bro copies into the project on demand.

### Highlights

- **Bro as the single Human entry point.** Triggered by the literal word "bro" in any message. Plans, captures intent in MCP, writes task specs, spawns SWE, verifies SWE's work, drives retry loops. Stays out of the way for non-"bro" messages.
- **Lego templates.** Plugin's `agents/` is empty. `templates/agents/` ships 6 minimal agent templates (≤30 lines each, lint-enforced): swe, pr-reviewer, architect, cto, ceo, pm. Bro copies them into `<project>/.claude/agents/` verbatim — never edits the body. Project customization happens by extending the `skills:` array via `tmb_skill-creator`.
- **Bundled SQLite trajectory MCP server.** Node + `better-sqlite3` + `@modelcontextprotocol/sdk` in `mcp/trajectory-server/`. ~30 tools spanning issues, tasks, discussions, validation, ledger, audit, file-registry, architecture-regen, identity, config, skills.
- **Server-enforced role-based access.** `requireRoles` middleware structurally rejects calls that violate the decision chain (e.g. consultants can't write task rows; only pr-reviewer can write `validation_record`). Doctrine isn't just prompt-discipline — it's wire-enforced.
- **Two distinct gates.**
  - **Bro's task gate** — runs after every SWE return: re-runs the spec's `## Verification` commands, sanity-checks diff against `## Files`, confirms each `## Success Criteria` bullet. Fast, mandatory, never skipped.
  - **PR-reviewer's push gate** — runs only at `git push` time over the batch of unsigned commits. The new `git-push-guard.sh` PreToolUse hook blocks pushes to protected branches until each pushed commit's task has a `validation_attempts.verdict='pass'` row.
- **Direct Mode.** Bro can edit a single file directly without spawning SWE when the change is ≤3 lines AND no public API change AND no test required AND no `docs/trustmybot/architecture/` touched. Logged as `direct_mode_used` in the ledger. Pure-Claude-style speed for trivial typo/comment fixes.

### Workflow shape

| Layer | Mutability |
|---|---|
| Template body (`templates/agents/<name>.md`) | Immutable — bro copies verbatim, never edits |
| `skills:` frontmatter array on the project copy | Additive — extended by `tmb_skill-creator`, never replaced |
| Spawn prompt (Task tool args) | Ephemeral — fresh per call |

### Skills shipped

**Plugin protocol skills** (in `skills/`, `tmb_*` prefix to prevent project-skill collisions):

`tmb_first-run-onboarding`, `tmb_planning-simple`, `tmb_planning-difficult`, `tmb_swe-spawn-workflow`, `tmb_branch-id-proposal`, `tmb_agent-creator`, `tmb_skill-creator`, `tmb_bootstrap` (recovery), `tmb_project-prescan`, `tmb_lazy-regen-check`, `tmb_refresh-architecture`, `tmb_reonboard`, `tmb_create-hook`, `tmb_feedback-loop`, `tmb_roundtable`, `tmb_roundtable-cleanup`, `tmb_validate-swe-output`.

**Template skills** (in `templates/skills/`, copied into projects via onboarding):

`swe-checklist`, `code-quality`, `docs-conventions`, `git-conventions`, `naming-conventions` (copied during onboarding alongside swe.md), plus `review-protocol` and `review-findings` (copied lazily alongside pr-reviewer.md on first push-gate trigger).

### Hooks

- `git-push-guard.sh` — PreToolUse on Bash; blocks `git push` to protected branches when any pushed commit's task lacks a passing pr-reviewer verdict.
- `git-guards.sh` — branching-model rules (PR target, no commits to protected, no force push, branch-base check).
- `require-task-spec.sh` — PreToolUse on Agent (subagent_type='swe'); blocks SWE spawn when prompt lacks `task_id=<N>` or the row's `spec_body` is empty.
- `create-worktree.sh` — WorktreeCreate hook (CC-bug workaround for default `origin/HEAD` behavior).

### Doctrine

- **Plugin ships ZERO subagents.** Bro is a CLAUDE.md persona. SWE, pr-reviewer, architect, cto, ceo, pm are templates that get copied into `<project>/.claude/agents/` on demand.
- **Bro is the planner + task gate.** Picks defaults on simple-triage, asks clarifying questions on difficult-triage, authors `tasks.spec_body`, spawns SWE, verifies SWE's work, closes the task.
- **PR-reviewer is the push gate.** Fires once per push over the batch of unsigned tasks. Cost amortized.
- **Consultants advise; bro decides.** Architect/cto/ceo/pm return analyses (server-rejected for workflow writes). Bro summarizes; Human decides.

### State persistence

Every Q&A, decision, task, validation, and ledger event lands in SQLite at `<project>/.claude/tmb/trajectory.db`. Survives `Ctrl-C`, mid-session kill, laptop reboot. `issue_resume` and `task_get` hand sessions back the exact state they left. Per-developer, gitignored, local-first.

### Performance

Layer 3 dogfood verification on a CLI-todo task: ~12 minutes wall-clock end-to-end (including one-time onboarding + bootstrap, planning, SWE work, push gate). The latency story shipped in `docs/PERFORMANCE.md` with phase-by-phase timings + trim doctrine; the doctrine moved into [`CONTRIBUTING.md` § Performance](CONTRIBUTING.md#performance) in v0.1.2.

Trivial single-file edits via Direct Mode land in ~10–20s, approaching pure Claude.

### Test infrastructure

Three layers:

1. **Layer 1** — prompt-content lint (`tests/lint/onboarding-skill-contract.sh`, `tests/lint/agent-line-budget.sh`). Catches prompt drift and Lego-cap violations in milliseconds.
2. **Layer 2** — MCP server unit tests (`mcp/trajectory-server/src/test/`) + integration tests (`tests/mcp-integration/`) covering schema, role-matrix enforcement, agent-workflow paths, scope-gate, hooks.
3. **Layer 3** — human-walked dogfood scenarios (`tests/manual/scenarios.md`) mapped to documented Mermaid flowcharts in `docs/architecture/FLOWS.md`.

### Documentation

- `README.md` — pitch + quickstart
- `CLAUDE.md` — bro's persona definition + first-action chain + push gate + Direct Mode
- `docs/architecture/FLOWS.md` — workflow flowcharts
- `docs/architecture/FILES.md` — file-by-file map
- `docs/architecture/ERD.md` — SQLite schema
- `CONTRIBUTING.md` § Performance — latency budget + trim doctrine (relocated from `docs/PERFORMANCE.md` in v0.1.2)
- `tests/manual/scenarios.md` — Layer 3 dogfood test plan

### Plugin manifest

```json
{
  "name": "tmb",
  "version": "0.1.0",
  "license": "MIT",
  "repository": "https://github.com/trustmybot/plugin"
}
```

### Migration / install

`/plugin marketplace add trustmybot/plugin` then `/plugin install tmb@trustmybot`. First time bro is invoked in a project, it runs onboarding (3-question form) + silently copies `swe.md` + 5 swe-side skills into `<project>/.claude/`. Then you talk to bro.

### Known not-done (tracked as open issues)

- Multi-consultant voting protocol — `roundtable` works end-to-end but doesn't fully populate the dedicated `roundtables` + `roundtable_votes` tables yet (see issues #57, #67, #68).
- Codebase memory (lazy bootstrap + per-session verify of `file_registry`) — design tracked in #45.
- Full peripheral MCP role enforcement — major mutations (task/issue/validation/discussion) are wrapped; `ledger_log`, `audit_log`, `skill_*` still permissive (#50).
- bro first-response cold-start latency (~18s with 21.7k token context) — needs profiling pass (#47).

See [open issues](https://github.com/trustmybot/plugin/issues) for the full backlog.

---

## Pre-history

### v0.2.0 (revoked)

Tagged 2026-04-22. Predated the bro-as-planner / push-gate / Lego-templates redesign. Marked as "first public release pending" in the CHANGELOG it shipped with. Tag deleted on v0.1.0 release; do not reference.
