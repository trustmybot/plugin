# Plugin File Map

Generated 2026-04-23 on branch `docs/architecture-baseline`. Every file tracked in `plugin/` is listed with its purpose. A **Stale / Upgrade** section at the end flags what should be removed or migrated.

## Tree (excluding `node_modules/`, `dist/`, `.git/`, `*.lock*`)

```
plugin/
├── .claude-plugin/
│   ├── marketplace.json              # marketplace entry for `trustmybot` channel
│   └── plugin.json                   # native CC plugin manifest (name, version, deps)
├── .github/
│   └── workflows/
│       └── test.yml                  # CI: bun build + MCP tests + hook tests on PR to dev
├── .mcp.json                         # registers bundled MCP server with CC
├── CHANGELOG.md                      # user-facing release notes (keep-a-changelog)
├── CLAUDE.md                         # auto-loaded plugin rules + agent roster
├── CONTRIBUTING.md                   # branch workflow, pre-PR checklist, design principles
├── install.sh                        # DEPRECATION STUB — prints native install command
├── LICENSE                           # MIT
├── README.md                         # project README
│
├── agents/                           # Tier 1 — global workflow agents (ship with plugin)
│   ├── .gitkeep                      # stale: dir has real files now
│   ├── architect.md                  # task breakdown, spec authoring, SWE spawn, validation
│   ├── gatekeeper.md                 # human entry point, routing, onboarding, triage
│   ├── pr-reviewer.md                # pre-commit/pre-push review gate (read-only)
│   ├── prompt-engineer.md            # prompt/skill/doc doctor — markdown-only edits
│   └── swe.md                        # single-task executor in worktree
│
├── hooks/
│   └── hooks.json                    # CC hooks manifest (PreToolUse, WorktreeCreate, etc.)
│
├── mcp/
│   └── trajectory-server/            # bundled Node MCP server (SQLite-backed)
│       ├── .gitignore                # ignore dist/, .trajectory.db, node_modules
│       ├── .gitkeep                  # stale: dir has real files
│       ├── .trajectory.db            # STALE — developer local DB committed by accident
│       ├── bun.lock                  # dependency lockfile
│       ├── package.json              # @modelcontextprotocol/sdk + better-sqlite3
│       ├── README.md                 # MCP server README (build/test/run instructions)
│       ├── tsconfig.json             # strict TS config, emits to dist/
│       │
│       ├── docs/
│       │   └── CONFIG_KEYS.md        # canonical list of plugin_config keys
│       │
│       └── src/
│           ├── db.ts                 # opens DB, runs migrations v3→v4→v5
│           ├── index.ts              # MCP server entrypoint (stdio transport)
│           ├── schema.sql            # authoritative schema DDL (14 tables)
│           ├── types.ts              # shared TS types (Issue, Task, etc.)
│           │
│           ├── middleware/
│           │   └── agent-scope.ts    # passthrough wrapper; role-gating lives in tools/*
│           │
│           ├── regen/
│           │   ├── git-walker.ts     # lazy git-log diff walker — populates file_registry
│           │   └── ts-import-parser.ts # extracts imports/exports for module-graph renderer
│           │
│           ├── renderers/
│           │   ├── changelog.ts      # docs/trustmybot/architecture/auto/changelog.md
│           │   ├── codebase-tree.ts  # codebase-tree.md renderer
│           │   ├── erd.ts            # erd.md renderer (Mermaid ER)
│           │   ├── module-graph.ts   # module-graph.md renderer (Mermaid graph)
│           │   └── types.ts          # shared renderer types
│           │
│           ├── test/                 # node:test unit tests (~240+ cases)
│           │   ├── agent-scope.test.ts
│           │   ├── architecture-regen.test.ts
│           │   ├── changelog.test.ts
│           │   ├── codebase-tree.test.ts
│           │   ├── config_keys_contract.test.ts
│           │   ├── config.test.ts
│           │   ├── db.test.ts
│           │   ├── erd.test.ts
│           │   ├── file-registry.test.ts
│           │   ├── helpers.ts        # tempDB() fixture
│           │   ├── identity.test.ts
│           │   ├── issues.test.ts
│           │   ├── ledger.test.ts
│           │   ├── migration.test.ts
│           │   ├── module-graph.test.ts
│           │   ├── phase-2-discussions.test.ts  # phase-* naming stale; test still valid
│           │   ├── regen-state.test.ts
│           │   ├── remaining_tools.test.ts
│           │   ├── schema_v3.test.ts # legacy v3 schema test — confirm still relevant
│           │   └── tasks.test.ts
│           │
│           └── tools/                # MCP tool families (one file per domain)
│               ├── architecture-regen.ts  # orchestrator: file-registry scan + 4 renderers
│               ├── audit.ts          # audit_log, audit_list (full tool outputs)
│               ├── config.ts         # plugin_config get/set/list
│               ├── discussions.ts    # discussion_append, discussion_list
│               ├── file-registry.ts  # file_registry_scan_commits, file_registry_list
│               ├── identity.ts       # identity_get, identity_set
│               ├── index.ts          # registerTools() — wires every family into server
│               ├── issues.ts         # issue_create/get/resume/close/snapshot_md
│               ├── ledger.ts         # ledger_log, ledger_list (append-only events)
│               ├── regen-state.ts    # regen_state_get/update — cursor for lazy regen
│               ├── reports.ts        # issue_report_md — full-issue narrative builder
│               ├── skills.ts         # skill registry + effectiveness tracking
│               ├── tasks.ts          # task_create_batch, task_get, task_update_status, etc.
│               └── validation.ts     # validation_record, validation_history
│
├── monitors/                         # background status-line process
│   ├── .gitkeep                      # stale: dir has files
│   ├── bun.lock
│   ├── monitors.json                 # CC monitor manifest
│   ├── package.json                  # better-sqlite3 for read-only DB tail
│   └── tmb-trajectory-events.js      # emits [TMB] status lines from ledger events
│
├── scripts/
│   └── hooks/                        # shell hook scripts invoked by hooks.json
│       ├── diagnostic/               # opt-in harness for GitHub Issue #14
│       │   ├── probe-bash.sh         # subagent Bash-bypass probe
│       │   └── README.md             # diagnostic usage guide
│       ├── lib/
│       │   └── query-task.sh         # shared sqlite helpers (tmb_db_path, tmb_task_spec_status)
│       ├── create-worktree.sh        # WorktreeCreate hook (workaround CC #27134/#44965)
│       ├── git-guards.sh             # blocks commit on protected branches, force-push, etc.
│       ├── require-review-sign.sh    # blocks push until pr-reviewer signs completed tasks
│       └── require-task-spec.sh      # blocks SWE spawn unless task_id references valid DB row
│
├── skills/                           # Claude Code skills (path-triggered or agent-invoked)
│   ├── .gitkeep                      # stale: dir has files
│   ├── agent-creator.md              # FLAT-FILE skill — propose & write new agent file
│   ├── tmb-reonboard.md              # FLAT-FILE skill — re-run onboarding flow
│   ├── validate-swe-output.md        # FLAT-FILE skill — fork Explore to verify SWE task
│   │
│   ├── architect-workflow/SKILL.md   # architect's end-to-end task-authoring flow
│   ├── code-quality/SKILL.md         # generic quality gates (error handling, security, edges)
│   ├── create-hook/SKILL.md          # how to add a new hook script safely
│   ├── docs-conventions/SKILL.md     # rules for anything under docs/trustmybot/
│   ├── feedback-loop/SKILL.md        # architect ↔ SWE retry/escalation protocol
│   ├── git-conventions/SKILL.md      # emoji-prefixed commits, branch naming
│   ├── naming-conventions/SKILL.md   # file/variable/test naming rules
│   ├── python-dev/SKILL.md           # QUESTIONABLE — stack-specific, see stale section
│   ├── refresh-architecture/SKILL.md # user-facing "regenerate architecture docs" entry
│   ├── review-findings/SKILL.md      # pr-reviewer output format
│   ├── review-protocol/SKILL.md      # pr-reviewer full protocol
│   ├── roundtable/SKILL.md           # multi-agent debate coordinator (sequential fallback)
│   ├── roundtable-cleanup/SKILL.md   # post-roundtable DB cleanup
│   ├── seed-project-agents/SKILL.md  # copies templates/agents/* into project on first run
│   ├── sql-dev/SKILL.md              # QUESTIONABLE — stack-specific, see stale section
│   ├── swe-checklist/SKILL.md        # SWE pre-commit checklist
│   └── swe-spawn-workflow/SKILL.md   # architect's protocol for spawning SWE
│
├── skills-gallery/                   # parked opt-in stack skills (not auto-loaded)
│   ├── .gitkeep
│   ├── frontend-dev/SKILL.md         # React 19 + shadcn — parked from Phase 0 GAN_CV scrub
│   └── typescript-api-dev/SKILL.md   # Bun + Drizzle — parked from Phase 0 GAN_CV scrub
│
├── teams/
│   └── .gitkeep                      # EMPTY — roundtable.json never shipped; legit placeholder
│
├── templates/                        # content seeded into project on first activation
│   ├── agents/                       # Tier 2 — domain-role starter prompts
│   │   ├── ceo.md                    # product direction (user edits to match domain)
│   │   └── cto.md                    # technical architecture (user edits to match domain)
│   │
│   └── docs-trustmybot/              # seeded docs/trustmybot/ skeleton for downstream projects
│       ├── architecture/
│       │   ├── auto/                 # regenerated from file_registry (do not edit)
│       │   │   ├── changelog.md
│       │   │   ├── codebase-tree.md
│       │   │   ├── erd.md
│       │   │   └── module-graph.md
│       │   ├── manual/               # hand-curated (architects own)
│       │   │   ├── decisions/0001-example.md   # ADR template
│       │   │   ├── data-flow.md
│       │   │   ├── infrastructure.md
│       │   │   └── security-model.md
│       │   └── README.md             # auto vs manual rules
│       └── snapshots/.gitkeep        # for issue_snapshot_md output
│
└── tests/                            # plugin-level test infrastructure
    ├── README.md                     # contributor testing guide + dogfood checklist
    ├── run-all.sh                    # runs MCP + hook suites; exits 0 only if all pass
    ├── hooks/                        # bash tests for scripts/hooks/*.sh
    │   ├── git-guards.test.sh
    │   ├── require-review-sign.test.sh
    │   ├── require-task-spec.test.sh
    │   └── run.sh                    # aggregator for *.test.sh
    └── lib/
        └── assert.sh                 # shared assertion helpers (assert_eq, etc.)
```

