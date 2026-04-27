# Plugin File Map

Every tracked file in `plugin/` with its purpose. Regenerate after any restructure.

Last refresh: 2026-04-24 on `chore/multi-platform-placeholders` (v0.1.2).

> **Bro-as-planner doctrine + Lego templates + multi-platform placeholders.**
> The plugin ships ZERO subagents. `bro` is a CLAUDE.md persona on main
> Claude. Every other agent (swe, pr-reviewer, architect, cto, ceo, pm,
> any domain consultant) lives as a Lego template that bro copies into
> `<project>/.claude/agents/` on demand. Multi-platform adapter dirs
> (`.codex-plugin/`, `.cursor-plugin/`, `.opencode/`, `gemini-extension.json`)
> are present as **placeholders only** — see [`docs/multi-platform.md`](../multi-platform.md).

## Tree (excluding `node_modules/`, `dist/`, `.git/`, `*.lock*`, local `.trajectory.db`)

```
plugin/
├── # Per-platform adapters (only Claude Code is implemented today)
├── .claude-plugin/
│   └── plugin.json                   # native CC plugin manifest (name, version, deps, provides)
├── .codex-plugin/                    # PLACEHOLDER — OpenAI Codex adapter
│   ├── README.md
│   └── plugin.json
├── .cursor-plugin/                   # PLACEHOLDER — Cursor adapter
│   ├── README.md
│   └── plugin.json
├── .opencode/                        # PLACEHOLDER — OpenCode adapter
│   └── README.md
├── gemini-extension.json             # PLACEHOLDER — Gemini CLI manifest
│
├── # Per-platform persona / context loading files
├── CLAUDE.md                         # auto-loaded bro persona for Claude Code (canonical)
├── CODEX.md                          # PLACEHOLDER — Codex persona
├── CURSOR.md                         # PLACEHOLDER — Cursor persona
├── GEMINI.md                         # PLACEHOLDER — Gemini CLI persona
│
├── # Repo metadata
├── .github/
│   └── workflows/
│       └── test.yml                  # CI: bun build + MCP tests + hook tests on PR → dev
├── .gitignore                        # ignores .claude/, *.db variants, node_modules/, dist/, editor cruft
├── .mcp.json                         # registers bundled MCP server with Claude Code
├── CHANGELOG.md                      # user-facing release notes (keep-a-changelog)
├── CONTRIBUTING.md                   # branch workflow, pre-PR checklist, design principles
├── LICENSE                           # MIT
├── README.md                         # project README + quickstart
│
├── # Plugin runtime — workflow backbone agents (always global, project can override per-name)
├── agents/                           # 2 backbone agents — auto-discovered by CC, no copy step
│   ├── pr-reviewer.md                # push gate — runs at git push over batch of unsigned tasks
│   └── swe.md                        # executor — one task per spawn, isolated worktree, atomic close
│
├── # Plugin runtime — skills (all global; project can override per-name)
├── skills/                           # tmb_* protocol skills + default workflow skills (lazy-loaded)
│   ├── # Protocol skills (immutable, plugin-owned, can't be overridden by name)
│   ├── tmb_agent-creator/            # propose & write new agent files on user approval (template-copy or from-scratch)
│   ├── tmb_branch-id-proposal/       # bro derives branch_id + opens MCP issue before loading planning skill
│   ├── tmb_concerns-protocol/        # how bro raises a concern when doubting the Human's plan (surface or spawn consultant)
│   ├── tmb_create-hook/              # how to add a new hook script safely
│   ├── tmb_feedback-loop/            # bro ↔ swe ↔ pr-reviewer retry/escalation protocol
│   ├── tmb_headless-fallback/        # AskUserQuestion error / TMB_HEADLESS=1 fallback doctrine + per-skill defaults audit
│   ├── tmb_lazy-regen-check/         # bro's session-start architecture-regen heuristic (25-commit threshold)
│   ├── tmb_mcp-error-handling/       # is_error halt rule + forbidden-tools list + policy-key writes
│   ├── tmb_planning-difficult/       # bro's planning protocol when triage=difficult (env probe + Q+A + ADR + verification)
│   ├── tmb_planning-simple/          # bro's planning protocol when triage=simple (defaults table + batched handoff + verification)
│   ├── tmb_project-prescan/          # bro's deterministic inventory pass on first code-touching ask
│   ├── tmb_push-gate/                # push-gate orchestration: spawn pr-reviewer per unsigned task at git push time
│   ├── tmb_refresh-architecture/     # user-facing "regenerate architecture docs" entry
│   ├── tmb_reonboard/                # configure or change branching model / PR target / protected branches / identity name
│   ├── tmb_roundtable/               # multi-agent debate coordinator (≥2 planning-capable consultants required)
│   ├── tmb_roundtable-cleanup/       # post-roundtable archive + DB cleanup
│   ├── tmb_skill-creator/            # propose & write new skill files; appends to consuming agent's skills:
│   ├── tmb_swe-spawn-workflow/       # bro's protocol for spawning SWE with task_id + spec
│   ├── # Default workflow skills (used by global agents; project overrides per-name)
│   ├── code-quality/                 # generic quality gates (error handling, security, edges)
│   ├── docs-conventions/             # docs-update rules + prompt-editing discipline
│   ├── git-conventions/              # emoji-prefixed commits, branch naming
│   ├── naming-conventions/           # file/variable/test naming rules
│   ├── review-findings/              # pr-reviewer output format
│   ├── review-protocol/              # pr-reviewer full protocol
│   └── swe-checklist/                # SWE pre-commit checklist (lazy-loaded by SWE on demand)
│
├── # Consultant templates (opt-in — copied per-project on first request via tmb_agent-creator)
├── templates/
│   ├── agents/                       # 4 consultant templates (≤30 lines each, lint-enforced)
│   │   ├── architect.md              # consultant — system-design analysis, on-demand
│   │   ├── ceo.md                    # consultant — product scope, prioritization, business framing
│   │   ├── cto.md                    # consultant — tech strategy, scaling, stack trade-offs
│   │   └── pm.md                     # consultant — product strategy, user-need framing
│   │
│   └── docs-trustmybot/              # seeded docs skeleton for downstream projects
│       ├── architecture/
│       │   ├── auto/                 # regenerated from file_registry (do not edit)
│       │   │   ├── changelog.md
│       │   │   ├── codebase-tree.md
│       │   │   ├── erd.md
│       │   │   └── module-graph.md
│       │   ├── manual/               # hand-curated (consultants own)
│       │   │   ├── decisions/0001-example.md   # ADR template
│       │   │   ├── data-flow.md
│       │   │   ├── infrastructure.md
│       │   │   └── security-model.md
│       │   └── README.md             # auto vs manual rules
│       └── snapshots/.gitkeep        # for issue_snapshot_md output
│
├── # Hooks (PreToolUse / WorktreeCreate)
├── hooks/
│   └── hooks.json                    # CC hooks manifest (matchers + script paths)
├── scripts/
│   └── hooks/
│       ├── diagnostic/
│       │   ├── probe-bash.sh         # Issue #14 subagent Bash-bypass probe
│       │   └── README.md             # diagnostic usage guide
│       ├── lib/
│       │   └── query-task.sh         # shared sqlite helpers (tmb_db_path, tmb_task_spec_status, …)
│       ├── create-worktree.sh        # WorktreeCreate hook (workaround CC #27134/#44965)
│       ├── git-guards.sh             # protected-branch block, force-push block, dual-tier dev→main exception (v0.1.1)
│       ├── git-push-guard.sh         # blocks `git push` on unsigned commits — replaces require-review-sign.sh
│       └── require-task-spec.sh      # block SWE spawn unless task_id references a valid DB row
│
├── # Bundled MCP server — SQLite trajectory persistence
├── mcp/
│   └── trajectory-server/
│       ├── .gitignore                # dist/, node_modules/, *.db variants
│       ├── README.md                 # MCP server build/test/run instructions
│       ├── bun.lock                  # dependency lockfile
│       ├── package.json              # @modelcontextprotocol/sdk; SQLite via Node stdlib (node:sqlite)
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
│           ├── test/                 # node:test unit tests
│           │   ├── agent-scope.test.ts
│           │   ├── architecture-regen.test.ts
│           │   ├── changelog.test.ts
│           │   ├── codebase-tree.test.ts
│           │   ├── config_keys_contract.test.ts
│           │   ├── config.test.ts
│           │   ├── db-path.test.ts
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
│               ├── discussions.ts    # discussion_append, discussion_list (requireRoles on append)
│               ├── file-registry.ts  # file_registry_scan_commits, file_registry_list
│               ├── identity.ts       # identity_get, identity_set
│               ├── index.ts          # registerTools() — wires every family into server
│               ├── issues.ts         # issue_create/get/resume/close/snapshot_md (requireRoles on writes)
│               ├── ledger.ts         # ledger_log, ledger_list
│               ├── regen-state.ts    # regen_state_get/update — cursor for lazy regen
│               ├── reports.ts        # issue_report_md — full-issue narrative builder
│               ├── skills.ts         # skill registry + effectiveness tracking
│               ├── tasks.ts          # task_create_batch, task_get, task_update_status (requireRoles)
│               └── validation.ts     # validation_record (requireRoles=['pr-reviewer']), validation_history
│
├── # Cross-platform strategy doc
├── docs/
│   ├── multi-platform.md             # how the per-platform adapter pattern works
│   └── architecture/                 # contributor-facing reference
│       ├── ERD.md                    # SQLite schema: Mermaid ER diagram + FK + soft-ref tables
│       ├── FILES.md                  # this file
│       └── FLOWS.md                  # workflow flowcharts
│
└── # Test infrastructure
    └── tests/
        ├── README.md                 # contributor testing guide
        ├── run-all.sh                # lint + MCP integration + hook suites; exit 0 only if all pass
        ├── lint/
        │   ├── agent-line-budget.sh           # template-agent ≤30-line cap
        │   └── onboarding-skill-contract.sh   # required onboarding-skill assertions
        ├── mcp-integration/
        │   ├── agent-bro-planner-workflow.test.mjs
        │   ├── agent-bro-workflow.test.mjs
        │   ├── agent-pr-reviewer-workflow.test.mjs
        │   ├── agent-swe-workflow.test.mjs
        │   ├── harness.mjs
        │   ├── role-matrix.test.mjs
        │   ├── run.sh
        │   ├── schema-contract.test.mjs
        │   └── scope-gate.test.mjs
        ├── hooks/
        │   ├── git-guards.test.sh
        │   ├── require-task-spec.test.sh
        │   └── run.sh                # aggregator
        ├── lib/
        │   └── assert.sh             # shared assertion helpers
        └── manual/
            ├── README.md
            ├── scenarios.md          # Layer 3 dogfood test plan (refresh tracked in #51)
            └── setup.md              # scratch-project scaffold for manual runs
```

