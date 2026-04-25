# Plugin File Map

Every tracked file in `plugin/` with its purpose. Regenerate after any restructure.

Last refresh: 2026-04-23 on `chore/23-stale-cleanup`.

> **Roster updated post `feat/bro-as-planner` + cleanup.** The plugin ships
> only `bro` (persona, defined in `CLAUDE.md`), `swe`, and `pr-reviewer`.
> Consultants are project-local and generated on demand via `agent-creator`.

## Tree (excluding `node_modules/`, `dist/`, `.git/`, `*.lock*`, local `.trajectory.db`)

```
plugin/
├── .claude-plugin/
│   ├── marketplace.json              # marketplace entry for the trustmybot channel
│   └── plugin.json                   # native CC plugin manifest (name, version, deps, provides)
├── .github/
│   └── workflows/
│       └── test.yml                  # CI: bun build + MCP tests + hook tests on PR → dev
├── .gitignore                        # ignores .claude/, *.db variants, node_modules/, dist/, editor cruft
├── .mcp.json                         # registers bundled MCP server with Claude Code
├── CHANGELOG.md                      # user-facing release notes (keep-a-changelog)
├── CLAUDE.md                         # auto-loaded plugin rules, agent roster, mode rules
├── CONTRIBUTING.md                   # branch workflow, pre-PR checklist, design principles
├── LICENSE                           # MIT
├── README.md                         # project README
│
├── agents/                           # plugin-shipped subagents (bro is main-Claude persona, defined in CLAUDE.md)
│   ├── pr-reviewer.md                # pre-commit/pre-push review gate (read-only)
│   └── swe.md                        # single-task executor in worktree
│   # consultants (architect, cto, ceo, domain experts) are NOT shipped —
│   # bro generates them on demand into <project>/.claude/agents/ via the
│   # agent-creator skill, with explicit Human approval each time.
│
├── docs/
│   └── architecture/                 # contributor-facing reference
│       ├── ERD.md                    # SQLite schema: Mermaid ER diagram + FK + soft-ref tables
│       ├── FILES.md                  # this file — every tracked file with its purpose
│       ├── FLOWS.md                  # 9 workflow flowcharts (onboarding → roundtable)
│       └── SCENARIOS.md              # dogfood test plan — trigger prompts mapped to each flow
│
├── hooks/
│   └── hooks.json                    # CC hooks manifest (PreToolUse, WorktreeCreate, etc.)
│
├── mcp/
│   └── trajectory-server/            # bundled Node MCP server (SQLite-backed)
│       ├── .gitignore                # dist/, node_modules/, *.db variants
│       ├── README.md                 # MCP server build/test/run instructions
│       ├── bun.lock                  # dependency lockfile
│       ├── package.json              # @modelcontextprotocol/sdk + better-sqlite3
│       ├── tsconfig.json             # strict TS, emits to dist/
│       │
│       ├── docs/
│       │   └── CONFIG_KEYS.md        # canonical list of plugin_config keys
│       │
│       └── src/
│           ├── db.ts                 # opens DB, applies schema.sql
│           ├── index.ts              # MCP server entrypoint (stdio transport)
│           ├── schema.sql            # authoritative schema DDL (14 tables, schema_version=1 baseline)
│           ├── types.ts              # shared TS types (Issue, Task, Discussion, …)
│           │
│           ├── middleware/
│           │   └── agent-scope.ts    # AgentRole type, normalizeAgent, requireRoles, redact helpers
│           │
│           ├── regen/
│           │   ├── git-walker.ts     # lazy git-log diff walker → file_registry
│           │   └── ts-import-parser.ts # extracts imports/exports for module-graph renderer
│           │
│           ├── renderers/
│           │   ├── changelog.ts      # docs/trustmybot/architecture/auto/changelog.md
│           │   ├── codebase-tree.ts  # codebase-tree.md renderer
│           │   ├── erd.ts            # erd.md renderer (Mermaid ER)
│           │   ├── module-graph.ts   # module-graph.md renderer (Mermaid graph)
│           │   └── types.ts          # shared renderer types
│           │
│           ├── test/                 # node:test unit tests (245 passing)
│           │   ├── agent-scope.test.ts
│           │   ├── architecture-regen.test.ts
│           │   ├── changelog.test.ts
│           │   ├── codebase-tree.test.ts
│           │   ├── config_keys_contract.test.ts
│           │   ├── config.test.ts
│           │   ├── db.test.ts
│           │   ├── discussions.test.ts       # end-to-end discussion tools + snapshot
│           │   ├── erd.test.ts
│           │   ├── file-registry.test.ts
│           │   ├── helpers.ts                # tempDB(), createIssue(), createTask()
│           │   ├── identity.test.ts
│           │   ├── issues.test.ts
│           │   ├── ledger.test.ts
│           │   ├── module-graph.test.ts
│           │   ├── regen-state.test.ts
│           │   ├── remaining_tools.test.ts   # audit, validation, skills, reports
│           │   ├── schema.test.ts            # current-schema contract
│           │   └── tasks.test.ts
│           │
│           └── tools/                # MCP tool families (one file per domain)
│               ├── architecture-regen.ts  # orchestrator: file-registry scan + 4 renderers
│               ├── audit.ts          # audit_log, audit_list
│               ├── config.ts         # plugin_config get/set/list
│               ├── discussions.ts    # discussion_append, discussion_list
│               ├── file-registry.ts  # file_registry_scan_commits, file_registry_list
│               ├── identity.ts       # identity_get, identity_set
│               ├── index.ts          # registerTools() — wires every family into server
│               ├── issues.ts         # issue_create/get/resume/close/snapshot_md
│               ├── ledger.ts         # ledger_log, ledger_list
│               ├── regen-state.ts    # regen_state_get/update — cursor for lazy regen
│               ├── reports.ts        # issue_report_md — full-issue narrative builder
│               ├── skills.ts         # skill registry + effectiveness tracking
│               ├── tasks.ts          # task_create_batch, task_get, task_update_status, …
│               └── validation.ts     # validation_record, validation_history
│
├── monitors/                         # background status-line process
│   ├── bun.lock
│   ├── monitors.json                 # CC monitor manifest
│   ├── package.json                  # better-sqlite3 for read-only DB tail
│   └── tmb-trajectory-events.js      # emits [TMB] status lines from ledger events
│
├── scripts/
│   └── hooks/                        # shell hook scripts invoked by hooks.json
│       ├── diagnostic/
│       │   ├── probe-bash.sh         # Issue #14 subagent Bash-bypass probe
│       │   └── README.md             # diagnostic usage guide
│       ├── lib/
│       │   └── query-task.sh         # shared sqlite helpers (tmb_db_path, tmb_task_spec_status, …)
│       ├── create-worktree.sh        # WorktreeCreate hook (workaround CC #27134/#44965)
│       ├── git-guards.sh             # protected-branch block, force-push block
│       ├── require-review-sign.sh    # block push until pr-reviewer signs completed tasks
│       └── require-task-spec.sh      # block SWE spawn unless task_id references a valid DB row
│
├── skills/                           # Claude Code skills — all <name>/SKILL.md form
│   ├── agent-creator/SKILL.md        # propose & write new agent files on user approval
│   ├── architect-workflow/SKILL.md   # architect's end-to-end task-authoring flow
│   ├── branch-id-proposal/SKILL.md   # bro derives branch_id + opens MCP issue before architect spawn
│   ├── code-quality/SKILL.md         # generic quality gates (error handling, security, edges)
│   ├── create-hook/SKILL.md          # how to add a new hook script safely
│   ├── docs-conventions/SKILL.md     # docs-update rules + prompt-editing discipline
│   ├── feedback-loop/SKILL.md        # architect ↔ SWE retry/escalation protocol
│   ├── first-run-onboarding/SKILL.md # bro's identity + branching-model capture flow on first activation
│   ├── git-conventions/SKILL.md     # emoji-prefixed commits, branch naming
│   ├── lazy-regen-check/SKILL.md     # bro's session-start architecture-regen heuristic (25-commit threshold)
│   ├── naming-conventions/SKILL.md   # file/variable/test naming rules
│   ├── project-prescan/SKILL.md      # bro's deterministic inventory pass on first code-touching ask
│   ├── tmb_refresh-architecture/SKILL.md # user-facing "regenerate architecture docs" entry
│   ├── review-findings/SKILL.md      # pr-reviewer output format
│   ├── review-protocol/SKILL.md      # pr-reviewer full protocol
│   ├── roundtable/SKILL.md           # multi-agent debate coordinator
│   ├── roundtable-cleanup/SKILL.md   # post-roundtable DB cleanup
│   ├── swe-checklist/SKILL.md        # SWE pre-commit checklist
│   ├── swe-spawn-workflow/SKILL.md   # architect's protocol for spawning SWE
│   ├── tmb_reonboard/SKILL.md        # re-run onboarding flow + mid-session identity rename
│   └── validate-swe-output/SKILL.md  # fork Explore to verify SWE task
│
├── templates/
│   └── docs-trustmybot/              # seeded docs skeleton for downstream projects
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
    ├── README.md                     # contributor testing guide
    ├── run-all.sh                    # MCP + hook suites; exit 0 only if all pass
    ├── hooks/
    │   ├── git-guards.test.sh
    │   ├── require-review-sign.test.sh
    │   ├── require-task-spec.test.sh
    │   └── run.sh                    # aggregator
    └── lib/
        └── assert.sh                 # shared assertion helpers
```

## Open issues touching file-map concerns

- **#14** — subagent Bash may bypass PreToolUse hooks (diagnostic harness shipped at `scripts/hooks/diagnostic/`)
- (closed by this PR: #29 — DB now project-local at `<cwd>/.claude/tmb/trajectory.db`)

## Summary

- 4 global workflow agents (bro, architect, swe, pr-reviewer)
- 17 skills, all in `<name>/SKILL.md` form
- 4 hook scripts + 1 diagnostic harness
- 14-table SQLite schema (see `ERD.md`)
- 245 MCP unit tests + 16 hook unit tests — all green on every PR to `dev`