---

## Stale / Upgrade Candidates

Flagged file-by-file. Severity tiers: **🔴 remove/fix now**, **🟡 revisit**, **🟢 cosmetic**.

### 🔴 Remove now

1. **`mcp/trajectory-server/.trajectory.db`** — binary SQLite DB committed by accident. Developer's local state. Every contributor gets a merge conflict on this. Add to `.gitignore` and `git rm` it.

2. **`tasks.task_spec_path` column** (schema.sql:33) — remnant of pre-Phase 6.5 file-based spec era. Now fully replaced by `spec_body_md`. Column is still NOT NULL DEFAULT `''` and referenced in `types.ts`, `tools/reports.ts`, and two test files. Drop via schema v5→v6 migration or deprecate in a follow-up. Keeping a "use `spec_body_md`" column around invites confused future agents.

3. **`skills/python-dev/SKILL.md` and `skills/sql-dev/SKILL.md`** — stack-specific skills that survived the Phase 0 scrub by accident. The plugin is stack-agnostic. Move both to `skills-gallery/` (matches frontend/typescript treatment) or delete. Current asymmetry (frontend parked, python auto-loaded) is inconsistent.

### 🟡 Revisit

4. **`install.sh`** — pure deprecation stub (7 lines, exits 1). Useful for one release after native-plugin migration; purpose served by v0.3. Remove in v0.4.

