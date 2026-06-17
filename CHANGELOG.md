# Changelog

All notable user-visible changes to the TMB plugin. Versions follow [SemVer](https://semver.org/) (pre-1.0: breaking changes may happen on minor bumps).

## Unreleased

## v0.10.0-beta — 2026-06-17

### Added
- **README-staleness nudge after close** (#87): a new PostToolUse hook (`post-atomic-close-readme.sh`) fires on `bro_atomic_close` and deterministically detects when the just-closed task's commit touched a directory whose `README.md` is missing or older than the commit — the world model derives each dir's summary from its README, so a stale README silently degrades `world_model_get` / `world_model_search`. When stale, it emits a non-blocking `additionalContext` nudge and records one `readme_staleness_surfaced` audit row; the actual README update stays bro's judgment. No-op (exit 0, never exit 2) on a fresh README, an errored close, or an unresolvable task/commit.
- **Cheatcode vet stage** (#658): `cheatcode_vet` gathers reputation + security-surface signals for a candidate and emits a deterministic trust tier (trusted / caution / untrusted / unknown) + one-line rationale + capability list — a reproducible classification of the signal set, never an install verdict. A code-executing candidate (ships hooks / MCP / scripts) is never classified `trusted` on popularity alone; failed or empty signals degrade to `unknown` and never crash. Network stubbed via `TMB_CHEATCODE_VET_FIXTURE` in CI.
- **Cheatcode install stage + approval gate** (#659): `cheatcode_install` installs a vetted cheatcode (skill / MCP toolkit / plugin) via the marketplace-install path (no seeding), writing one `cheatcodes` row plus its `cheatcode_attachments` record(s) in a single transaction and emitting `cheatcode_install` / `cheatcode_installed` audit rows; re-installing the same candidate no-ops. Installs are human-approved, never silent — a PreToolUse gate (`cheatcode-install-approval.sh`) blocks the install until a per-candidate `cheatcode_approve` record exists and fails closed otherwise. A standalone-skill install never edits agent frontmatter: it returns a proposed-PR payload for the Human-reviewed prompt-surface change. `cheatcode_install` takes a `scope` (`local` | `global`, default `local`) — local-scope is the default so installs never trigger a global/local prompt — forwarded to the install script as `--scope` and persisted on the new `cheatcodes.scope` column; per-agent attachment targets (e.g. feature-dev → swe, code-review → pr-reviewer) flow through from the install fixture/script onto `cheatcode_attachments.target`. New `cheatcodes` + `cheatcode_attachments` tables, plus `cheatcodes.scope` (schema v15). Discovery/install fixtures stub the marketplace via `TMB_CHEATCODE_INSTALL_FIXTURE` — no live network in CI.
- **Cheatcode uninstall stage** (#676): `cheatcode_uninstall(cheatcode_id)` reverses an install in a single transaction — it forks `scripts/cheatcode-uninstall.sh` to reverse the attachment via the marketplace/plugin uninstall path (no manual file deletion), deletes the `cheatcodes` + `cheatcode_attachments` rows, and emits a `cheatcode_uninstalled` audit row. Idempotent: an absent or partial install no-ops without error. Removal is bro-proposed + Human-confirmed (AskUserQuestion), not PreToolUse-gated. Marketplace teardown stubbed via `TMB_CHEATCODE_UNINSTALL_FIXTURE` — no live network in CI.
- **Cheatcode hot-load / activate stage** (#660): `cheatcode_activate(cheatcode_id)` returns a deterministic activation verdict by kind — a standalone skill is usable in-session (`activated`), while plugin / MCP kinds register on the next `claude -p` cold start (`restart_required` + a reason). It never throws on a known install; an unknown `cheatcode_id` is a clean error. Emits a `cheatcode_activate` audit row.

### Fixed
- **`task_stats` no longer over-counts spawn cost** (#685): the SubagentStop hook (`swe-atomic-close.sh`) inserted a fresh `agent_runs` row on *every* time a SWE came to rest, summed each transcript message's *cumulative* `cache_read_input_tokens` (re-reporting the same cached prefix N times → tens of millions per row), and could attribute a spawn's metrics to a same-batch sibling task via the weak updated-at fallback. The hook now writes exactly one row per spawn (idempotent UPSERT keyed on the spawn's transcript identity), records the spawn's own cache-read/creation as the high-water mark rather than a per-message sum, and refuses to attribute metrics when a transcript is present but yields no `task_id` (logging and skipping instead of guessing a sibling). `task_stats` aggregates are honest again.
- **Headless hook paths survive plugin upgrades** (#680): the headless enforcement shim wrote version-PINNED absolute hook paths (e.g. `.../cache/<mp>/tmb/0.9.2-rc.2/scripts/hooks/<name>.sh`) into `~/.claude/settings.json`, so every plugin upgrade or cache-clean orphaned all 13 entries — headless `claude -p` runs (CI, L5/L6, benches) then silently executed the stale hooks or none. `/onboard` now materializes one stable resolver at `~/.claude/tmb-hooks/resolve-hook.sh` (outside the versioned cache, so it never orphans) and writes version-agnostic commands (`bash <resolver> --marketplace <mp> --hook <name>`). The resolver discovers the active tmb version at hook-fire time — from Claude Code's installed-plugins manifest, falling back to the highest-semver cache dir — and execs the real gate with stdin + argv forwarded untouched. If no version resolves it fails OPEN with a loud stderr warning (never exit 2, which would block every tool call).

## v0.10.0-alpha — 2026-06-16

### Changed
- **Dev channel version bumped to 0.10.0-alpha** (#76): the `dev` channel ships commits without an rc/stable version bump, but Claude Code keys its plugin cache by `plugin.json` version — so dev updates landed as no-ops once the cache dir for `0.9.2-rc.2` existed. Bumping dev to a distinct pre-release version restores cache-busting on update. Includes the Typed Rails work (#673/#681/#682). dev-only: no marketplace-repo, rc, or stable changes.

## v0.9.2-rc.2 — 2026-06-15

### Fixed
- **Headless enforcement shim now actually enforces** (#661): rc.1 wrote the PreToolUse hooks to `~/.claude/settings.json` but they didn't fire — `swe-brief-gate` ran first in the chain and short-circuited before `no-source-edit-from-main`. The shim now excludes advisory/short-circuiting hooks so `no-source-edit-from-main` runs first and denies (end-to-end verified: a direct source edit is blocked under headless `claude -p`). Idempotency now keys on a `_tmb_managed` sentinel (not a `/tmb/` path substring, which missed dev/worktree paths and could accumulate entries), and the shim refuses to write when the plugin root is a dev worktree.

## v0.9.2-rc.1 — 2026-06-15

Headless enforcement for marketplace installs.

### Fixed
- **Headless hook enforcement** (#661): marketplace-installed plugin hooks don't fire in headless `claude -p` (Claude Code activates plugin hooks via the interactive trust dialog, which `-p` skips). TMB's doctrine enforcement is its PreToolUse hooks (the no-source-edit hook forces bro to dispatch swe), so headless/CI users on a marketplace install previously got no enforcement and bro could edit source directly. `/onboard` (`onboard_apply`) now writes a TMB-managed PreToolUse hooks block into `~/.claude/settings.json` — settings.json hooks DO fire headless. Derived from the plugin's own `hooks/hooks.json` (PreToolUse only, plugin-root resolved to an absolute path), idempotent, preserves user hooks, and never fails onboarding.

## v0.9.1 — 2026-06-15

Fresh-install reliability. No workflow or enforcement changes.

### Fixed
- **Fresh-install MCP server** (#647): the trajectory-server's shipped `dist/index.js` is now a self-contained esbuild bundle (`@modelcontextprotocol/sdk` inlined; `kuzu` + `@huggingface/transformers` kept external/lazy). A fresh marketplace install with no `node_modules` now starts the MCP server immediately — previously it failed to resolve the SDK, leaving the trajectory backend and world model dead until a later restart. The world model still lazy-loads via `ensure-kuzu-installed.sh` and degrades gracefully (FTS) in the interim.
- **release.sh canary timeout** (#643): the L0 install-smoke canary `docker build` is wrapped in `timeout` (`${TMB_CANARY_TIMEOUT:-600}`) so a stalled buildkit can't hang a release.

### Tests
- **L0 genuine from-scratch install** (#648): install-smoke now performs a real `claude plugin install` from the under-test tree and asserts the MCP boots from the installed location with no manual dependency install — closing the coverage gap that let #647 ship — plus a committed-dist cold-boot guard.

## v0.9.0 — 2026-06-14

Token-reduction release (cto-audited). Trims the always-on MCP tool-schema cost and per-spawn overhead; no change to workflow behavior or enforcement. Measured −3,784 B / ~1,023 tok off the always-on tool catalog, plus ~12–14K tok saved per pr-reviewer / consultant spawn.

### Changed
- **Per-role MCP tool allowlists (#637):** `pr-reviewer` and the 5 consultant templates now declare explicit per-tool `tools:` lists instead of granting the whole trajectory-server bundle (swe already did this). A read-only reviewer/consultant no longer carries ~60 irrelevant tool schemas — ~12–14K fewer tokens per spawn.
- **Leaner MCP tool schemas (#637):** deduplicated the repeated `agent` param description across all 68 tools (112→59 B each), condensed the 8 `waive_*` descriptions, thinned `task_create_batch` / `task_get` returns (full `spec_body` now only via `include_spec_body`), and bounded `task_brief`'s discussion payload (`decision`/`intent` kept full; other kinds capped to the last 8 + 500-char bodies with a `discussion_search` pointer). Gating, validity, and the `agent` pattern regex are unchanged — purely schema/return-size cuts.

## v0.8.6 — 2026-06-14

### Fixed
- **install-smoke semantic step no longer flakes (#636):** the L0 install-smoke's `discussion_search(mode=semantic)` check gives the embeddings model cold-load headroom (timeout 8→60) and treats a slow/cold model as the graceful `semantic_unavailable` path, failing only on a genuine MCP error payload. Removes a false-red release canary (hit during the v0.8.5 cut).

## v0.8.5 — 2026-06-14

Release-process + multi-repo guard follow-ups to v0.8.4.

### Changed
- **release-gate runs on rc tags only (#630):** dropped the stable-tag trigger from the CI release-gate. The stable tag is functionally identical to the green rc (functional-identity rule), so it's no longer re-gated — saves a full real-CC L6 run per release. rc tags + manual `workflow_dispatch` still trigger it.

### Fixed
- **git-guards scoped to the managed repo (#631):** the no-direct-commit, branch-from-`pr_target`, and PR-target guards now fire only for the managed repo (`tmb_default_repo`), so they no longer block legitimate commits/branches in sibling repos of a multi-repo workspace (e.g. the marketplace channel repos). Single-repo projects are unaffected (the guards stay active when `tmb_default_repo` is empty). Mirrors the #592 no-source-edit scoping.

## v0.8.4 — 2026-06-14

Reliability + upgrade-smoothness release. Hardens the world-model cold start and the SWE enforcement gates, smooths the upgrade flow, defaults SWE to Opus, and retires the flawed-era benchmark narrative.

### Added
- **Smoother upgrades (#602):** SessionStart surfaces the active plugin version and a "restart to apply" note when a newer version is cached but not yet running; `heal-mcp-cache.sh` gains cache GC (`--dry-run`; prunes stale cached versions, keeps active + previous, never deletes the active one); the MCP server warns on a legacy pre-stamp DB (no `plugin_meta`) instead of silently adopting it. `docs/reference/UPGRADE.md` documents the flow.
- **TMB attribution footer (#601):** bro/swe-generated PRs, issues, and MRs carry a TMB-branded footer (`🤖 Generated with Claude Code, powered by Bro`).

### Changed
- **Default SWE model is now Opus (#594):** at parity cost to Sonnet on the hard corpus, Opus avoids the retry-storm tail (better worst-case wall time). Project-local Sonnet overrides remain supported; cost rates updated to Opus tiers.
- **Benchmarks retired from the plugin repo (#593, #595):** the contradicted benchmark section/table, the `tests/l7-benchmark/` tree, and `docs/contributing/BENCHMARK.md` are removed — methodology and receipts now live in the separate benchmarks repo. README reframed to long-term-project + reliability positioning. (The earlier campaign's figures were formally retracted.)
- **Release gate is automated L6 (#622):** retired the stale manual-dogfood sign-off (`MANUAL_DOGFOOD_PASSED`/`BYPASS_DOGFOOD`) from `release.sh`; the gate is now the CI release-gate (L1–L4 + L6 + L0 = local L6 13/13). `release.sh`'s real guards (off-main / dirty / unsynced / version-mismatch) and the Docker canary are unchanged; CONTRIBUTING + `tests/manual` reframe the manual walk as an optional spot-check.

### Fixed
- **World-model cold-start race (#590, #591):** a kuzu single-writer lock race between the SessionStart prescan and the MCP server no longer leaves the world model unavailable for the whole session — the open path retries with bounded backoff, and a genuine lock failure surfaces as `graph_db_open_failed` rather than a phantom "scan already running (pid N)".
- **SWE enforcement gates no longer misfire (#592, #596, #597, #606):** `no-source-edit-from-main` Rule 1 is scoped to the managed repo (`tmb_default_repo`), so sibling repos in a multi-repo workspace aren't blocked; the `prompt_bearing` gate no longer adopts a stale legacy `~/.claude/tmb/trajectory.db` (schema fail-safe) and resolves the task id via the worktree's checked-out branch; `swe-scope-fence` strips markdown backticks from spec `## Files` paths so backtick-wrapped paths no longer deny every in-scope edit.

### Internal
- Pre-release hygiene (#604): startup-log version derives from `package.json`, dead `l7-benchmark` lint-allowlist entries removed, architecture docs synced to current behavior. Test-fixture corrections for the prescan golden snapshot and the SQL-lint allowlist line drift.
- Code simplification (#616): 5 behavior-preserving cleanups across the hooks + MCP server (prepare-once in `pruneDirectories`, case-arm dedupe in `no-source-edit-from-main`, `tmb_sql_int` reuse in `query-task`, precedence grouping in `session-start-prescan`).
- Prompt quality (#615): tightened 5 B/B+ skill/command surfaces (tmb_planning, tmb_review, tmb_skill-creator, agent-create, roundtable) toward A- per DETERMINISM.md — compressed verbatim call-signatures into composite references, judgment-framed procedures; no behavior change.

## v0.8.3 — 2026-06-13

Patch release. Fixes the world-model scan crashing on repos with non-ASCII tracked paths — surfaced when scanning django (the benchmark corpus), which ships `tests/staticfiles_tests/apps/test/static/test/⊗.txt` (U+2297). No Claude-side (agents/skills/CLAUDE.md) changes; the release-gate is skipped per hotfix policy.

### Fixed
- `scan.sh` emitted invalid JSON on repos with a non-ASCII tracked path: git C-quoted the path into octal `\nnn` escapes the awk JSON emitter couldn't portably escape, so `scan_run` aborted with `jq: Invalid escape`. Both git calls now run with `-c core.quotePath=false`, keeping paths as raw UTF-8 (valid inside a JSON string). Added an L3 regression test. (#586)

### Changed
- Plugin description refreshed to reflect the kuzu world model (helping agents understand and navigate complex codebases).

## v0.8.2 — 2026-06-13

Promotes `v0.8.2-rc.2` to stable — functionally identical to the rc (version manifests + CHANGELOG only). See the rc sections below for the full change list: multi-repo / per-repo branching config (#550/#549/#560), per-task bro token attribution (schema v12, #542), GitLab + offline guard parity (#564/#548/#546), worktree-lifecycle and completion-deadlock fixes (#551/#559/#547), and the non-isolated-SWE first-class mode (#547). Licensed by the local L6 chain 13/13 (the rc-tag CI is re-confirmation, not the gate).

## v0.8.2-rc.2 — 2026-06-13

Re-cut of `rc.1` with L6-chain test-fixture determinism fixes only — functionally identical shipped runtime. `rc.1`'s CI re-confirmation flaked on brittle L6 scorers (not product behavior): the `trajectory_required` scorer iterated spuriously on an empty `tools-required.json` under BSD `seq` (#576), and required an explicit `scan_run` call that the session-start auto-prescan already satisfies (#580); the step-12 chain now also pre-creates the resume task's branch (#578). Licensed by local L6 13/13.

## v0.8.2-rc.1 — 2026-06-13

Multi-repo support, per-task token attribution, GitLab/offline parity in the guards, and the worktree-lifecycle fixes that ended the SubagentStop completion deadlock. Schema v10 → v12.

### Added

- **Per-repo branching config** — the `repos` table gains `target_branch` / `branching_model` / `protected_branches` (schema v11). The git/push guards resolve their config from the command's git-root and no-op on unregistered or sibling repos, so a TMB project no longer imposes its branching model on neighbouring repos. Onboarding seeds the per-repo columns (#550, #549, #560).
- **GitLab parity in the guards** — `glab mr create --target-branch` is enforced against the PR target exactly like `gh pr create --base`, and `glab` is recognized everywhere `gh` is. `gh`/`glab auth login` is short-circuited when no remote is configured (it would hang), with a local-only notice at session start (#564, #548).
- **Per-task bro token attribution** — schema v12 adds `agent_runs.usage_baseline_json`; each task's bro row now records its own token delta instead of the whole session's cumulative landing on the newest open row (#542).
- **Substrate preflight** — a SessionStart banner names any missing tool (jq/sqlite3/git/node) and announces local-only operation (#545).

### Fixed

- **Worktree lifecycle** — worktree commands resolve to the main repo root so registered-repo guards fire inside worktrees (#550); the SubagentStop close hook resolves the worktree at the workspace root, ending an intermittent completion deadlock that stranded finished tasks at `pending` (#551); close hooks reset HEAD to the per-repo target branch (#559).
- **Offline / no-remote work** — remote-freshness checks skip when there is no origin remote or the upstream ref is absent, so local-only work is no longer blocked (#546).
- **Non-isolated SWE is first-class** — when no worktree is available, `no-source-edit` permits `swe`-role edits in the main checkout (bro and other identities still denied), and the deny message teaches the real recovery (#547).
- **Flaky prescan test** removed an ubuntu WAL/disk-IO race (#557); **L7 model verification** reads the per-line init model (#527); **L6 chain seeds** match live resume state (#536).

### Removed / Internal

- Removed `.claude/rules/` — Claude Code plugins don't recognize it (#543).
- `bump-version.sh` no longer edits `index.ts` (the server derives its version from `package.json` at runtime) (#571); test syncs for schema v12 and stale fixtures (#569, #573).

## v0.8.1 — 2026-06-12

Promotes `v0.8.1-rc.1` to stable. See the rc section below for the change list. Local L6 chain 13/13 on the tagged tree (the licensing gate per the new phased release workflow); release-gate CI green on the rc tag as re-confirmation.

## v0.8.1-rc.1 — 2026-06-12

Patch release carrying the #529 ensure-branch fix, the #537 embedding-await fix, and the upload-artifact v7 upgrade.

### Fixed

- **`task_create_batch` ensures branch exists** — resolves repos via `repos.path`, creates the task's branch from `parent_branch_id` (fallback HEAD) if absent, and fires a `tmb_branch_autocreated` audit event; closes the headless one-way trap behind gate run #94's L6 step-5 failure (GH #529, PR #530).
- **Embedding writes survive short-lived sessions** — `discussion_append` and `audit_log` now await `embedAndStore`, so one-shot/headless sessions can no longer lose `discussions_embeddings`/`audit_embeddings` rows to server shutdown; embed failures still degrade gracefully to FTS-only (GH #537, PR #538).

### Changed

- **`actions/upload-artifact` v5→v7** — last Node 20 action off the release gate; all CI actions now Node 24-compatible (#528).

## v0.8.0 — 2026-06-12

Promotes `v0.8.0-rc.1` to stable. See the rc section below for the full milestone rollup. Release gate green on the rc tag: L0 + L1–L4 + L6 chain 13/13 in a single run. First release under the merge-commit promotion policy.

## v0.8.0-rc.1 — 2026-06-11

The A- campaign release: every prompt surface (agents, skills, commands, CLAUDE.md) re-authored to the DETERMINISM grading bar, backed by composites, server features, and structural hardening across the full v0.8.0 milestone.

### Added — composites + server features

- **`intent_start` composite** — single transaction opening an issue + decision note; replaces the multi-step intent ceremony. Deterministic entry point for every code-touching ask.
- **`headless_fallback_record` composite** — one-shot sqlite3 fallback for MCP-unreachable sessions; writes the audit row + status flip atomically so bro can close a task even when the server is down.
- **`agent_resolve` tool (read-only)** — server-side Branch A/B/C resolution (new agent vs existing vs reserved conflict); bro keeps the single `Write` and the existing `agent_register` call, so file/DB consistency is never split across two steps.
- **`intent_start` wires `onboard` values + shape round** — the composite reads `plugin_config` for repo/branch defaults and validates the intent shape before writing; `onboard` round-trips those values correctly on first boot.
- **`discussion_search` defaults to current issue** when called without an `issue_id` — removes a class of wrong-issue cross-talk in long sessions.
- **Vote caps** — `roundtable_vote` rejects a second vote from the same participant; `roundtable_summarize` caps the returned discussion list to avoid context overrun.
- **Default-repo ranking** — `scan_run` resolves default repo as cwd-enclosing → largest-by-file-count → first-in-list; a `default_repo_guessed` audit event fires on heuristic fallback.
- **Retry repo override** — `task_retry_batch` accepts an explicit `repo` override so retried tasks can target a different worktree layout than the failed attempt.
- **Discussions cap** — `discussion_search` truncates results at a configurable ceiling so a pathologically large issue doesn't blow the context window.

### Added — enforcement + structural hardening

- **Role/location fences** — every agent (swe, pr-reviewer, consultant) now runs behind a `requireRoles` + `requireLocation` guard pair; the general-purpose subagent fix closes the gap where a plain CC subagent could call bro-only tools.
- **SWE scope fence** — `swe-boundary` PreToolUse hook blocks Edit/Write/Bash outside the assigned worktree path; slug-fallback handles renamed channels.
- **Brief/verification-gate hardening** — `swe-brief-gate` and `swe-verification-gate` fail loud on missing or malformed sentinel values instead of silently passing.
- **Consultant persistence gate** — consultant agent sessions are terminated after delivering their verdict; a PostToolUse hook prevents re-entry without a new `agent_resolve` call.
- **Bash-write tripwire** — PreToolUse hook detects Bash commands that write prompt-bearing files (agents/, skills/, CLAUDE.md) and blocks, routing the write through the Edit tool which triggers the prompt-surface fence.
- **WorktreeCreate contract conformance** — `worktree-create.sh` signals failure via non-zero exit (was silently exiting 0); the hook spec now matches the CC `WorktreeCreate` contract.
- **L6 resume git-tree fix** — `chain_setup_command` restores the exact git tree (not just HEAD) so resumed chains don't see dirty-worktree false positives.
- **Merge-commit promotion policy + restored main guards** — `git-guards` re-gates direct pushes to `main`; the merge-commit path (squash vs merge-commit) is now policy-enforced per branch type.

### Changed — prompt-surface A- campaign

- **Every agent/skill/command/CLAUDE.md re-authored** to the DETERMINISM grading bar: personas up front, judgment in prose, deterministic behavior moved behind gates, pointer-style hints for procedure. All surfaces independently graded A/A−.
- **`agent-create` command** trimmed 123 → 53 lines by extracting deterministic steps to the `swe-boundary` hook and the `agent_resolve` composite; the retained prose is pure judgment.
- **Agent-hook dispatcher** — the 7 intent-hint hooks (consultant, push, concerns, reonboard, resume, scan, roundtable) are collapsed into a single dispatcher script; 11 → 5 processes per prompt turn.

### Fixed

- **CodeQL hygiene** — shell arithmetic on user-controlled strings hardened; `grep -E` alternation literals escaped; `read` calls guarded with `IFS=` to prevent word-split injection. Closes all CodeQL medium-severity alerts introduced in v0.7.1.

## v0.7.1 — 2026-06-11

Promotes `v0.7.1-rc.1` to stable, plus the fixes the first Linux release-gate runs surfaced after the rc tag: bro-turn-usage digit-guard token sanitization and code-quality-lint bracket-class ERE literals + unescaped-backtick repair (#463–#465), and CI actions bumped to Node-24-ready majors (#466). See `v0.7.1-rc.1` below for the full milestone rollup (~80 issues, PRs #392–#459). Release gate green on the rc tag: L6 chain 13/13.

## v0.7.1-rc.1 — 2026-06-10

The full-repo audit release: the entire v0.7.1 milestone (~80 issues — a 50-issue audit, 18 pre-existing, plus everything the burn-down itself surfaced) resolved across PRs #392–#459. L6 chain 13/13.

### Fixed — headless enforcement repairs (the big ones)

- **`git-guards` was fail-open in every headless session.** All its rules emitted the legacy `permissionDecision: "block"`, which CC's hook schema rejects — the guard fired, emitted its deny, and was discarded (interactively the same error fails closed, masking this for months). Observed live: bro fast-forwarded a feature branch into protected `dev`. Now `deny` everywhere + a `valid-permission-decisions` lint so the value class can't regress.
- **All intent hints were dead in plugin-loaded sessions.** The hint dispatcher shipped mode 644; CC execs hook commands directly, so every hint class (consultant, push, concerns, reonboard, resume…) silently never fired under `--plugin-dir`. Now executable + a `hooks-executable` lint over every hooks.json command.
- **SWE spawn gate rejected `task_id: N`.** The parser accepted only the equals form; a semantically-correct spawn was denied and the task stranded. Separator-agnostic now, with a regression case.
- **`/onboard` headless path keeps Step 1** — the halt-reply cites the current shape instead of halting blind.
- **swe-verification-gate read the wrong sentinel off the default plugin name** (broke on renamed channels); **deferred-tools-drift-warn died on leading-zero clock components** (octal arithmetic); both fixed with tests.

### Added — enforcement tier

- SWE structural gates: deny-until-briefed (`swe-brief-gate`), spec-verification on completion (`swe-verification-gate`), push/remote/prompt-surface fences (`swe-boundary`), stay-on-base branch-creation guard, retry cap, spec-shape validation with waivers, reserved agent names, and six debt gates (test-layer placement, SQL interpolation, tool-description budget, dist freshness, symlink targets, hook executability).
- SQL hardening sweep: `tmb_sql_int` / `tmb_sql_quote` helpers across all hooks + a no-raw-interpolation lint; the quoted-slug injection case is now discriminating (protected-branch variant).

### Changed — prompts & doctrine

- Every agent/skill/command prompt rewritten to the grading doctrine (now codified in `docs/prompt-engineering/DETERMINISM.md`): personas up front, judgment in prose, deterministic behavior moved behind gates, pointer-style hints. All surfaces independently graded A/A−.
- Intent hints teach their required first action (reonboard: read state; concerns: record the `Concern:` note) instead of restating skill procedure.

### Performance

- `git-guards` per-Bash-call overhead 103ms → 17ms; `scan.sh` 24s → 0.5s; 7 intent-hint hooks merged into 1 dispatcher (11 → 5 processes per prompt); MCP tool descriptions −22%; world model self-prunes deleted paths.

### Test infrastructure

- L4 flows migrated to the `task_create_batch` object shape + spec-shape gate; aggregate-suite green-up (cross-test state pollution, tautological assertions); L6 chain fixtures expose unmerged task-branch files where rows need them (`chain_setup_command`); the bare test remote lives outside bro's project tree; conflict rows say "Don't invoke AskUserQuestion" (Human-authorized); L5/L6 harness header sanctions documented holds.


## v0.7.0 — 2026-06-07

Promotes `v0.7.0-rc.3` to stable. See `v0.7.0-rc.1`–`rc.3` + `v0.7.0-dev` for the cumulative changes from v0.6.0 — the **kuzu graph-DB world model** (ADR 0002, schema v8), the pre-release doc-accuracy sweep, and the #314 / #315 / #316 fixes.

## v0.7.0-rc.3 — 2026-06-07

### Fixed

- **`tmb_default_repo` no longer defaults to the alphabetically-first repo when CC runs above all repos (#316).** `scan_run` now resolves the default repo as cwd-enclosing → largest-by-file-count → first-in-list, and emits a `default_repo_guessed` audit when it falls back to the heuristic. Previously, launching from a workspace root above multiple repos silently picked the wrong repo — which, combined with auto issue-sync, created a real issue in the wrong repository. This is the actual root cause behind what rc.2's #314 note misattributed to a "phantom remote id".

## v0.7.0-rc.2 — 2026-06-07

### Fixed

- **issue-sync hardening (#314).** Auto-sync now parses the new issue number only from the created-issue URL (validated against the configured remote's host/repo), read-back-verifies the object is an issue (not a PR), and **skips entirely when the remote URL is unconfigured** — so a blank/misconfigured remote can no longer create issues in the wrong place. The create success path is now logged for traceability, and sync-test logs are isolated via `TMB_SYNC_LOG_DIR` instead of the operator's real `~/.claude/`. (The original mis-sync's root cause was the default-repo bug, fixed in rc.3 / #316.)
- **Worktree creation works when CC runs above the repo (#315).** `worktree-create.sh` resolves the owning repo as `tasks.repo` → `tmb_default_repo` → workspace root and fails loudly instead of silently deferring, so dispatching SWE no longer breaks in workspace layouts where the session CWD isn't itself a git repo.

### Docs / test infrastructure

- World-model docs + dogfood fixtures retired the last references to the dropped SQLite `directories` table and the pre-v7 `file_registry`; READMEs now describe the kuzu graph + RAG reality. New L1 lint `no-directories-table-refs.sh` guards against reintroduction; `no-file-registry-refs.sh` scope extended to READMEs + tests.

## v0.7.0-rc.1 — 2026-06-06

### Test infrastructure

- L5≡L6 parity: a single shared `seed-agents.sh` now feeds both the L5 roundtable row and the L6 step-11 `chain_setup_command`, so both suites convene the identical panel. New L1 lint `agent-task-brief-contract.sh` locks the shipped swe/pr-reviewer `task_brief` contract (#300) at the layer the dogfood can't see (subagent trajectories).

### Fixed — v0.7.0 ship-blockers

- **World model: every directory now carries a summary (#288).** Dirs without a README get a deterministic *structural* summary (immediate file + subdir names, `summary_source='structural'`) instead of `summary=NULL` — the whole map is now reachable by `world_model_search`, no more two-thirds-blind cold start.
- **`bro_atomic_close` mirrors the issue close to the remote (#277).** Closing the last task with `close_issue_if_last_task=true` now fires the same GitHub/GitLab close as `issue_close`, ending the local/remote drift where the issue stayed open upstream.
- **`task_update_status` enforces a state machine for bro (#278).** Illegal jumps (e.g. `pending→closed` skipping verification, `pending→completed` fabricating work) are rejected; reopening a task out of `completed` clears the stale `completed_at`.
- **Single worktree-creation path (#306).** bro no longer pre-creates the worktree by hand; `isolation='worktree'` + the `worktree-create.sh` hook is the sole creator (now also covers single-repo, and is idempotent), removing the double-create.
- **`@bro` activation no longer over-matches (#276).** Session/source-edit gates key on the explicit `@bro` sigil (or the "Entering bro mode." marker), so a casual mention of "bro" no longer flips a plain session into bro-mode forever.

## v0.7.0-dev — 2026-05-23

### Added — graph DB world model (ADR 0002)

Bro's project mental model moves out of the trajectory DB's `directories` SQLite table into a dedicated **kuzu** graph database at `<project>/.claude/<plugin>/world-model.kuzu/`. Sibling file to trajectory.db. Trajectory DB returns to its purpose-pure role: workflow audit only (issues / tasks / discussions / audit / validation / plugin metadata).

Schema v8 drops the SQLite `directories` / `directories_fts` / `directories_embeddings` tables. World-model data rebuilds from `/scan` on first boot under v8.

Initial graph schema: `Directory` node + `CONTAINS` edge. `File` / `Symbol` / `IMPORTS` / `CALLS` / `DEFINES` nodes + edges land post-v0.7.

`world_model_get(repo, path, depth)` queries kuzu and returns an annotated directory tree. `world_model_search(query, mode)` does substring search today; real FTS5 + bge-small vector indexes via kuzu extensions are post-v0.7.

### Added — dependency bundling

- `scripts/hooks/ensure-kuzu-installed.sh` (SessionStart) lazy-installs kuzu's native binary on first session after plugin install/update. Detects the bun no-postinstall foot-gun (binary present, root JS shim missing) and runs `node install.js` directly without a full reinstall. Bypass: `TMB_SKIP_KUZU_INSTALL=1`.
- `mcp/trajectory-server/package.json` declares `"trustedDependencies": ["kuzu"]` so bun honors kuzu's postinstall script when installing fresh.
- New L1 lint `tests/lint/kuzu-trusted-dep.sh` blocks regression by asserting `kuzu` is in `trustedDependencies` whenever it's a declared dep.

### Changed

- Architecture docs (`docs/architecture/WORLD_MODEL.md`, `ERD.md`, `FLOWS.md`, `RESPONSIBILITIES.md`, `REFERENCE.md`) lead with the kuzu substrate.
- `scan_run` writes Directory nodes + CONTAINS edges into kuzu (no more SQLite directories writes).
- L5/L6 dogfood row outcome SQL (rows 04 / 06 / 20 / 21 / 33) reframed for the new substrate; kuzu-state assertions move to the (TBD) L3 kuzu integration fixture.
- ADR 0002 supersedes ADR 0001 on the substrate question.

## v0.6.0 — 2026-05-15

Promotes `v0.6.0-rc.8` to stable. See `v0.6.0-rc.1` through `v0.6.0-rc.8` for the cumulative changes from v0.5.x — including the audit pass (12 MRs from !178 to !189), the pr-reviewer stack fix that closed a real push-gate bypass, channel-isolation sweep, and the bug-capture lint tier that catches each fixed pattern at lint-time.

L6 multi-turn integration: 12/13 passed (1 known-tracked test prompt brittleness on a single row, not a regression).

## v0.6.0-rc.8 — 2026-05-15

Pre-release audit pass — 9 audit-fix MRs (!178-!187) plus 1 ENUMS framing follow-up (!187), 1 pr-reviewer stack fix (!188 — closes a workflow violation where bro skipped the push gate), and 1 bug-capture lint sweep (!189) so each fixed pattern is now caught at L1 lint-time. Side-by-side `tmb` + `tmb-rc` installs no longer collide on logs/sentinels.

### Fixed

- 🐛 **TS MCP correctness (!181 / !2890).** 3 BLOCKERs + 5 MAJORs:
  - `issue_get_phase` returns new 5th phase `'ready_to_close'` when all tasks completed but issue is open (was misreporting `'blueprint'`).
  - `scope_gate_waived` audit INSERT now atomic with task INSERTs in the same `db.transaction()`.
  - `roundtable_summarize` 3 discussions queries fenced to current roundtable (`created_at` window).
  - `audit_log` `requireRoles(['bro','swe','pr-reviewer','consultant'])` guard.
  - `file_registry_delete` requires `repo`; `file_registry_verify` repo-filtered + per-repo verdicts.
  - `pr_comments` `JSON.parse` type-guarded; `commit_sha` lowercase-normalized; `console.warn` → `serverLog`.
  - Drops dead `genId()` export and the no-op `withAgentScope` middleware.

- 🐛 **Schema invariants (!180 / !2891).** `bro_atomic_close` now sets `closed_at` on auto-close; `remote_iid` UPDATEs bump `updated_at`. Adds `idx_audit_event_type` + `idx_audit_issue_branch` for the roundtable/scan/branch_report hot paths. Regression tests added.

- 🐛 **Channel isolation full sweep (!183 / !2896).** 8 hardcoded `'tmb'` plugin-name sites now use `resolvePluginName` (TS) and a new `scripts/lib/resolve-plugin-name.sh` helper sourced by 5 hooks. Sentinel filename incorporates `${PLUGIN_NAME}`; `heal-mcp-cache.sh` detects channels via `installed_plugins.json` scan + `--channel` flag. Side-by-side `tmb` + `tmb-rc` installs no longer collide.

- 🐛 **pr-reviewer stack — push gate + skill rewrites (!188 / !2899 + most of !2900).** Closes a workflow violation where bro could skip the pr-reviewer push gate:
  - `git-push-guard.sh` first-push fallback (universal `git push -u origin <new-branch>` case used to bypass the gate because no `@{u}` existed yet).
  - `tmb_planning` Step 5.5: mandates pr-reviewer spawn between `bro_atomic_close` and `git push`.
  - `tmb_review` §A per-SHA worktree mandate (reviewers were reading the parent's wrong-branch working tree); §B self-write mandate (reviewer writes `validation_attempts` directly via MCP or sqlite3 — never delegates to bro); §C bro spawn-prompt discipline (no prior verdict, no rubber-stamp shortcuts).
  - New `templates/project-seed/.claude/agents/pr-reviewer.md` with `mcpServers` frontmatter (project-local subagents support MCP; plugin subagents do not, per CC docs).
  - 13 new push-gate regression tests.

- 🐛 **Prompts broken refs (!185 / !2892).** `audit_log(...)` examples across 7 prompt files now pass required `from_node='bro'` arg (was crashing on first invocation). `tmb_planning` Step 2 example uses `author='bro'` (was `'human'`, failed `verified_human` gate). 6 MAJOR fixes: `tmb_owner: bro` added to 6 template agents; nonexistent `success_criteria` field removed from examples; invalid `since=<auto>` literal dropped; 3 broken doc/skill refs cleaned (`CODE_QUALITY.md`, `tmb_planning-simple/-difficult`, `tmb_code-quality`).

- 📝 **Docs drift (!184 / !2893).** 3 BLOCKERs on README + MCP server README first-impression surfaces. 14 MAJORs:
  - `REFERENCE.md` MCP tool list refreshed to 60 tools + hooks table to 39 entries (was "50+" / 19).
  - `ENUMS.md` schema_version corrected 1→2; nonexistent event_type renamed; broken anchor fixed; legacy `roundtables.status` block deleted.
  - `RESPONSIBILITIES.md` + `ENFORCEMENT.md` SWE frontmatter corrected (`maxTurns: 150`, no `isolation` field).
  - `audit_log(kind='event')` sweep across docs (the `kind` arg was dropped from the schema in rc.2).
  - `AGENTS.md` retired-skill ref + doctrine-banned commentary swept; `MULTI_PLATFORM.md` version refresh; `ERD.md` `plugin_version` mechanism documented.

- 📝 **ENUMS.md `deprecated` description (!187 / !2901).** Reworded the `skills.status` `deprecated` enum-value description to drop "back-compat" framing while preserving the value documentation (caught by the !184 strict pr-reviewer).

### Cleanup

- 🧹 **CI fossils + orphan helpers (!178 / !2894).** Deleted superseded `l5-l6-combined.yml` (referenced removed Dockerfile, would have red-flagged every release tag), the `l6-dogfood.yml` fossil after L6→L5 rename, and the unused `glab-retry-merge.sh` orphan helper + paired test.

- 🧹 **Test orphans + dist hygiene (!179 / !2895).** Deleted orphan `dist/test/audit-merge.test.js.map` and added a `prebuild` script (`rm -rf dist/test`) so it can't recur. Deleted 2 legacy l5-row fixtures with explicit retired/superseded READMEs. Moved `tests/dogfood/bench/` → `tests/manual/bench/` for a clean L0–L5-vs-manual tier model. Fixed `chain-manifest.json` count typo (12→13).

- 🧹 **Developer paths + timeout consts (!182 / !2897).** Replaced personal `/Users/Zax/...` paths in `docs/UPGRADE.md` and `tests/manual/mcp-health-hook.md` with `<placeholder>` forms. Extracted `SUBPROCESS_TIMEOUT_MS` (5000) and `AUTH_PROBE_TIMEOUT_MS` (1000) constants; adopted across 8 sites in `sync/backend.ts`, `sync/issue_sync.ts`, `tools/pr_comments.ts`, `tools/onboard.ts`.

- 🧹 **Doctrine cleanup in prompts (!186 / !2898).** Linter-driven: 35 negative-directive WARNs resolved (positive rewrites or `<!-- LOAD-BEARING-SAFETY: ... -->` annotations); 5 `(#NNNN)` citation sites swept; stale `no longer persisted` commentary rewritten to current-state framing.

### Tests

- 🧪 **Bug-capture lints for the 9 audit-fix MRs (!189 / !2902).** 7 new L1 lints, each capturing a specific bug pattern so future regressions are caught at lint-time rather than escaping to the next audit:
  - `no-audit-log-without-from-node.sh` — !2892 BLOCKER 1
  - `no-citations-in-prompts.sh` — !2898
  - `no-audit-log-kind.sh` — !2892 MINOR + !2893 cross-cut
  - `no-developer-paths.sh` — !2897
  - `stale-framing-prose.sh` — !2898 + !2901 (with backtick carve-out for enum value literals)
  - `no-hardcoded-plugin-name.sh` — !2896 channel-iso
  - `ci-workflow-refs-exist.sh` — !2894
  - Each ships with a violation fixture proving it catches the pattern; all wired into `tests/run-all.sh` L1 tier. The `no-developer-paths` lint immediately caught 2 paths the !188 design doc had inadvertently introduced into `tmb_review` — meta-validation that the lint works.

## v0.6.0-rc.7 — 2026-05-15

### Added

- 🩺 **`heal-mcp-cache.sh` Step A — clear per-project `disabledMcpServers` flags.** CC stores a per-project `disabledMcpServers` array under `.projects."<path>"` in `~/.claude.json`; when it contains `"plugin:tmb:trajectory-server"` the MCP server silently refuses to start in that one project even though it works fine elsewhere. The flag survives plugin re-enable, plugin updates, full CC restarts, and `rm -rf .claude/` — it's CC-owned state the plugin cannot reach from inside a session. Step A diagnoses every affected project, lists them in the dry-run preview, backs `~/.claude.json` up once, then removes only `"plugin:tmb:trajectory-server"` from each project's array (preserving every other disabled server and every other key in the project entry). This was the actual recovery path that resolved a real TMB-specific failure earlier today; the existing Step B (cache nuke + `installed_plugins.json` cleanup) wouldn't have touched it. Each step now has its own y/N prompt so users can take the lighter recovery (A only) and skip the more aggressive B.
- 🧪 **`tests/hooks/mcp-health-check.test.sh` — L3 hook test.** Covers the full Mode A / Mode B / healthy / unknown-event matrix that the rc.4 and rc.5 bugs slipped past:
  - healthy + SessionStart and healthy + UserPromptSubmit → silent stdout, JSONL `mcp_alive=true mode=null`
  - absent + SessionStart → stdout contains "NEVER STARTED", JSONL `mode="A"`
  - absent + UPS in the same session as an absent SessionStart → Mode A cross-fire, "NEVER STARTED" warning preserved
  - absent + UPS in a different session from a healthy SessionStart → Mode B "no longer reachable" warning
  - emitted JSON parses cleanly via `jq` and validates against CC's documented schema (`hookSpecificOutput.hookEventName` ∈ {`SessionStart`, `UserPromptSubmit`}, `additionalContext` is a string) — the assertion that would have caught the rc.4/rc.5 `"hookEventName": "unknown"` bug
  - unknown event name → guard fires, no JSON emitted, JSONL still records the event name verbatim
  - Uses a PATH-shadowed `pgrep` stub so test runs are isolated from any real trajectory-server processes on the developer's machine.

### Docs

- 📄 **`docs/UPGRADE.md` "Failure modes"** opens with a new section on the per-project `disabledMcpServers` flag — symptoms (one project broken, others healthy), the `jq` diagnose command, both recovery paths (heal script Step A or the manual one-liner), and a note that this is CC-owned state outside the plugin's reach. Tracks at #2888.

### Tightened

- ⚠️ **`heal-mcp-cache.sh` "running inside CC" guard** now names `~/.claude.json` explicitly in the warning, because Step A mutates a file CC reads on every prompt — mid-session edits can race with CC's writes.

## v0.6.0-rc.6 — 2026-05-15

### Fixed

- 🐛 **Root cause of "Hook JSON output validation failed — (root): Invalid input".** Found via direct inspection of CC's debug log. The hook was emitting `hookSpecificOutput.hookEventName: "unknown"` because the input parser used `.hookEventName` (camelCase) while CC actually sends `.hook_event_name` (snake_case). The jq fallback `// "unknown"` always fired, and CC's output schema rejects "unknown" as an invalid event name. This bug existed since the hook was first written but was masked by the pre-rc.4 output hardcoding `hookEventName: "UserPromptSubmit"`. My rc.4 change to mirror the parsed event surfaced it. **In practice, the loud Mode A warning never reached users in rc.4 or rc.5** — CC always rejected the output. Fixed by parsing `.hook_event_name // .hookEventName // .event // "unknown"` so CC's real input shape resolves first.
- 🐛 **Reverted the rc.5 SessionStart-silent block.** Based on a wrong reading of the docs (re-read `code.claude.com/docs/en/hooks` directly: SessionStart hooks DO accept `additionalContext` in `hookSpecificOutput`). The hook now emits the warning on both event types, mirroring the actual `hook_event_name` so CC's schema validates it. A guard skips emission when the event is unrecognized (avoids re-introducing the `"unknown"` rejection).

## v0.6.0-rc.5 — 2026-05-15

### Fixed

- 🐛 **rc.4 hot-fix: Mode A misclassification + hardcoded hookEventName.** Two bugs caught during post-rc.4 manual verification of the MCP-absent detection hook:
  - `mcp-health-check.sh` read `last_alive_at_session_start` via `jq -r '.last_alive_at_session_start // empty'`. jq's `//` operator treats `false` as falsy, so the literal boolean `false` (the state set when SessionStart sees MCP absent) returned an empty string and the string comparison fell through. The **load-bearing UserPromptSubmit-re-fire-in-same-session case** was misclassified as Mode B instead of Mode A — meaning the loud HALT message rc.4 was built to ship would never fire for the actual CC cache-bug scenario. Fixed by replacing `// empty` with `if has(...) then ... else "missing" end` so `false` reads as the literal string `"false"`.
  - `hookSpecificOutput.hookEventName` was hardcoded to `"UserPromptSubmit"` even on SessionStart fires. CC's hook contract expects this field to mirror the actual event; a mismatch could cause CC to silently drop the `additionalContext`. Fixed by passing the actual event via `--arg ev "$event"`.
- 📝 **Follow-up debt:** L1-L4 don't currently exercise `mcp-health-check.sh` end-to-end (no L3 hook test exists for it). Both bugs survived the green suite. Adding an L3 mode-classification test is deferred follow-up.

## v0.6.0-rc.4 — 2026-05-15

### Fixed (#2888 — CC plugin MCP-config cache bug, defense-in-depth)

- 🚨 **`mcp-health-check.sh` now distinguishes two MCP-absent failure modes** and emits a mode-specific `additionalContext` warning. Previously the hook fired the same "kill zombies + relaunch" message in both cases — useless for the cache-bug failure mode where relaunch demonstrably does not recover.
  - **Mode A — MCP never spawned this session.** Triggered when SessionStart fires with `mcp_alive=false`, or when a subsequent UserPromptSubmit in the same session keeps showing `mcp_alive=false`. The new warning identifies this as the CC cache bug, tells bro to HALT (not silently degrade), and lists the three-step recovery escalation: `claude --plugin-dir`, `/plugin uninstall` + reinstall, or manual cache nuke.
  - **Mode B — MCP died mid-session.** Triggered when UserPromptSubmit shows `mcp_alive=false` but the SessionStart record for the current session was `mcp_alive=true` (or the session_id changed). The existing kill-zombies + relaunch doctrine applies, with a clear note that if relaunch doesn't recover MCP the failure has escalated into Mode A.
  - Cross-fire state lives at `~/.claude/tmb/logs/mcp-health.state` (single JSON object, `{last_session_id, last_alive_at_session_start}`) — written on SessionStart, read on UserPromptSubmit. Session ID resolved from CC's hook input JSON or `CLAUDE_SESSION_ID` fallback.
  - JSONL log shape gains `mode` (`"A"` | `"B"` | `null`) and `session_id` fields. Existing `mcp_alive` / `pgrep_count` / `db_path` / `event` / `ts` unchanged.
- 🩺 **`scripts/maintenance/heal-mcp-cache.sh`** — interactive remediation helper for Mode A. Discovers the cache dir + installed_plugins.json entries that would be removed, prints a dry-run preview, prompts for confirmation, then nukes only the `trustmybot-rc` cache and the `tmb@trustmybot-rc` entry. Preserves every other installed plugin. Idempotent (a second run sees nothing to do and exits 0). BSD-sed compatible. NOT autorun from any hook — purely a user-invoked tool.
- 📄 **`skills/tmb_recovery/SKILL.md` § C** restructured to cover both failure modes. C.1 documents Mode A with the escalation order; C.2 keeps the existing degraded-mode read-fallback doctrine for Mode B and adds the cross-pointer ("if relaunch doesn't recover MCP, you're now in Mode A").
- 📄 **`docs/UPGRADE.md` "Failure modes"** gains a section covering the cache bug with symptoms (CC-log signature, mcp-health.log signature) and the same three-step recovery escalation.

### Reference

- Upstream Claude Code bug: issue #2888. CC's `clearPluginCache` only fires on `--plugin-dir inline plugins`, not on marketplace plugin lifecycle events (`/plugin disable`/enable, auto-update). We can't fix that from inside the plugin; this release is pure defense — loud detection plus a sharp recovery doctrine.

## v0.6.0-rc.3 — 2026-05-14

### Fixed

- 🛡️ **Migration backup now flushes WAL before copyFile.** The pre-v2 audit on eb1 (post rc.1→rc.2 upgrade) found an audit row in the live DB that was missing from the `.pre-v2.<ts>.bak` companion — the row was in the SQLite WAL at backup time, and `copyFileSync` captures only the main `.db` file. `backupDbBeforeMigration` now calls `PRAGMA wal_checkpoint(FULL)` on the live DB handle before `copyFileSync` so the backup captures all committed state, not just the checkpointed subset. Try/catch wraps the checkpoint — if a concurrent writer holds the lock, we degrade gracefully to a best-effort backup. New L2 case in `schema-upgrade.test.ts` seeds a WAL-mode DB, writes a row leaving the WAL uncheckpointed, triggers migration, and asserts the row is in the `.bak`.
- 🐛 **L5 trajectory capture silently failed.** `index.ts` wrote to a `debug_trajectory` table that only exists when `TMB_EVAL_MODE=1` (loaded from `schema-eval.sql`), but the writer was gated only on `TMB_DEBUG_TRAJECTORY=1`. Both flags now required together; comment clarifies the linkage.
- 🐛 **`post-read-summary-hint.sh` was missing the HOME-boundary guard** the other 5 hooks have. Walk-up could silently adopt a stale `~/.claude/tmb/trajectory.db`. Added the standard guard.
- 🐛 **`require-summaries-before-task-close.sh` hardcoded git-root DB lookup.** Failed silently in workspace-pattern projects (DB lives at workspace root above the inner repos). Replaced with the standard walk-up + HOME-guard pattern.

### Changed (docs honesty pass)

- 📄 **Dropped the false channel-isolation claim.** `docs/REFERENCE.md` + `docs/architecture/ERD.md` previously said "stable channel writes to `.claude/tmb/`, RC channel writes to `.claude/tmb-rc/`". False today — rc's `plugin.json.name` is still `"tmb"`, so both channels resolve to the same path. Replaced with the honest current state and a pointer at issue #1, where true isolation is tracked.
- 📄 **ERD.md schema_version baseline updated 1 → 2.** The migration framework target.
- 📄 **`tests/EVALUATION.md` now documents row 14** (`14-skill-invocation-recorded`) in the journey table; all "13 rows" / "12 steps" references bumped to 14 / 13.

### Removed (dead code + retired surfaces)

- 🗑️ **Vestigial `success_criteria` arg in `task_retry_batch`.** Read by the handler but never used; the task spec lives in `spec_body`. Removed from the inputSchema (`properties` + `required`) and from the handler.
- 🗑️ **`tasks.ts:561` `void genId('task')` no-op** + its now-unused `genId` import.
- 🗑️ **`scripts/hooks/diagnostic/probe-bash.sh`** — orphan from #14 debugging; never registered in `hooks.json`. Entire `diagnostic/` directory deleted.
- 🗑️ **`tests/workflow-sim/flow-M-monitor-cursor.test.mjs`** — never invoked by `run-all.sh`; coverage exists at L2 (`pr-comments.test.ts`) and L5 row 13.
- 🗑️ **`tests/lint/no-ledger-references.sh`** — post-#170 the `ledger_log` / `ledger_list` tools were merged into `audit`, making this lint structurally impossible to violate.
- 🗑️ **`scripts/lib/sqlite3-fallback.sh:tmb_fallback_issue_close`** lost its vestigial `[post_git_sha]` positional arg (no caller passed it; column was dropped in the pre-release schema scrub).

### Stale-ref sweep

- 🧹 **Full audit + sweep of references to retired surfaces.** Across docs, hooks, skills, tests:
  - Dead MCP tool names (`identity_get`, `identity_set`, `identity_reset`) replaced with current equivalents (`onboard_state_get`, `onboard_apply`) in: `commands/onboard.md`, `docs/architecture/RESPONSIBILITIES.md`, `tests/README.md`, `tests/manual/{setup,debug-mode-expand,scenarios,mcp-readonly-fallback}.md`, `tests/dogfood/flows/{01-first-contact,95-anonymous-cold-restart}/`.
  - `docs/AGENTS.md` — reframed `tmb_owner` as a frontmatter-only convention (column was dropped from the `agents` table; frontmatter still meaningful as file content).
  - `docs/contributing/ENUMS.md` — dropped the `agent_runs.exit_status` enum section (column gone).
  - `scripts/hooks/activation-routine.sh` — renamed `IDENTITY_ROW_COUNT` variable + comments to `ONBOARDED_ROW_COUNT` (SQL was already correct).
  - `scripts/scan.sh` — dropped emission of `default_branch` + `head_commit_sha` JSON fields (zero consumers in repo).
  - `tests/hooks/activation-routine.test.sh` — fixture no longer references `plugin_config.updated_at` (column dropped).
  - `mcp/trajectory-server/src/test/agent-scope.test.ts` — `requireRoles` tests use `task_create_batch` instead of the dead `identity_set` tool name.
  - 47 task-item literals across 6 L2 test files lost the `success_criteria` property (schema dropped it from `task_create_batch` input).
  - 8+ doc files: dropped "(replaced the retired …)" / "(legacy …)" / "#2876 / #2881 follow-up" historical commentary so the live docs are forward-facing (CHANGELOG keeps the history).
- 🐛 **Fixed `bro-sqlite-readonly.sh` runtime crash.** The MCP-unreachable fallback's `issue_resume` / `issue_get` selected columns dropped from `issues` (`parent_issue_id`, `post_commit_hash`, `current_task_id`) — would crash with "no such column" on every invocation. SQL rewritten to current columns only.
- 🐛 **Fixed `tmb_agent-creator` doctrine bug.** The skill instructed bro to call `agent_register(..., tmb_owner='bro')`, but the `tmb_owner` arg was dropped from the MCP tool schema (column dropped from the `agents` table). Stripped from all 3 call sites; clarifying sentence added that `tmb_owner` now lives only in the agent's `.md` frontmatter.
- 🐛 **Fixed `branch_report_md` dead-path crash.** The MCP tool selected `last_commit_sha` from `file_registry` — a column dropped from the schema. Tests passed because no test set `tasks.commit_sha`, so `commitShas.length > 0` was always false; in production the first task that closed with a real commit sha would have crashed the report with "no such column". The `## file_registry entries touched on this branch` section is dropped from the rendered markdown.

### Added (#2887 follow-up — schema discipline + upgrade tooling)

- 🛠️ **Reintroduced the trajectory DB migration layer.** v0.6.0 is the floor for schema discipline: `db.ts` carries a `TARGET_SCHEMA_VERSION` constant and a versioned migration chain that runs on boot before `applySchema`. Reverses the pre-release "no shim" stance — the shim was right for the rc cycle, but stable users need smooth upgrades from rc → 0.6.0 → 0.7.0. Behavior:
  - **Pre-migration backup** — when `plugin_meta.schema_version < TARGET`, the DB is copied to `<dbpath>.pre-v<TARGET>.<timestamp>.bak` before any migration step runs. One backup per target version.
  - **v1 → v2 migration** drops zombie tables (`identity`, `regen_state`, `project_metadata`), translates the legacy `identity` row to `plugin_config('onboarded': true)`, adds `skills.scope` if absent, and rebuilds `tasks` / `roundtables` / `roundtable_votes` / `file_registry` via the SQLite `CREATE _new` + copy + `DROP` + `RENAME` recipe when pre-v2 columns are present. `agent_runs.started_at` added if missing; `completed_at` rebuilt as nullable if it was previously NOT NULL.
  - **Downgrade protection** — refuses to open a DB whose `schema_version` is newer than the code's `TARGET`, with a clear error pointing at the backup file.
  - **L2 coverage** — `mcp/trajectory-server/src/test/schema-upgrade.test.ts` adds 5 cases: legacy pre-#2886 → v2, rc-current → v2, idempotent re-open (no second backup), WAL-state preservation, downgrade-protection throw.
- 📄 **`docs/UPGRADE.md`** — end-to-end upgrade guide covering plugin-file refresh, channel switches (stable ↔ rc), DB migration behavior, failure-mode diagnostics, and rollback via `.bak` restore. Maintainer section covers `/reload-plugins` requirement, rc→stable promotion ceremony, when/how to bump `TARGET_SCHEMA_VERSION`, and three test recipes for the migration end-to-end (`--plugin-dir` worktree, real marketplace, hand-crafted v1 DB).
- 🔧 **`scripts/maintenance/bump-version.sh`** — atomic version bump across the four sync'd version locations: `.claude-plugin/plugin.json`, `package.json`, `mcp/trajectory-server/package.json`, and the `serverLog('startup', version: …)` literal in `mcp/trajectory-server/src/index.ts`. Validates SemVer, stages to tempfiles, only commits if every file matches. Idempotent. BSD-sed compatible.
- 🧪 **L0 install-smoke A7 assertion** — seeds a minimal v1-shape DB in `/tmp`, boots the MCP server pointing at it, then asserts: `schema_version` bumped to 2, `onboarded` marker translated to `plugin_config`, `.bak` file written, post-upgrade `onboard_state_get` returns `first_run=false`. Catches end-to-end upgrade regressions under the same install layout users see.
- 🧪 **L0 install-smoke A3 + A3b assertions** updated — they referenced the removed `identity_get` tool and `human_name` response field. Replaced with `onboard_state_get` + `first_run`. Pattern tolerates MCP's JSON-escaped response wrapper (`grep -qE 'first_run[^a-zA-Z]'`).

## v0.6.0-rc.2 — 2026-05-13

### Added (#2886 — capability catalog + junction-based analytics)

- 📚 **Catalog enrichment**: the trajectory DB now carries a portable catalog of every capability (skills + rules + commands) plus per-invocation junction rows. Designed so the enterprise LangGraph runtime can adopt the same schema with the DB as source-of-truth, while in the plugin the catalog acts as an analytics overlay on top of the file system.
  - **`skills.scope`** column add (`global` / `template` / `project-local`, mirrors `agents.scope`). Plugin-shipped `tmb_*` skills schema-seeded as `global`; `skill_register` defaults new entries to `project-local`.
  - **`rules`** table (new) — first-class registry for `<project>/.claude/rules/*.md`. Severity enum captures enforcement weight (`advisory` / `warning` / `blocking`). MCP tools: `rule_register`, `rule_list`, `rule_record_invocation`, `rule_invocations_list`.
  - **`commands`** table (new) — first-class registry for slash commands. Schema-seeds the 4 plugin-shipped commands (`/scan`, `/onboard`, `/monitor`, `/roundtable`). MCP tools: `command_register`, `command_list`.
  - **`skill_invocations`** + **`rule_invocations`** junction tables — one row per skill/rule activation. Both indexed on the capability name AND on `task_id` for cheap forward queries ("what did this run touch?") and reverse queries ("which runs used skill X?"). MCP tools: `skill_record_invocation`, `skill_invocations_list`, `rule_record_invocation`, `rule_invocations_list`.
  - **Bro as a first-class `agent_runs` row** — composites now insert one `agent_type='bro'` row per task at `task_create_batch` / `task_retry_batch` time (with `started_at`, `completed_at NULL`) and finalize it at `bro_atomic_close` (sets `completed_at` + computes `duration_ms` from `started_at`). Lets skill/rule invocations from bro attribute to a tracked `agent_run_id`, closing the analytics loop. `agent_runs.completed_at` relaxed to nullable; new `started_at` column.
  - **Skill `PostToolUse` hook** (`scripts/hooks/skill-invocation-record.sh`) writes one `skill_invocations` row every time the `Skill` tool fires. Resolves `agent_run_id` from bro's open row (NULL if no run open — onboarding / scan-only sessions). Analytics-only, never blocks; bypass via `TMB_DISABLE_SKILL_INVOCATION_HOOK=1`.
  - **L5 row 14** (`14-skill-invocation-recorded`) — exercises the full Skill→hook→junction chain with assertions on `skill_invocations` count + schema shape. Wired into the L6 chain manifest as the final step.
  - **L2 unit coverage**: +17 tests in `rules-commands-junctions.test.ts` covering catalog registries, junction writes, bidirectional list filtering, and the bro-as-agent_run composite lifecycle. **401/401 pass** (was 384).

### Changed (breaking — pre-release schema slim)

- 🧹 **Schema cleanup — dropped dead columns + collapsed the migration layer.** Production-data audit (run against `eb1` and the dev fixture) showed ~25 columns across 14 tables that were either never written, never read, or constant-by-construction. Dropped them all in one pass. Pre-release means no migration shim — `db.ts` shed every `migrateXxx` helper (~250 lines), `schema.sql` is now the single source of truth applied via `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`. Users on rc bumps re-init `.claude/<plugin>/trajectory.db`.
  - **Workflow side:** `issues.{post_commit_hash, remote_synced_at}`, `tasks.{tools_required, skills_required, success_criteria}` (the spec lives in `spec_body`; `task_create_batch` no longer requires `success_criteria`), `audit.{kind, is_truncated}` (kind was CHECK-constrained to a single value), `discussions.verified_human` (the human-author gate stays at write time; the stored flag was never read), `roundtables.{status, ratification_received_at}` (status superseded by `state`), `roundtable_votes.agent` (legacy duplicate of `participant`).
  - **Registry side:** `skills.{tags, when_to_use, when_not_to_use, failures, created_by}`, `agents.tmb_owner`, `agent_runs.exit_status` (constant `'completed'` from the only writer), `repos.{default_branch, head_commit_sha, created_at, updated_at}`, `plugin_config.updated_at`, `plugin_meta.updated_at`, `eval_results.metadata_json`, `debug_trajectory.{tokens_in, tokens_out, latency_ms}` (eval-mode columns never populated).
  - **file_registry:** dropped the 8 derived-metadata columns (`language`, `size_bytes`, `last_commit_sha`, `last_change_type`, `last_change_at`, `imports_json`, `exports_json`, `metadata_json`) flagged all-NULL in production. Only `repo`, `path`, `type`, `content_md5`, `summary`, `summary_updated_at` remain.
  - **Renderers retired:** `mcp/trajectory-server/src/renderers/{changelog,codebase-tree,erd,module-graph,types}.ts` deleted along with their four test files — the scan-side renderer pass was inert and the columns it consumed are gone. Auto-rendered templates in `templates/docs-trustmybot/architecture/auto/*.md` remain as inert placeholders.
- ✨ **Wired the `/monitor` incremental-polling cursor.** `pr_review_runs` was redesigned to `(id, pr_number, repo, last_fetched_at, last_comment_id)` with a UNIQUE index on `(pr_number, repo)`. `pr_comments_get` now reads `last_fetched_at` from the prior row and passes it as the `since=` filter, then upserts the cursor on exit. Prior shape (`comments_processed`, `tasks_created`, `remote_kind`, `created_at`) was pure telemetry no consumer read. Net result: re-running `/monitor 42` fetches only new comments instead of re-paginating every time.
- 🪪 **Manifest-shape lint accepts SemVer pre-release tags.** `tests/lint/manifest-shape.sh` now matches `X.Y.Z` or `X.Y.Z-<pre>` (so `0.6.0-rc.1` validates).
- 🔧 **bro inputSchema slim.** `task_create_batch`'s task-item schema drops the (now-unwritten) `tools_required` / `skills_required` / `success_criteria` properties.

### Added (#2887 — schema migration framework + upgrade tooling)

- ⚠️ **Upgrade action required.** Schema discipline starts at v0.6.0. When CC delivers this version, **run `/reload-plugins`** in your CC session (or restart the session) so the new MCP server boots and applies the v1→v2 migration to your existing `trajectory.db`. A pre-migration backup is written to `<dbpath>.pre-v2.<timestamp>.bak` automatically. See `docs/UPGRADE.md` for the full ceremony + recovery instructions.

- 🛠️ **Reintroduced the trajectory DB migration layer.** v0.6.0 is now the floor for schema discipline: `db.ts` carries a `TARGET_SCHEMA_VERSION` constant and a versioned migration chain that runs on boot before `applySchema`. Reverses the pre-release "no shim" stance (line 21 above): the shim was right for the rc cycle, but stable users need smooth upgrades from rc → 0.6.0 → 0.7.0. Behavior:
  - **Pre-migration backup** — when `plugin_meta.schema_version < TARGET`, the DB is copied to `<dbpath>.pre-v<TARGET>.<timestamp>.bak` before any migration step runs. One backup per target version (existence-check prevents per-boot churn).
  - **v1 → v2 migration** drops zombie tables (`identity`, `regen_state`, `project_metadata`), adds `skills.scope` if absent, and rebuilds `tasks` / `roundtables` / `roundtable_votes` / `file_registry` via the SQLite `CREATE _new` + copy + `DROP` + `RENAME` recipe when pre-v2 columns are present. `agent_runs.started_at` added if missing; `completed_at` rebuilt as nullable if it was previously NOT NULL.
  - **Downgrade protection** — refuses to open a DB whose `schema_version` is newer than the code's `TARGET`, with a clear error pointing at the backup file.
  - **L2 coverage** — `mcp/trajectory-server/src/test/schema-upgrade.test.ts` adds 4 cases: legacy pre-#2886 → v2, rc-current → v2, idempotent re-open (no second backup), downgrade-protection throw. **406/406 pass** (was 401).

- 📄 **`docs/UPGRADE.md`** — end-to-end upgrade guide covering plugin-file refresh, channel switches (stable ↔ rc), DB migration behavior, failure-mode diagnostics, and rollback via `.bak` restore. Maintainer section documents the rc→stable promotion ceremony + when/how to bump `TARGET_SCHEMA_VERSION`.

- 🔧 **`scripts/maintenance/bump-version.sh`** — atomic version bump across the four sync'd version locations: `.claude-plugin/plugin.json`, `package.json`, `mcp/trajectory-server/package.json`, and the `serverLog('startup', version: …)` literal in `mcp/trajectory-server/src/index.ts`. Validates SemVer, stages to tempfiles, only commits if every file matches. Re-running with the same version is a no-op.

### Fixed (#2887 follow-up — stale-ref sweep)

- 🐛 **`branch_report_md` dead-path crash.** `tools/branch_report_md.ts` was selecting `last_commit_sha` from `file_registry` — a column dropped from the schema. Tests passed because no test set `tasks.commit_sha`, so `commitShas.length > 0` was always false. In production, the first task that closed with a real commit sha would have crashed the report with `no such column: last_commit_sha`. The `## file_registry entries touched on this branch` section is dropped from the rendered markdown (the column was its only sensible scoping mechanism; a flat repo-scoped list would have been noise). New regression test exercises `tasks.commit_sha` populated.
- 🧹 **Stale field names** in `scan_run` + `file_registry_bulk_upsert` MCP tool descriptions and the `commands` seed for `/scan` (`size_bytes`, `last_commit_sha`) scrubbed. No runtime impact — handlers already ignored them — but the descriptions misled callers.
- 🧹 **Vestigial migration comment** in `tools/onboard.ts` updated to point at the new v1→v2 migration step that actually drops the legacy `identity` table.

## v0.6.0-rc.1 — 2026-05-12

### Changed

- 🧹 **Total scrub of the retired arch-refresh surface** following the standalone-tool → `scan_run` consolidation (#2881). Deleted two dead hooks (one read a dropped legacy drift-cache table; the other checked for an audit event no longer written) and their `hooks/hooks.json` registrations. Deleted the dead arch-walker directory under `mcp/trajectory-server/src/` (no importers). Dropped the unused drift-cache trigger field from `scan_run` return + the `deep_scan_completed` audit `content_json`. Deleted the legacy drift-cache type and migration entirely (pre-release; no released DBs need the drop). Renderer headers (`changelog/codebase-tree/erd/module-graph`) switched to `<!-- Auto-rendered YYYY-MM-DD. Do not edit. -->`. Templates under `templates/docs-trustmybot/architecture/auto/` simplified to "currently inert" placeholders. Retired the architecture-refresh-complete audit event_type (replaced by `deep_scan_completed`). CLAUDE.md routing now points "refresh arch" at `scan_run(source='user_manual')`. Docs / skills / tests across the repo scrubbed for retired-tool mentions. Audit-merge legacy fixture no longer recreates the dropped drift-cache table.
- 🔢 **Production `issues.id` now starts at 1.** The schema-seeded system sentinel issue moved from `id=999999` to `id=-1` (negative sentinel — SQLite AUTOINCREMENT picks `MAX(MAX(id), 0) + 1`, so the first user-created issue gets `id=1`). Fresh `tmb` installs see clean 1, 2, 3… numbering instead of starting at 1000000. All FK references and hook filters (scan.ts, activation-routine.sh, roundtable-slash-detect.sh, harness/fixtures/L5 outcome SQL, ERD.md, tmb_recovery skill) updated to the new sentinel.
- ♻️ **Retired the simple/difficult triage.** The triage gate and decision-when-difficult gate in `mcp/trajectory-server/src/tools/tasks.ts` are replaced by a single universal **decision gate**: every `task_create_batch` requires ≥1 `kind='decision'` discussion on the issue. The `Triage:` note + `simple|difficult` classifier are gone. ADR authoring + blast-radius check now trigger on architectural intent (file patterns + keyword heuristics in the new `scripts/hooks/adr-required-hint.sh` UserPromptSubmit hook), not on a user-classified label. Q+A deliberation is delegated to Claude Code's native plan mode (Shift+Tab). `composites.ts:branch_id_propose` no longer returns a `triage` field. `waive_triage_gate` → `waive_decision_gate`. L5 row `08-difficult-path` renamed to `08-architectural-change`; outcome.sql asserts the universal decision row + a tasks row, no `Triage:` requirement.
- 🚚 Skill→determinism migration phase 1 (#181): 5 skills deleted (`tmb_naming-conventions`, `tmb_git-conventions`, `tmb_create-hook`, `tmb_lazy-arch-check`, `tmb_roundtable-cleanup`); 9 skills shrunk to judgment-only (`tmb_swe-checklist`, `tmb_review-protocol`, `tmb_refresh-architecture`, `tmb_branch-id-proposal`, `tmb_pr-review-handler`, `tmb_push-gate`, `tmb_swe-spawn-workflow`, `tmb_feedback-loop`, `tmb_project-prescan`); 2 skills shrunk to qualitative criteria (`tmb_code-quality`, `tmb_docs-conventions`).
- 🔖 Polish ledger→audit prose in 5 skills + extend lint to flag bare ledger word (#171)
- ♻️ Split eval_results + debug_trajectory out of prod schema.sql; load via TMB_EVAL_MODE=1 (#163)
- 🧪 L5 dogfood scorers updated post-#170 audit merge; add coverage for skills + roundtable_votes table writes (#159, #160)

### Added

- **Determinism layer expansion (#181):** 8 new hooks + 3 new MCP composites absorb the deterministic content the deleted/shrunk skills used to carry.
  - PreToolUse lints: `naming-lint.sh` (Edit/Write — file naming per language), `commit-msg-lint.sh` (Bash — Conventional Commits + emoji), `code-quality-lint.sh` (Edit/Write — bare except, mutable defaults, f-string SQL, etc.).
  - PreToolUse gate: `greenfield-arch-required.sh` blocks `task_create_batch` when no `docs/trustmybot/` and no prior architecture-refresh audit.
  - UserPromptSubmit hint: `consultant-spawn-required.sh` injects advisory `additionalContext` on domain-expert keywords (security, perf, legal, architecture).
  - SessionStart inventory: `session-start-prescan.sh` injects the deterministic project inventory (git state, stacks, registry warmth, open issues) so bro doesn't re-derive it on the first ask.
  - PostToolUse: `lazy-arch-postcheck.sh` (file_registry_update_summaries — drift warn), `roundtable-cleanup-postcheck.sh` (roundtable_close — capture-surface verification).
  - MCP composites (`mcp/.../tools/composites.ts`): `branch_id_propose(intent, objective?)` (heuristic mapping → conventional branch_id + triage), `task_retry_batch(failed_task_id, …)` (one transaction for retry rationale + new task + audit), `bro_atomic_close(task_id, sha, summaries, …)` (one transaction for V3 audit + summaries + status flip + optional issue close — eliminates the L5 close-step drift failure mode).

- **Enforcement:** New PreToolUse hook `require-feature-branch-active.sh` blocks SWE spawn when the main checkout is not on the task's `branch_id`. New MCP gate in `task_create_batch` requires a prior `branch_id_proposed` ledger event. `tmb_branch-id-proposal` skill now runs `git switch -c` itself instead of only logging intent. (#155)

- **Doctrine:** Positive-prompt enforcement integrated into `tmb_skill-creator`, `tmb_agent-creator`, and `tmb_review-findings`. New L1 lint `no-negative-directives.sh` scans skills + agents + CLAUDE.md. Audit pass converted 12 negations to positive directives; 10 load-bearing safety rules retained with inline justification. (#148, GL#21)

- **Roundtable MCP tools — deterministic state machine (#141):** `roundtable_create`, `roundtable_vote`, `roundtable_close`, `roundtable_finalize_decisions`, `roundtable_summarize`. Server auto-flips `roundtables.state` from `collecting → awaiting_human` when all expected votes are in. AUQ shape validated by new `roundtable-auq-shape.sh` PreToolUse hook. New columns: `roundtables.state`, `roundtables.expected_participants`, `roundtables.ratification_received_at`, `roundtable_votes.participant`.

- **Roundtable MCP tools — initial 3 tools (#24 / TRU-63):** `roundtable_create`, `roundtable_vote`, `roundtable_close` (state-machine-free predecessors, superseded by #141).

- **PR comments fetching (#142):** `pr_comments_get` tool (gh + glab backends; bot detection via DEFAULT_BOT_PATTERNS). New `pr_review_runs` table tracks per-PR fetch state. New skill `tmb_pr-review-handler` drives the `/monitor` slash command flow.

- **Issue sync retry (#132):** `issue_sync_retry` tool for retrying failed remote syncs. New columns: `issues.remote_iid`, `issues.remote_kind`, `issues.remote_synced_at`. New log: `~/.claude/tmb/logs/issue-sync.log`.

- **Issue sync kill-switch (#146):** `issue_sync` config key (values: `gh|glab|both|off|auto`; safe default `off`). `TMB_DISABLE_REMOTE_SYNC=1` env var overrides config at the handler level (defense-in-depth). Bro no longer syncs issues to any remote without explicit opt-in.

- **Validation gate — pr-reviewer session tracking (#144):** `validation_record` now requires `subagent_session_id` when `agent='pr-reviewer'`. New column: `validation_attempts.subagent_session_id`. MCP tool handler rejects missing `subagent_session_id` for pr-reviewer role.

- **Discussion gate — Human author verification (#145):** `discussion_append(author='human')` requires `verified_human=true`. New column: `discussions.verified_human` (DEFAULT 0). Guards against agents impersonating the Human in discussion history.

- **Slash commands (#143):** `/roundtable <topic>` and `/monitor <PR_number>` ship as explicit-trigger commands in `commands/`. Catalog at `docs/commands/README.md`.

- **New L5 flow — 13-bulk-cleanup (#99):** Proves bro executes pre-authorized bulk deletes via single Bash call without AskUserQuestion or SWE spawn.

- **Workflow-violation tracking (#144, #145, #146, #147):** Bro logs workflow violations to ledger when agents attempt forbidden operations. Basis for future Layer 2 enforcement.

- **Doctrine — pre-authorized destructive cleanup (#99):** CLAUDE.md `## Pre-authorized destructive cleanup` section. When the Human's prompt contains explicit authorization for bulk deletion, bro executes in one Bash call — no per-step re-confirmation, no SWE spawn.

- **Doctrine — V1/V2/V3 verification (#121-02):** CLAUDE.md `## Bro verification (task gate)` formalizes the three-step gate (V1: files match, V2: verification commands pass, V3: success criteria met) as non-negotiable before closing any task.

- **Doctrine — positive-prompt + LOAD-BEARING-SAFETY annotation (#148):** All remaining negative directives in agent prompts and skills converted to positive alternatives. Load-bearing safety rules kept with explicit `<!-- LOAD-BEARING-SAFETY: reason -->` annotation. New ENFORCEMENT.md section.

- **Doctrine — blast-radius review checklist (#147):** `tmb_planning-difficult` updated with blast-radius review step before SWE spawn for high-risk changes.

- **Doctrine — onboarding sync opt-in (#147):** `tmb_reonboard` updated to present `issue_sync` config option during re-onboarding.

### Fixed

- 🐛 lazy-arch-check skips nudge for hand-curated arch projects (#162)

- 🐛 Drop stale git-worktree literal check from local-agent-primitives lint (#169)

- 🐛 (mcp): `plugin_meta` seed no longer re-inserts on every MCP boot; one-time migration collapses any pre-existing duplicates to a single `id=1` row. (GL #23)

- **Removed:** `scripts/hooks/create-worktree.sh` (#4 / TRU-80) — redundant since SWE explicitly creates its own task-branch worktree per #170/#171. Eliminates the orphan-worktree side effect (one stray `.claude/worktrees/agent-*` per SWE spawn).

## v0.5.0 — 2026-04-27

**Headline: bro is now a structurally-enforced pure planner.** Direct Mode removed (#162) and 7 hard-enforcement hooks promote previously prompt-only doctrine to Layer 2 (deterministic shell scripts). New `docs/architecture/ENFORCEMENT.md` documents the 6-layer model (MCP middleware → hooks → frontmatter → tool-handler validation → skill `paths:` → prompts) and the per-agent × per-interaction coverage matrix.

### Fixed — file_registry summary ownership: bro, not SWE (#181)

The original #45 doctrine had SWE batching `file_registry_update_summaries` into its atomic close. **That was the wrong agent**: SWE only sees the task spec, not the broader issue/discussion that motivated the work. Bro has full task context (issue + spec + diff just verified during the V1/V2/V3 task gate) and is the natural author of summaries. Re-assigned ownership structurally:

- **`agents/swe.md`** — drops `file_registry_update_summaries` from the atomic-close batch. SWE's atomic close is now 2 calls: commit + `task_update_status(completed)`.
- **`skills/tmb_planning-simple/SKILL.md` + `tmb_planning-difficult/SKILL.md`** — bro's V3 close batch grows by one call: `file_registry_update_summaries(updates=[...], advance_verified_sha=<commit>)` BEFORE `task_update_status(closed)`.
- **`mcp/trajectory-server/src/tools/file-registry.ts`** — `requireRoles('file_registry_update_summaries', ['bro'])` (was `['bro', 'swe']`). Layer 1 — server rejects SWE callers.
- **`scripts/hooks/require-summaries-before-task-close.sh`** (NEW PreToolUse hook) — when bro tries `task_update_status(status='closed')`, walks the commit's touched files and DENIES the close if `file_registry` is missing summaries or has summaries older than the task's `created_at`. Bypass: `TMB_ALLOW_CLOSE_WITHOUT_SUMMARIES=1`. Layer 2 — bro can't close the task without doing the summary update first.

Re-tightened L5 outcome assertions in `02-simple-task` and `11-codebase-memory-verify-on-drift` since the structural enforcement now guarantees fresh summaries on every closed task. `10-codebase-memory-cold-start`'s assertion stays disabled — that's `headless_fallback` ledger event compliance, a separate bro prompt-discipline issue requiring its own enforcement (filed as a separate follow-up).

### Added — `docs/architecture/RESPONSIBILITIES.md`

Codebase-derived (not architecture-doc-derived) listing of what bro / SWE / pr-reviewer / consultants are **actually** instructed to do — by reading the agent prompts, the skills they wire to, and the hook surface around them. Includes the role × tool matrix from `requireRoles`. Source of truth for what the plugin enforces vs what doctrine merely suggests.

### Fixed (post-rc.1)

- **`no-source-edit-from-main.sh` + `activation-routine.sh` bro-mode detection too narrow.** Previously required the assistant to emit `Entering bro mode.` in the transcript — but in `claude -p` headless mode bro routinely skips that announcement (the h3/h4 prompt-discipline ceiling). Hooks now also detect bro mode by scanning the transcript for any user message containing the `bro` trigger word. Without this fix, bro shortcut source edits in 3 of 5 v0.5.0-rc.1 L5 dogfood flows. Adds regression test cases for both hooks covering the real-world fixture instead of just the announce-emitted variant.
- **`TMB_CLAUDE_TIMEOUT=600` wired into `l5-dogfood.yml` + `release-canary.Dockerfile`.** The env override was added in #172 but missed both L5-runner workflows; runs hit the default 180s cap mid-SWE chain.
- **Stale `tools-required.json` for cold-start + code-touching flows.** Cleared assertion lists for `01-first-contact`, `02-simple-task`, `10-codebase-memory-cold-start`, `11-codebase-memory-verify-on-drift`, `12-source-edit-attempt`, `95-anonymous-cold-restart`. These asserted on MCP tool calls captured in `debug_trajectory` — but the table isn't populated because of #164 (env propagation bug + UNIQUE merge bug). Once #179 (stream-json refactor) lands, the trajectory scoring is re-implemented end-to-end and these lists get re-populated against the new capture format.
- **Disabled chronic #45 codebase-memory outcome assertions.** `02-simple-task`, `10-codebase-memory-cold-start`, `11-codebase-memory-verify-on-drift` had assertions on `file_registry`'s `content_md5` / `summary` / `last_verified_sha` columns that depend on SWE/bro reliably calling `file_registry_update_summaries` — a prompt-only doctrine that hits the same h3/h4 ceiling. Tracked in #181 as a deferred Layer 2 PostToolUse hook. Original assertions kept commented-out for restoration once #181 ships.

### Breaking changes (pre-1.0 minor bump per SemVer)

- **Direct Mode is gone.** Bro never edits source code; every code change routes through SWE. Trivial fixes go via the same chain (lighter spec, not a separate code path). Pushes that previously relied on bro-direct edits will fail; rewrite as task → SWE → bro verify → close.
- **All plugin-shipped skills now use `tmb_*` prefix.** The 7 un-prefixed defaults (`code-quality`, `docs-conventions`, `git-conventions`, `naming-conventions`, `review-findings`, `review-protocol`, `swe-checklist`) are renamed to `tmb_*`. Project-local skills with un-prefixed names are unaffected; local skills can shadow plugin defaults by name resolution as before.

### New hard-enforcement hooks

The h3 + h4 A/B scenarios proved prompt-only doctrine compliance is 0/10 in both wording arms for high-frequency operations. These 7 hooks move load-bearing rules to deterministic Layer 2:

| Hook | Event | Doctrine enforced |
|---|---|---|
| `activation-routine.sh` | UserPromptSubmit | Pre-fetches `identity` + pending issue from the trajectory DB on every bro-triggered message; injects as `additionalContext` so bro never has to remember to call `identity_get` / `issue_resume` |
| `no-source-edit-from-main.sh` | PreToolUse on Edit/Write/MultiEdit/NotebookEdit | Blocks bro from editing source files outside an SWE worktree (allowlist: markdown, LICENSE, agent/skill prompts, plugin/hooks manifests, `.github/`). Bypass: `TMB_ALLOW_SOURCE_EDIT=1` |
| `session-start-arch-check.sh` | SessionStart | Computes git drift vs the legacy arch-cache last-seen SHA; nudges bro to run `tmb_refresh-architecture` when drift > 25 commits (override: `TMB_ARCH_DRIFT_THRESHOLD`) |
| `ensure-gitignore.sh` | SessionStart | Ensures `.claude/` is in the project's `.gitignore`. Creates `.gitignore` if missing; appends if rule absent; idempotent. Prevents the trajectory.db-leaking-into-worktrees footgun |
| `no-worktree-branch-create.sh` | PreToolUse on Bash | Blocks `git worktree add -b/-B/--create-branch ...`. Branch authority is bro's: bro pre-creates `<task.branch_id>` from the latest origin, SWE attaches via `git worktree add <path> <branch>` (no creation, no abbreviation). Bypass: `TMB_ALLOW_WORKTREE_BRANCH_CREATE=1` |
| `branch-up-to-date-with-remote.sh` | PreToolUse on Bash | Fetches `origin/<pr_target>`, denies worktree-add if `<branch>` is behind. Catches the stale-local-main bug. Bypass: `TMB_ALLOW_STALE_BRANCH=1` |
| `cleanup-worktree-on-task-close.sh` | PostToolUse on `task_update_status` | When bro flips task to `closed`, removes the corresponding `.claude/worktrees/<slug>/`. Commits live on the branch and survive. Bypass: `TMB_KEEP_CLOSED_WORKTREES=1` |

Plus structural improvements: `tmb_db_path` walks up to git root for DB resolution (was `$(pwd)`-relative — broke when bro `cd`'d into a worktree), `TMB_CLAUDE_TIMEOUT` env override for L5/A/B test runners, and `tests/dogfood/lib/flow-helpers.sh:l5_setup_scratch_project` writes `.gitignore` matching real-project behavior.

### Other shipping in v0.5.0

- **A/B framework matures (#131, #157, #160, #161):** runner + helpers + chi-squared stats; 4 backfill hypothesis scenarios (h1 CLAUDE.md slim, h2 Hybrid D' vs lazy, h4 first-action MANDATORY); shared substrate-health pre-flight (#161); `node_modules` symlinking + scenario fixture/setup_files framework fix.
- **Activation routine hook proven necessary:** h4 A/B (5 paired runs × 2 wording arms) showed prompt-only `identity_get + issue_resume` compliance was 0/10 in both arms — the hook delivers 100% reliability.
- **L6 → L5 helper namespace cleanup (#163):** `l6_*` shell functions in `tests/dogfood/lib/` renamed to `l5_*` to match the renamed test layer.
- **GH Actions bumped to v5 (#165):** Node 24 internal runtime; CC-auth prefix check dropped (smoke test is the authoritative gate).
- **Two CLAUDE.md cleanups (#168, #169):** verify-context decision tree → 2-column table; opaque issue refs dropped.

### Added — 4 hard-enforcement hooks (branch authority + worktree hygiene) (#170, #171)

Local h5 dogfood surfaced two doctrine bugs that were prompt-only and unreliable. Promoted both to Layer 2:

- **`scripts/hooks/ensure-gitignore.sh`** (SessionStart). Ensures the project's `.gitignore` excludes `.claude/`. Creates the file if missing; appends if the rule is absent; idempotent. Without this, the trajectory.db gets committed to the project, then `git worktree add` checks it out inside every worktree — a stale per-worktree DB poisons every hook that resolves DB path via `$(pwd)`. Fixes the root cause behind #171.
- **`scripts/hooks/no-worktree-branch-create.sh`** (PreToolUse on `Bash`). Blocks `git worktree add -b/-B/--create-branch ...`. Branch authority belongs to bro: bro creates `<task.branch_id>` first (`git branch <name> origin/<pr_target>`), then SWE attaches via `git worktree add <path> <branch>` — no creation, no abbreviation. Fixes #170 where SWE invented `fix/typo-foo-ts` for spec `fix/foo-typo-receive`. Bypass: `TMB_ALLOW_WORKTREE_BRANCH_CREATE=1`.
- **`scripts/hooks/branch-up-to-date-with-remote.sh`** (PreToolUse on `Bash`). When SWE attaches a worktree to `<branch>`, fetches `origin/<pr_target>` (best-effort, offline-friendly) and verifies `<branch>` descends from it. Catches the "stale local main" bug where bro creates a task branch from yesterday's pointer, then the SWE commit conflicts on push. Bypass: `TMB_ALLOW_STALE_BRANCH=1`.
- **`scripts/hooks/cleanup-worktree-on-task-close.sh`** (PostToolUse on `mcp__*trajectory-server__task_update_status`). When bro flips a task to `closed`, removes the corresponding `.claude/worktrees/<slug>/` (the commits live on the branch and survive). Keeps the worktree dir tidy and prevents disk bloat over many tasks. Bypass: `TMB_KEEP_CLOSED_WORKTREES=1`.

Also:
- `tmb_db_path` (in `scripts/hooks/lib/query-task.sh`) now walks up to git root for DB resolution — was falling back to `$(pwd)/.claude/tmb/trajectory.db` which broke every hook when bro `cd`'d into a worktree (#171 part 2).
- `tests/dogfood/lib/flow-helpers.sh:l5_setup_scratch_project` writes `.gitignore` containing `.claude/` before the initial commit (test-framework parity with the new SessionStart hook's behavior in real projects).
- `TMB_CLAUDE_TIMEOUT` env var (default 180s) now overrides the per-call timeout in both `l5_run_claude` (L5 dogfood) and `l5_run_arm` (A/B). Lets local + CI runs cap at higher values when the chain genuinely needs longer than the default.
- `agents/swe.md` and `skills/tmb_swe-spawn-workflow/SKILL.md` updated: SWE drops `-B` from `git worktree add` (uses pre-existing branch); bro fetches origin + ff-merges `pr_target` before creating the task branch.

### Added — two more hard-enforcement hooks + ENFORCEMENT.md (#108)

Per the doctrine "prompt-only enforcement caps at the LLM compliance ceiling — promote load-bearing rules to a harder layer," two new hooks land:

- **`scripts/hooks/no-source-edit-from-main.sh`** (PreToolUse on `Edit|Write|MultiEdit|NotebookEdit`). Blocks the call when bro mode is active *and* the target is source code *and* the current shell isn't inside an SWE worktree. Allowlist covers markdown, `LICENSE`, `.gitignore`-class configs, agent/skill prompts, plugin/hooks manifests, `.github/`. Bypass via `TMB_ALLOW_SOURCE_EDIT=1` for emergencies. Enforces the "bro is a pure planner — every code change goes through SWE" rule that until now was prompt-only.
- **`scripts/hooks/session-start-arch-check.sh`** (SessionStart). Reads the legacy arch-cache last-seen SHA, computes drift to `HEAD`, and emits `additionalContext` suggesting `tmb_refresh-architecture` when drift exceeds the threshold (default 25 commits, override via `TMB_ARCH_DRIFT_THRESHOLD`). Pre-empts the manual lazy arch-check bro is supposed to do at the start of every code-touching ask.

New doc: **`docs/architecture/ENFORCEMENT.md`** — canonical reference for the 6 enforcement layers (MCP middleware → hooks → frontmatter → tool-handler validation → skill `paths:` auto-load → prompts) plus a per-agent × per-interaction coverage matrix showing which layer covers what. Includes a section listing remaining Layer-6-only doctrine items as promotion candidates.

### Refactored — all plugin-shipped skills now use `tmb_` prefix

The 7 default workflow skills (`code-quality`, `docs-conventions`, `git-conventions`, `naming-conventions`, `review-findings`, `review-protocol`, `swe-checklist`) were the only plugin-shipped skills without the `tmb_` namespace prefix — an inconsistency with the rule "global plugin skills use `tmb_`; the open namespace is reserved for user/`tmb_skill-creator`-generated project-local skills." Renamed to `tmb_code-quality`, `tmb_docs-conventions`, …

**Why it matters**: collision-free open namespace. Previously, if a user asked bro to create a `git-conventions` skill, it could collide with the plugin default. Now the open namespace is exclusively user-owned and the plugin-shipped namespace is fully claimed by `tmb_*`.

**Override semantics unchanged**: a project-local `<project>/.claude/skills/tmb_git-conventions/SKILL.md` still shadows the plugin's by name resolution. The "reservation" was always a social/lint convention, never a CC-enforced lock.

**Refs updated**: `agents/swe.md`, `docs/AGENTS.md`, `docs/architecture/FILES.md`, `docs/architecture/FLOWS.md`, and 6 cross-referencing SKILL.md files. `CHANGELOG.md` history entries left intact (accurate records of the un-prefixed era).

### Added — activation-routine UserPromptSubmit hook (#108)

Bro's activation routine (`identity_get` + `issue_resume` on every triggered message) is now fired deterministically by `scripts/hooks/activation-routine.sh` instead of relying on prompt discipline. The h4 A/B (5 paired runs × 2 wording arms) showed prompt compliance was 0/10 in *both* arms — the strongest possible imperative ("MANDATORY on every triggered message") still didn't move the needle. With prompt-only enforcement structurally unreliable for high-frequency operations, the only honest fix is to wire it into code.

**The hook**:
- Triggers on `UserPromptSubmit` when bro mode is active (current prompt contains `bro` case-insensitively, OR transcript shows a prior `Entering bro mode.` line with no later `exit bro mode`).
- Reads `identity.human_name` + the latest open `issues` row from the trajectory DB (no MCP roundtrip — direct sqlite3 read).
- Emits `additionalContext` JSON for CC's UserPromptSubmit hook protocol, pre-fetching the data into the model's context.
- Silent no-op when the DB doesn't exist yet (first activation in a fresh project — bro falls back to calling MCP tools the old way; future messages in that project then have the DB available).

**Doctrine consequence**: CLAUDE.md `## Activation routine` section reworded — bro now consumes the injected context instead of being told to call MCP tools first. Compliance becomes 10/10 mechanically.

### Removed — Direct Mode (#108)

Bro is now a pure planner: every code change goes through SWE, no exceptions. The `tmb_direct-mode` skill, the matching L4 workflow-sim test, the L5 D-direct-mode flow, and the h3-direct-mode-framing A/B scenario are all gone. The `direct_mode_used` event_type is dropped from `ledger.event_type` enum.

**Why:** the h3 A/B run (5 paired arms × 2 wording variants) showed 0/5 compliance with the `ledger_log(direct_mode_used)` audit step in *both* arms — neither softer nor stronger imperative framing moved the needle. With the audit step structurally unenforceable through prompt discipline alone, the planner-only doctrine is the safer simplification: bro never gets a "fast lane" that requires self-policing.

**Impact:**
- CLAUDE.md role / routing / reactive-skills sections updated (no exception language).
- `docs/architecture/FLOWS.md` Flow D removed; quick-index row dropped.
- `docs/architecture/FILES.md` skill index entry removed.
- `docs/contributing/ENUMS.md` `direct_mode_used` row removed.
- `tests/dogfood/flows/02-simple-task/outcome.sql` no-direct-mode-event negative assertion removed (now a tautology).
- `README.md` / `CONTRIBUTING.md` perf table & doctrine references reworded.
- `skills/git-conventions/SKILL.md` + `skills/docs-conventions/SKILL.md` Direct Mode references reworded.

### Added — 3 backfill A/B hypothesis scenarios (#153)

Real hypothesis testing for the A/B framework, aligned with #131. Each scenario compares the current dev state against a snapshot from before the relevant doctrine PR (extracted via `git show <sha>^:<path>`).

- **h1-claude-md-slim**: 99-line current vs 142-line pre-#126. Did the slim help, or was it cosmetic?
- **h2-hybrid-d-vs-lazy**: current Phase 4 cold-start logic vs pre-#148 prescan. Did Hybrid D' add value vs always-lazy?
- **h4-first-action-mandatory**: current `MANDATORY on every triggered message` body wording vs pre-#139. Does the strongest possible imperative break the LLM ceiling on greetings?

Scenarios ship as configs only; running them is opt-in (~$2-8 in tokens for the full set with N=10). Results land as ADRs under `docs/trustmybot/architecture/manual/decisions/`.

### Added — A/B prompt-eval framework (#131)

Reach-for tool when shipping doctrine changes whose value is hard to verify by reading the prompt alone. Replaces "this should help compliance" guesswork with paired-run data + chi-squared significance testing.

- **Schema** (#154): `eval_results.arm` (TEXT NOT NULL DEFAULT 'control') + `eval_results.scenario` (TEXT). Backward-compatible — existing single-arm L5 dogfood runs become 'control' rows automatically.
- **Runner** `tests/dogfood/run-ab.sh`: takes a scenario name, runs N pairs (default 5), each pair runs every arm against the same flow + prompt + scratch project. Per-arm plugin trees built via rsync overlay (arm overrides layered on top of `$PLUGIN_ROOT`).
- **Stats** `tests/dogfood/scripts/ab-report.sh`: per-arm × per-scorer pass-rate table + chi-squared (2x2 contingency, df=1) p-value. Pure awk math — no Python dep.
- **Worked example** `tests/dogfood/ab-scenarios/example-claude-md-slim/`: current slim CLAUDE.md vs a padded variant on the 95-anonymous-cold-restart flow. Not a real hypothesis — proves the framework.
- **Docs**: new `tests/README.md` row + section on when to write an A/B scenario; new `CONTRIBUTING.md` section with rule-of-thumb.

Real hypothesis testing follows in #153 (CLAUDE.md slim, Hybrid D' vs lazy, first-action chain MANDATORY).

## v0.4.2 — 2026-04-27

### Added — codebase memory (#45) — Hybrid D' design

Bro now persists a per-file index in `file_registry`: md5 + summary + last-verified timestamp. The verify-context doctrine (CLAUDE.md, post v0.4.1) tells bro to "trust the trajectory DB's `file_registry` index" when git is clean — this PR makes that index real.

**Doctrine — entry-state matrix in `tmb_project-prescan`**:

- New project (empty repo) → no registry, no scan.
- Existing repo + registry empty → **AskUserQuestion** "deep scan now or lazy fill?". Headless fallback = lazy.
- Registry populated + clean tree + HEAD == `last_verified_sha` → trust, no scan.
- Registry populated + drift → `file_registry_verify` pass; refresh mismatched rows.

**Writers**:

- **Bro** (CLAUDE.md addition): when bro Reads a file for context, follow with `file_registry_update_summaries` if the row's summary was null. Side-effect of work — no extra LLM cost.
- **SWE** (atomic-close): batch `file_registry_update_summaries(touched_paths)` alongside `task_update_status` and the commit. SWE has fresh context for free.
- **Direct Mode** (`tmb_direct-mode`): step 4 in the protocol — registry update is now mandatory alongside the `direct_mode_used` ledger event.

**New skill `tmb_deep-scan`**: eager opt-in for cold-start when the Human says yes (or invokes via "@bro deep scan"). Filters binaries / lockfiles / generated dirs, batches Reads, single bulk update call.

**Two new L5 dogfood flows**:

- `10-codebase-memory-cold-start` — existing repo + empty registry → headless fallback fires + lazy default chosen + planning still proceeds
- `11-codebase-memory-verify-on-drift` — populated registry + induced disk drift → verify pass refreshes the row

**Updated outcome.sql for existing flows**:

- `02-simple-task` — assert SWE atomic-close updated `file_registry` (md5 + summary set, `last_verified_sha` advanced)
- `D-direct-mode` — assert step 4 fired (registry row refreshed, `last_verified_sha` set)

## v0.4.1 — 2026-04-27

### Refactored — `L6 dogfood` → `L5 dogfood` (close the L4→L6 numbering gap)

The previous rename (L5+L6 combined → Release canary) demoted the standalone manual L5 to an unnumbered "Manual smoke" fallback, which left a gap between L4 and L6. This rename closes the gap: L6 dogfood is now L5 dogfood. The pyramid is contiguous L0–L5 again, with Release canary and Manual smoke as the non-numbered layers above.

Renamed:

- `.github/workflows/l6-dogfood.yml` → `.github/workflows/l5-dogfood.yml` (workflow `name:` updated, PR-label trigger now `L5`)
- `tests/dogfood/run-l6.sh` → `tests/dogfood/run-l5.sh`
- Env var: `L6_KEEP_ARTIFACTS` → `L5_KEEP_ARTIFACTS`
- Docker scratch dirs: `/tmp/tmb-l6-XXXX` → `/tmp/tmb-l5-XXXX`
- Internal globals: `L6_DOGFOOD_DIR` → `L5_DOGFOOD_DIR`

Updated docs: `tests/README.md` (pyramid table), `CONTRIBUTING.md` (workflow scope), `tests/manual/{setup,README}.md`, `docs/contributing/LABELS.md`, `docs/architecture/FILES.md`, `scripts/release.sh`, `scripts/hooks/debug-trajectory.sh`, `mcp/trajectory-server/src/{index,test/schema.test}.ts`.

### Refactored — testing framework: `L5+L6 combined` → `Release canary`, `L5 manual dogfood` → `Manual smoke` (fallback)

The numeric "L5+L6 combined" name was awkward (not a real layer, just a Docker-bundled superset) and constrained future insertion of heavy layers. Renamed to a non-numeric **Release canary** so future layers (e.g. A/B prompt eval — issue #131, perf canary, etc.) can slot in between L4 and Release canary without renumbering.

Standalone "L5 manual dogfood" demoted to **Manual smoke** — a fallback used only for UX scenarios the automated layers can't model (e.g. live `AskUserQuestion` interactivity). The Release canary handles everything else automatically.

Renamed files:

- `.github/workflows/l5-l6-combined.yml` → `.github/workflows/release-canary.yml`
- `tests/docker/l5-l6-combined.Dockerfile` → `tests/docker/release-canary.Dockerfile`
- `tests/docker/run-l5-l6-combined.sh` → `tests/docker/run-release-canary.sh`
- Workflow `name:` and job ID updated to `Release canary` / `release-canary`.
- Image tag: `tmb-l5-l6-combined:<v>` → `tmb-release-canary:<v>`.

Updated docs: `tests/README.md` (test pyramid + escalation chain), `CONTRIBUTING.md` ("CI scope" workflow table), `scripts/release.sh` (manual smoke gate framing).

### Refactored — defaults seeded by schema, not by bro

The previous unreleased entry had bro silently writing 3 `plugin_config` rows + a `tmb_defaults_applied` ledger event on first contact. Per user follow-up: that's still bro doing work the system should do.

- `mcp/trajectory-server/src/schema.sql` now seeds the 3 default policy keys via `INSERT OR IGNORE` at DB creation. Bro never touches `plugin_config` on first contact.
- `tmb_defaults_applied` ledger event removed entirely (the schema seed is silent; bro only logs events for decisions it actually makes).
- CLAUDE.md first-action chain compressed from 12 lines (state check + conditional default-write + cache + resume) to 4 lines (two parallel reads: `identity_get` + `issue_resume`, then welcome banner). `config_get` no longer in the always-call set; bro fetches lazily when a specific key matters.
- Welcome banner simplified from 3 variants to 2 (no "first contact" variant — pending-work or idle is enough).
- Test fixtures (`onboarding-named.sql`, `onboarding-anonymous.sql`) shrunk: they no longer INSERT plugin_config (now schema-seeded) and dropped the `tmb_defaults_applied` ledger row. `onboarding-named.sql` writes a `tmb_user_named` event instead to mark "user explicitly chose this name".

### Removed — first-run-onboarding ceremony (modern-agent UX)

Modern agents (Cursor, ChatGPT, etc.) don't onboard — they just work. TMB's previous behavior of asking name + branching model + PR target + protected branches via `AskUserQuestion` on first contact was friction with no upside for the 80% case, and it broke completely in headless `claude -p` mode (no Human to answer).

- **Deleted**: `skills/tmb_first-run-onboarding/` (entire skill).
- **Deleted**: `tests/lint/onboarding-skill-contract.sh` (no skill to lint).
- **Deleted**: `tests/dogfood/flows/01-onboarding/` (no ceremony to test).
- **New**: `tests/dogfood/flows/01-first-contact/` — asserts the inverse: empty DB → `@bro hi` → bro applies defaults silently + welcome banner mentions them; `AskUserQuestion` and `identity_set` are explicitly forbidden tools.
- **CLAUDE.md first-action chain rewritten**: on first contact (`config_get` returns null), bro silently writes `branching_model=github-flow`, `pr_target=main`, `protected_branches=["main"]` plus a `tmb_defaults_applied` ledger event. **No `identity` row** — its absence means "user hasn't named themselves yet."
- **Welcome banner is now mandatory** (also new in CLAUDE.md): bro must announce activation explicitly with state context — three variants for first contact / returning with pending work / returning idle.
- **Ledger event renamed**: `tmb_onboarding_complete` → `tmb_defaults_applied`. Pre-1.0, no migration shim — fixtures and outcome assertions updated in lockstep.
- **`tmb_reonboard` repositioned** as the only path to write identity rows or change policy keys (was: "re-run onboarding"). Same skill, same UI, clearer framing.

To set your name post-first-contact: say `@bro reonboard` or `@bro update my name`.

## v0.4.1 — 2026-04-25

**Cluster of bugs found during cold-session marketplace dogfood by [@trustmybot](https://github.com/trustmybot).** All four were doctrine drift, not infra: bro had stale instructions, server enforcement was working but invisible.

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

`tmb_lazy-arch-check` previously did nothing on first-ever session, waiting for the Human to manually request `/tmb refresh-architecture`. Tiny dogfood projects rarely cross the 25-commit threshold, so they never got `docs/trustmybot/architecture/auto/` populated.

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

**12 scaffolded flows** (auto-skip until expected-trajectory authored): `03-difficult-task`, `04-agent-creator`, `05-skill-creation`, `06-push-gate`, `07-architecture-refresh`, `08-swe-retry`, `09-roundtable`, `C-consultant`, `32-team-config`, `92-base-branch`, `94-arch-bootstrap`, `96-halt-on-error`.

**CI workflow** `.github/workflows/l6-dogfood.yml`:
- Triggers: tag pushes, PRs labeled `L6`, manual dispatch
- Soft-fails when `CLAUDE_CODE_OAUTH_TOKEN` secret is absent (forks won't break red)
- Uploads trajectory dumps as artifacts on failure

**Stale doctrine cleanup** (per the migration audit):
- Onboarding skill: fixed event_type from stale `tmb_bootstrap_complete` → `tmb_defaults_applied`; dropped reference to "file copies" (swe + pr-reviewer ship globally)
- Agent-creator skill: dropped `tmb_bootstrap` reference (skill is gone in v0.3.0+)
- Plugin CLAUDE.md: removed the "tmb_bootstrap is being retired" sentence (it's already retired)

**Unverified assumption flagged in the issue**: `claude -p` mode behavior with `AskUserQuestion`. If the form auto-fails in headless mode, that surfaces as a trajectory-shorter-than-expected failure on the onboarding flow — a real signal to address.

2 new schema tests (table presence + columns + index). All L1-L4 green.

### Added — L6 evals v2: outcome-first multi-scorer architecture (issue #110)

L6 v1 (PR #109) used strict trajectory matching, which Anthropic explicitly warns against as too brittle (*"agents regularly find valid approaches that eval designers didn't anticipate"*). v2 replaces that with the industry-standard multi-scorer pattern (Inspect AI / AgentEvals).

**Schema additions** (additive, schema_version stays at 1):
- `debug_trajectory`: 3 new columns — `tokens_in`, `tokens_out`, `latency_ms` (default 0)
- New `eval_results` table — one row per `(flow, scorer)` per run, with `run_id`, `pass`, `value`, `explanation`, `metadata_json`. Indexed on `(run_id, scorer_name)` and `(flow_name, created_at)`.

**4 scorer types** (per `tests/dogfood/lib/scorers.sh`):
- **Outcome** (primary, deterministic) — SQL assertions on final DB state. Replaces strict trajectory match. *Grade what was produced, not the path.*
- **trajectory_required** (secondary) — listed tools must have been called (any order; superset semantics)
- **trajectory_forbidden** (secondary) — listed tools must NOT have been called (subset/safety semantics)
- **cost** (observational) — tokens + p99 latency tracked vs per-flow budget; warns on overage but doesn't fail unless `fail_above_max: true`

**Per-flow directory layout** (replaces `expected/<name>.txt`):
```
tests/dogfood/flows/<name>/
├── README.md
├── outcome.sql
├── tools-required.json
├── tools-forbidden.json
├── cost-budget.json
└── run.sh
```

**4 wired flows fully converted** to v2 (01-onboarding, 02-simple-task, D-direct-mode, 95-anonymous-cold-restart). 12 scaffolds preserved with v2 entry points; auto-skip until their `outcome.sql` is authored.

**Stale L6 v1 artifacts removed**: `tests/dogfood/expected/` directory, `l6_assert_trajectory` helper.

**Citations** (new `docs/contributing/EVALS.md` and PR body): Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), LangSmith's [trajectory-evals docs](https://docs.langchain.com/langsmith/trajectory-evals) (4 match modes), [Inspect AI](https://inspect.aisi.org.uk/) (Dataset / Solver / Scorer / Task primitives), [AgentEvals](https://github.com/langchain-ai/agentevals), and the [LLM Agent Evaluation Survey](https://arxiv.org/html/2507.21504v1).

3 new schema unit tests (debug_trajectory cost columns + eval_results structure). All L1-L4 green.

### Added — L5+L6 combined Docker harness (issue #112)

Replaces manual L5 dogfood for everything except UX-only verification. Builds a Docker image that simulates CC's marketplace install path (`bun install --ignore-scripts` → place at `~/.claude/plugins/cache/trustmybot/tmb/<version>/`), then runs L6 deterministic-trajectory flows against the marketplace-installed plugin.

Catches BOTH bug classes in one run:
- **Install path** (L0's job — dist/ shipping, MCP server cold spawn, native bindings)
- **Workflow doctrine** (L6's job — does bro do the right thing against the as-shipped artifact?)

Files:
- `tests/docker/l5-l6-combined.Dockerfile` — combined install + claude install + L6 flows
- `tests/docker/run-l5-l6-combined.sh` — local convenience wrapper (BuildKit secret for token)
- `.github/workflows/l5-l6-combined.yml` — release-only CI (tag pushes + manual dispatch)

**Per user policy: token-heavy tests run on tag pushes only, NOT on every PR.** Each full L5+L6 run is ~$1-3 in real Claude tokens. The cost is amortized across releases (one run per tag), trading per-run cost for elimination of manual L5 dogfood (~30-45 min human time per release).

Token security: `CLAUDE_CODE_OAUTH_TOKEN` passed via Docker BuildKit secret (mounted at `/run/secrets/cc_token`), NOT baked into image layers.

The workflow soft-fails when the secret is absent — the L0 install piece still runs, the L6 piece skips with a notice.

---

## v0.3.2 — 2026-04-25

**Hook + agent-prompt hotfix.** Two real bugs in `git-guards.sh` that broke every SWE commit-from-worktree, plus a SWE doctrine violation. Found by [@trustmybot](https://github.com/trustmybot) during v0.3.1 marketplace test — bro spent 12 minutes hitting the same hook-block before reporting.

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
| Log onboarding audit row | ✓ (`tmb_bootstrap_complete`) | ✓ (renamed `tmb_defaults_applied`) |
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
| 7 — Architecture refresh | `flow-07-architecture-refresh.test.mjs` | legacy arch-cache cursor lifecycle; swe forbidden from the legacy arch-refresh tool and cache-writer tool |
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

Added a Docker-based **install-smoke test** at [`tests/l0-install/install-smoke.Dockerfile`](tests/l0-install/install-smoke.Dockerfile) and a local wrapper [`tests/l0-install/run-install-smoke.sh`](tests/l0-install/run-install-smoke.sh). The Dockerfile:

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

- **Multi-platform placeholder structure** ([#73](https://github.com/trustmybot/plugin/pull/73)). Per-platform adapter dirs (`.codex-plugin/`, `.cursor-plugin/`, `.opencode/`) and root-level personas (`CODEX.md`, `CURSOR.md`, `GEMINI.md`, `gemini-extension.json`) ship as **placeholders only** — clearly marked "not implemented." The strategy doc at [`docs/reference/MULTI_PLATFORM.md`](docs/reference/MULTI_PLATFORM.md) explains how the per-platform adapter pattern works, what an adapter would do, and why placeholders ship now (discoverability + path-precedent). No platform other than Claude Code is functional in this release.
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
- **Bundled SQLite trajectory MCP server.** Node + `better-sqlite3` + `@modelcontextprotocol/sdk` in `mcp/trajectory-server/`. ~30 tools spanning issues, tasks, discussions, validation, ledger, audit, file-registry, architecture-refresh, identity, config, skills.
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

`tmb_first-run-onboarding`, `tmb_planning-simple`, `tmb_planning-difficult`, `tmb_swe-spawn-workflow`, `tmb_branch-id-proposal`, `tmb_agent-creator`, `tmb_skill-creator`, `tmb_bootstrap` (recovery), `tmb_project-prescan`, `tmb_lazy-arch-check`, `tmb_refresh-architecture`, `tmb_reonboard`, `tmb_create-hook`, `tmb_feedback-loop`, `tmb_roundtable`, `tmb_roundtable-cleanup`, `tmb_validate-swe-output`.

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
