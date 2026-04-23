# Changelog

All notable changes to the TMB plugin. Versions follow [SemVer](https://semver.org/) (pre-1.0: breaking changes may happen on minor bumps).

## [0.3.2] — 2026-04-23

Stale-cleanup pass. Reduces the shipped surface to the minimum
needed for a technical-user coding workflow. Schema v6 drops a dead
column and gives `validation_attempts` a real foreign key.

### Added

- **Plugin-root `.gitignore`** — covers `.claude/` (CC runtime), `*.db`
  variants, `node_modules/`, `dist/`, editor cruft. (#23)
- **Schema v6 migration** (`applyV5ToV6` in `mcp/trajectory-server/src/db.ts`)
  — auto-upgrades v3, v4, v5 databases in place on plugin open. (#24)
- **`skills/docs-conventions/SKILL.md` "Editing Agent Prompts and Skill
  Files"** section — discipline for modifying markdown prompts (delete-
  before-add, preserve operational meaning, match tone, don't expand
  scope). Absorbs the role the removed `prompt-engineer` agent held.

### Changed

- **Schema v6**: `tasks.task_spec_path` column dropped (was dead after
  Phase 6.5 replaced it with `spec_body_md`); `validation_attempts.task_id`
  changed from `TEXT NOT NULL` (no FK) to `INTEGER NOT NULL REFERENCES
  tasks(id)`. Existing rows preserved via `CAST(task_id AS INTEGER)`;
  orphan rows whose task_id didn't match any `tasks.id` are dropped. (#24)
- **Agent roster reduced to four**: `gatekeeper`, `architect`, `swe`,
  `pr-reviewer`. Architect now owns prompt/skill/doc edits in addition
  to task authoring.
- **`validation_record` MCP tool** now coerces `task_id` to a positive
  integer and verifies the task exists before insert; clearer errors
  than raw FK failures. `ValidationAttempt.task_id` typed `number`.
- **Skills normalized to `<name>/SKILL.md`** directory convention — the
  three flat-file skills (`agent-creator.md`, `tmb-reonboard.md`,
  `validate-swe-output.md`) moved into directories. Path references in
  `agents/architect.md`, `agents/swe.md`, `skills/architect-workflow/`,
  and `skills/feedback-loop/` updated.
- **Tests**: `phase-2-discussions.test.ts` → `discussions.test.ts`;
  `schema_v3.test.ts` → `schema.test.ts` (with v6 contract assertions);
  new migration test `j. v5-to-v6 in-place migration`.

### Removed

- `agents/prompt-engineer.md` — cold-context rewriter replaced by
  architect + `docs-conventions` prompt-editing rules.
- `templates/agents/ceo.md`, `templates/agents/cto.md`,
  `skills/seed-project-agents/` — no more auto-seeding of project-level
  agents on first activation. Domain agents (ceo, cto, pm, …) come
  on-demand via `agent-creator` with explicit user approval.
- `skills/python-dev/`, `skills/sql-dev/`, `skills-gallery/` — plugin is
  stack-agnostic; Python/SQLite skills imposed a stack on downstream
  users. (#25)
- `teams/` — agent-teams `roundtable.json` was never written;
  `skills/roundtable/` remains the execution path.
- `install.sh` — deprecation stub from v0.1, purpose served.
- Stray `.gitkeep` files in `agents/`, `skills/`, `mcp/trajectory-server/`,
  `monitors/`.
- `task_set_spec_path` MCP tool (the Phase-6.5 no-op stub) — the column
  it referenced is gone.
- `AgentRole` variant `prompt-engineer` in `middleware/agent-scope.ts`.

### Migration notes (0.3.1 → 0.3.2)

- SQLite auto-migrates v5 → v6 on first load. Drops `task_spec_path`;
  rebuilds `validation_attempts` with INTEGER FK.
- If you override `prompt-engineer` in a project's `.claude/agents/`,
  the override still works (local file wins) but the plugin no longer
  auto-spawns it from gatekeeper routing. Update your routing prompts
  or delete the override.
- If you edited the seeded `ceo.md` / `cto.md` in a project, they stay
  where they are — the plugin just no longer auto-seeds new projects
  with them. Existing files are user-owned.
- Deprecated `task_set_spec_path` MCP call will now fail; any call sites
  should have migrated to `task_create_batch(spec_body_md=...)` in v0.3.1.

## [0.3.1] — 2026-04-21

Design-correctness fix: task specs are state, not documents. They move
from markdown files at `docs/trustmybot/tasks/<branch_id>.md` into the
SQLite `tasks.spec_body_md` column. No user-visible workflow change —
architect still authors, SWE still executes, PR Reviewer still gates.
What's gone is the on-disk intermediate file.

### Added

- **Schema v5**: `tasks.spec_body_md` column (full markdown body SWE
  reads). Auto-migrates v4 → v5 in place; existing rows keep empty body.
- **`task_create_batch` accepts `spec_body_md`** (max 64000 chars;
  optional at the MCP layer, effectively required by the hook gate).

### Changed

- **SWE spawn convention**: prompt carries `task_id=<N>` instead of a
  `docs/trustmybot/tasks/*.md` path. `require-task-spec.sh` gates on
  `tasks.status IN ('pending','open')` AND non-empty `spec_body_md`.
- **Agents and skills** (architect, swe, pr-reviewer, gatekeeper,
  prompt-engineer; architect-workflow, swe-spawn-workflow, swe-checklist,
  validate-swe-output, review-protocol, create-hook, git-conventions,
  seed-project-agents, agent-creator): rewritten to reference
  `task_get(task_id)` and `spec_body_md`. No markdown-task-file
  references remain.
- **PR Reviewer Layer-2 ledger check**: upgraded from deferred to active
  (Phase 5 shipped `regen_state_get`).

### Deprecated

- **`task_set_spec_path` MCP tool**: returns `{ deprecated: true, ... }`
  no-op. Kept registered for back-compat with v0.3.0 clients.

### Removed

- `plugin/docs/trustmybot/SPEC-FORMAT.md` and `plugin/docs/trustmybot/tasks/`.
- `plugin/templates/docs-trustmybot/SPEC-FORMAT.md` and
  `plugin/templates/docs-trustmybot/tasks/`.
- Legacy XML-fallback block in `require-review-sign.sh`.
- Stale `GOALS.md` / `BLUEPRINT.md` / `DISCUSSION.md` references in
  agent-creator, prompt-engineer, and README.
- Stale Phase-5 "will add" / "does not yet exist" phrases.

### Migration notes (0.3.0 → 0.3.1)

- SQLite auto-migrates v4 → v5 on first load (adds `spec_body_md`).
- Existing v0.3.0 task markdown files under `docs/trustmybot/tasks/` in
  downstream user projects are now orphaned. They are safe to delete
  manually; the plugin does not read them. A future phase may ship a
  one-shot import script.
- Downstream CI that grep'd for `docs/trustmybot/tasks/` paths will go
  silent — retarget to `task_get(task_id)` queries against the
  trajectory DB.

## [0.3.0] — 2026-04-22

Workflow redesign: SQLite is canonical state; files are generated snapshots; git is the organizing primitive; gatekeeper is silent by default, opinionated when needed.

### Added

- **Hybrid architecture-doc directory** (`docs/trustmybot/architecture/{auto,manual}/`): `auto/` regenerates from `file_registry` SQLite table via lazy git-log diff parse; `manual/` holds ADRs + narrative. Four auto-generated files: `codebase-tree.md`, `erd.md`, `module-graph.md`, `changelog.md`.
- **`architecture_regen` MCP tool** (orchestrator): full + incremental scopes, target filtering, path-safety.
- **`file_registry` MCP tools** (`upsert`, `list`, `delete`): track files, types, imports, exports, last_change.
- **`regen_state` MCP tools** (`get`, `set`): track last-regen-per-target with SHA.
- **`discussions` MCP tools** (`append`, `list`, `issue_get_with_discussions`): conversational intent captured in SQLite, replacing `GOALS.md` / `DISCUSSION.md` files.
- **`issue_list` + `issue_snapshot_md` MCP tools**: enumerate issues, generate read-only markdown snapshots on demand.
- **`task_set_spec_path` MCP tool**: link task rows to markdown spec files.
- **`task_update_status` accepts `commit_sha`**: atomic close with commit linkage.
- **Silent-default UX** for gatekeeper: pre-scan only on first code-touching ask of a session, not every greeting.
- **Two-path workflow** (simple vs difficult): every code change routes through architect; heuristic = "does it require updates to `docs/trustmybot/architecture/`?"; architect has trivial vs standard task-template tiers.
- **First-run onboarding**: gatekeeper detects fresh project, asks 2-3 questions (branching model, PR target, identity), persists via `config_set` + `identity_set`.
- **Identity rename UX**: `identity_get` at session start; mid-session rename via natural language; `identity_set` persists.
- **`tmb-reonboard` skill**: re-run onboarding to change branching model or reset identity later.
- **`refresh-architecture` skill**: wraps `architecture_regen` with user-facing invocation.
- **Gatekeeper lazy-regen**: runs `architecture_regen` at session start when new commits warrant it (≤25 silent; >25 nudge user).
- **PR Reviewer auto-dir check**: flags manual edits to `architecture/auto/*.md` files.
- **`git-guards.sh` config-driven**: reads `branching_model` / `pr_target` / `protected_branches` from `plugin_config` SQLite; supports trunk-based / gitflow / custom models.
- **Branch-id format validation**: `task_create_batch` enforces `^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)/[a-z0-9][a-z0-9-]{0,62}$`.
- **Template seeding** (`templates/docs-trustmybot/`): replaces `bro-template/`; includes `architecture/` subtree + `snapshots/`.
- **Role-gated MCP writes**: `discussion_append`, `task_set_spec_path`, `issue_snapshot_md`, `file_registry_upsert`, `file_registry_delete`, `regen_state_set`, `architecture_regen` require appropriate agent roles.

### Changed

- **Task spec format**: XML envelope dropped. New specs are markdown at `docs/trustmybot/tasks/<branch_id_filename>.md` (markdown frontmatter + body).
- **Workflow directory**: `bro/` → `docs/trustmybot/` everywhere (agents, skills, hooks, README, CLAUDE.md).
- **Branch-id semantics**: accepts git-convention strings (`feat/user-login`, `fix/auth-crash`), not synthetic `1.2.3` numbering. Gatekeeper proposes branch names from intent.
- **SWE agent prompt**: reads markdown specs (not XML); closes via `task_update_status(commit_sha=<sha>)`; never hand-edits spec files.
- **Architect agent prompt**: writes markdown specs; captures intent via `issue_create` + `discussion_append`; two task-template tiers (trivial / standard).
- **PR Reviewer agent prompt**: records verdicts via `validation_record` MCP call; no `Edit` tool needed; new No-Edit Discipline section.
- **Gatekeeper agent prompt**: MCP-driven pre-scan; new Section C.0 Triage (simple/difficult); Section A.1 First-Run Onboarding; Section A.2 Identity; Section A.3 Lazy Architecture Regen.
- **`CLAUDE.md` Workflow Files table**: reflects SQLite-canonical state model (files are snapshots).
- **Schema v4**: added `discussions`, `file_registry`, `plugin_config`, `identity`, `regen_state` tables; added `tasks.task_spec_path` + `tasks.commit_sha` columns. Auto-migration from v3.
- **`require-task-xml.sh` → `require-task-spec.sh`**: accepts `docs/trustmybot/tasks/*.{xml,md}` with format-dispatched authorization checks (also accepts absolute paths for workspace-level specs).
- **`require-review-sign.sh` queries SQLite** (via `lib/query-task.sh` helper), with legacy XML fallback.

### Removed

- `bro-template/` (replaced by `templates/docs-trustmybot/`).
- `bro/GOALS.md`, `bro/BLUEPRINT.md`, `bro/DISCUSSION.md` as required files (replaced by `issues` + `discussions` SQLite tables; snapshots generated on demand).
- XML task spec envelope (replaced by markdown frontmatter + body).
- Hardcoded `dev` / `main` in `git-guards.sh` (now config-driven).
- `scripts/hooks/require-task-xml.sh` (renamed).

### Known issues

See the plugin's GitHub Issues for open items migrated from v0.2 dogfooding:

- #13 require-review-sign blocks all pushes, not just dev/main
- #14 subagent Bash may bypass host PreToolUse hooks (unconfirmed)
- #16 withAgentScope middleware redactor param unused (hygiene)

### Migration notes (0.2.x → 0.3.0)

- SQLite schema auto-migrates v3 → v4 on first load.
- Existing projects with `bro/` directories should rename to `docs/trustmybot/` (no data migration — paths only).
- First activation on 0.3.0 triggers the onboarding flow; use `/tmb reonboard` to re-run.
- XML task specs in `bro/tasks/` stop being recognized. New specs are markdown at `docs/trustmybot/tasks/`.

## [0.2.0] — 2026-04-21

Initial native Claude Code plugin format release. Migrated from `.claude/`-based scaffolding to proper plugin manifests + marketplace.

### Added

- Native plugin format (`.claude-plugin/plugin.json` + marketplace manifest).
- Bundled SQLite MCP server at `mcp/trajectory-server/` (schema v3, 13 tables, 23 tools).
- Two-tier agent roster: global (`gatekeeper`, `prompt-engineer`) + project placeholders (`ceo`, `cto`, `architect`, `swe`, `pr-reviewer`).
- Agent-creator skill for on-demand domain agents.
- Hook-enforced task-spec gate + review-sign gate.
- Information-isolation via frontmatter (`isolation: worktree`, `disallowedTools`).

[0.3.0]: https://github.com/trustmybot/plugin/releases/tag/v0.3.0
[0.2.0]: https://github.com/trustmybot/plugin/releases/tag/v0.2.0