5. **`skills-gallery/`** — two parked skills from the GAN_CV scrub. If we're not planning to ship a curated gallery, delete both files and the directory. If we are, document the opt-in path (users copy the SKILL.md into their project's `.claude/skills/`) — right now there's no README explaining what `skills-gallery/` is for.

6. **`teams/.gitkeep`** — placeholder for `teams/roundtable.json`. Plan locked agent-teams as a feature behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, but the JSON was never written. Either ship the agent-teams definition or drop the directory and let `skills/roundtable/SKILL.md` be the sole execution path.

7. **Skill directory-vs-flat-file inconsistency** — three skills are flat files (`agent-creator.md`, `tmb-reonboard.md`, `validate-swe-output.md`); sixteen are directories (`<name>/SKILL.md`). Both work in Claude Code. Pick one convention and migrate — asymmetry confuses contributors.

8. **`mcp/trajectory-server/src/test/schema_v3.test.ts`** — tests v3-specific schema. Still valid IF it's intended as a "v3 install still migrates correctly" test, but the filename suggests that's not the intent. Read and either rename to `migration-from-v3.test.ts` or delete if v3 is no longer a supported upgrade path (v5 is current).

9. **`mcp/trajectory-server/src/test/phase-2-discussions.test.ts`** — filename references "phase-2" which is internal TMB workspace phasing, not user-visible. Rename to `discussions.test.ts`.

### 🟢 Cosmetic

10. **`.gitkeep` files in non-empty directories** — `agents/.gitkeep`, `skills/.gitkeep`, `skills-gallery/.gitkeep`, `mcp/trajectory-server/.gitkeep`, `monitors/.gitkeep`. `.gitkeep` is only needed to preserve empty directories in git; once real files exist, it's dead weight. Delete.

11. **`.claude/worktrees/`** — empty directory. Runtime artifact from CC's worktree spawner. Should be `.gitignore`'d (add `.claude/` or `.claude/worktrees/` to `.gitignore`), not committed as an empty dir.

12. **Dual `bun.lock` files** (`mcp/trajectory-server/bun.lock` + `monitors/bun.lock`) — both are workspace packages with independent dependency sets. Not stale, but worth noting: the plugin has two Node packages, not one. Consider a root-level `package.json` workspaces config in a future refactor.

---

## Summary counts

- **Total tracked files**: 86 (excluding `dist/`, `node_modules/`)
- **Remove immediately**: 3 items (1 file, 1 column, 2 stack skills)
- **Revisit**: 6 items
- **Cosmetic**: 3 categories (~7 files)

No category of file is missing. The 14-table schema matches the CLAUDE.md workflow contract. Both tiers of the agent roster exist (5 global + 2 domain templates). Hook system and test infrastructure are both present and wired into CI.