## Open issues touching file-map concerns

- **#14** — subagent Bash may bypass PreToolUse hooks (diagnostic harness shipped at `scripts/hooks/diagnostic/`)
- **#51** — `tests/manual/scenarios.md` template-rewrite for the bro-as-planner chain
- **#57 / #67 / #68** — roundtable persistence: skill writes summaries to `ledger`; structured `roundtables` + `roundtable_votes` tables exist in schema but no MCP tool wrappers yet

## Summary

- **Two-layer agent model.** Bro is a CLAUDE.md persona. Backbone agents (`swe`, `pr-reviewer`) ship globally in `agents/`. Consultants (`architect`, `cto`, `ceo`, `pm`) ship as templates in `templates/agents/`, instantiated per-project on demand.
- **23 skills total** in `skills/`: 16 protocol skills (`tmb_*`, plugin-owned) + 7 default workflow skills (overridable by name in `<project>/.claude/skills/`).
- **5 hook scripts** (`git-guards`, `git-push-guard`, `require-task-spec`, `create-worktree`, `diagnostic/probe-bash`)
- **14-table SQLite schema** via `node:sqlite` (Node stdlib, no native deps; Node ≥22 required) — see [`ERD.md`](ERD.md).
- **Test layers (L0-L5)**: see [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) and [`../../tests/run-all.sh`](../../tests/run-all.sh). 10 lint scripts + 245 MCP unit + 43 MCP integration + 27 hook unit + 10-item manual checklist + Docker install-smoke + post-tag canary.
- **Multi-platform structure** present as placeholders; only `.claude-plugin/` is implemented (see [`../multi-platform.md`](../multi-platform.md)).
