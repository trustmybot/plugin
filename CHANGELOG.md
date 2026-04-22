# Changelog

All notable changes to the TMB plugin. Versions follow [SemVer](https://semver.org/) (pre-1.0: breaking changes may happen on minor bumps).

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
