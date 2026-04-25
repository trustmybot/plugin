# Changelog

All notable user-visible changes to the TMB plugin. Versions follow [SemVer](https://semver.org/) (pre-1.0: breaking changes may happen on minor bumps).

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
