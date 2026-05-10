# Plugin file map

Tracked files in `plugin/` grouped by purpose. Counts are correct as of the current commit; treat the shell (`ls scripts/hooks/*.sh | wc -l` etc.) as the source of truth if this doc drifts.

## Top-level

```
plugin/
├── CLAUDE.md                 # auto-loaded bro persona for Claude Code
├── README.md, CHANGELOG.md, CONTRIBUTING.md, LICENSE
├── .claude-plugin/plugin.json     # Claude Code plugin manifest
├── .codex-plugin/, .cursor-plugin/, .opencode/, gemini-extension.json
│                              # PLACEHOLDERS — see docs/multi-platform.md
├── CODEX.md, CURSOR.md, GEMINI.md  # PLACEHOLDER personas
├── .gitignore, .mcp.json
└── .github/workflows/test.yml      # GH dormant; GitLab CI is canonical
```

## Workflow backbone agents

```
agents/
├── pr-reviewer.md            # push gate — runs at git push over batch of unsigned tasks
└── swe.md                    # executor — one task per spawn, isolated worktree, atomic close
```

`bro` is a `CLAUDE.md` persona on main Claude (no agent file). Backbone agents auto-discover; project can override per-name via `<project>/.claude/agents/<name>.md`.

## Skills (8 total)

```
skills/
├── tmb_planning/             # bro's full code-touching flow
├── tmb_review/               # pr-reviewer judgment + bro push-gate orchestration + PR comment triage
├── tmb_recovery/             # bro's response when AUQ errors / MCP returns is_error / trajectory-server unreachable
├── tmb_concerns-protocol/    # how bro raises a concern when doubting the Human's plan
├── tmb_agent-creator/        # propose & write new agent files on user approval
├── tmb_skill-creator/        # propose & write new skill files
├── tmb_swe-checklist/        # SWE pre-commit judgment checklist
└── tmb_docs-conventions/     # prompt-editing discipline (loaded by SWE on markdown spec files)
```

Slash commands (Human-triggered ceremonies, not skills):

```
commands/
├── onboard.md                # /onboard — auto-fired on first contact + Human-typed for changes
├── roundtable.md             # /roundtable <topic> — multi-agent deliberation
└── monitor.md                # /monitor <PR_number> — PR comment review
```

## Consultant templates

Copied per-project on first request via `tmb_agent-creator`:

```
templates/
├── agents/                   # 4 consultant templates (≤30 lines each, lint-enforced)
│   ├── architect.md, ceo.md, cto.md, pm.md
└── docs-trustmybot/          # seeded docs skeleton for downstream projects
    ├── architecture/auto/    # regen output (changelog, codebase-tree, erd, module-graph)
    ├── architecture/manual/  # hand-curated (decisions/, data-flow, infrastructure, security-model)
    └── snapshots/.gitkeep    # for issue_snapshot_md output
```

## Hooks (30 scripts)

```
hooks/hooks.json              # CC hooks manifest (matchers + script paths)
scripts/hooks/
├── lib/query-task.sh         # shared sqlite helpers
├── diagnostic/               # subagent Bash-bypass probe (#14)
└── *.sh                      # 30 lifecycle hooks
```

Group by event:

| Event | Scripts |
|---|---|
| **SessionStart** | `session-start-prescan`, `session-start-regen-check`, `ensure-gitignore`, `deferred-tools-drift-warn`, `write-active-workspace-sentinel` |
| **UserPromptSubmit** | `activation-routine`, `consultant-spawn-required`, `mcp-health-check`, `session-log-capture` |
| **PreToolUse** | `no-source-edit-from-main`, `no-worktree-branch-create`, `branch-up-to-date-with-remote`, `git-guards`, `git-push-guard`, `commit-msg-lint`, `naming-lint`, `code-quality-lint`, `require-task-spec`, `require-summaries-before-task-close`, `require-feature-branch-active`, `auq-headless-deny`, `askuserquestion-length-lint`, `roundtable-auq-shape`, `greenfield-arch-required`, `debug-trajectory` |
| **PostToolUse** | `cleanup-worktree-on-task-close`, `lazy-regen-postcheck`, `roundtable-cleanup-postcheck` |
| **SubagentStop** | `swe-atomic-close` |
| **WorktreeCreate** | `worktree-create` |

## MCP server

```
mcp/trajectory-server/
├── package.json, tsconfig.json, README.md, bun.lock
├── docs/CONFIG_KEYS.md       # canonical plugin_config key list
└── src/
    ├── db.ts                 # opens DB, applies schema.sql, runs migrations
    ├── index.ts              # MCP server entrypoint (stdio transport)
    ├── schema.sql            # authoritative schema (18 tables)
    ├── schema-eval.sql       # eval-mode-only tables (debug_trajectory, eval_results)
    ├── types.ts              # shared TS types
    ├── middleware/agent-scope.ts    # AgentRole, normalizeAgent, requireRoles, redact
    ├── regen/                # git-walker + ts-import-parser → file_registry feed
    ├── renderers/            # auto-doc generators (changelog/erd/module-graph/codebase-tree)
    ├── sync/                 # gh/glab issue sync (backend.ts + issue_sync.ts)
    ├── tools/                # MCP tool families (one file per domain — see below)
    └── test/                 # node:test unit tests (~480 tests across 35 files)
```

### Tool families

| File | Tools |
|---|---|
| `agents.ts` | `agent_list`, `agent_register` |
| `architecture-regen.ts` | `architecture_regen` |
| `audit.ts` | `audit_log`, `audit_log_list` (event-only since #179) |
| `branch_report_md.ts` | `branch_report_md` |
| `composites.ts` | `branch_id_propose`, `task_retry_batch`, `bro_atomic_close` |
| `config.ts` | `config_get`, `config_set`, `config_list` |
| `discussions.ts` | `discussion_append` (verified_human gate), `discussion_list`, `issue_get_with_discussions` |
| `file-registry.ts` | `file_registry_upsert/list/verify/delete/update_summaries` (bro-only) |
| `identity.ts` | `identity_get`, `identity_set`, `identity_reset` (onboarded-marker only — no name stored) |
| `issues.ts` | `issue_create/get/resume/close/update_description/sync_retry` |
| `onboard.ts` | `onboard_state_get`, `onboard_get_questions`, `onboard_apply` |
| `pr_comments.ts` | `pr_comments_get` (gh + glab backends, bot-filtered) |
| `project-metadata.ts` | `project_metadata_detect` (deterministic stack detection) |
| `regen-state.ts` | `regen_state_get`, `regen_state_set` |
| `reports.ts` | `issue_report_md`, `issue_snapshot_md` |
| `roundtable.ts` | `roundtable_create/vote/close/finalize_decisions/summarize` (state machine) |
| `skills.ts` | `skill_register`, `skill_promote`, `skill_record_outcome` |
| `stats.ts` | `task_stats`, `task_first_actionable` |
| `tasks.ts` | `task_create_batch`, `task_get`, `task_update_status` |
| `validation.ts` | `validation_record` (pr-reviewer-only + subagent_session_id + MCP-availability prefix), `validation_history` |

## Tests

```
tests/
├── README.md, run-all.sh         # L1–L4 aggregator
├── lint/                          # L1 lint scripts
├── mcp-integration/               # L2 — 7 .mjs files
├── hooks/                         # L3 — 23 .test.sh files
├── workflow-sim/                  # L4 — 6 .mjs files
├── dogfood/                       # L5 — claude -p flows
│   ├── run-l5.sh, run-ab.sh
│   ├── flows/                     # per-flow scaffolding
│   ├── fixtures/                  # SQL fixtures (empty, onboarding-named, onboarding-anonymous)
│   ├── lib/                       # flow-helpers, scorers, smoke-helpers
│   └── ab-scenarios/              # historical A/B prompt-eval scenarios
└── manual/                        # L0 install-smoke + manual scenarios
```

## Architecture docs

```
docs/architecture/
├── DETERMINISM.md      # 7 enforcement mechanisms; judgment vs determinism
├── ENFORCEMENT.md      # 6 layers + per-agent × per-interaction coverage matrix
├── RESPONSIBILITIES.md # what bro/swe/pr-reviewer/consultants are actually instructed to do
├── ERD.md              # SQLite schema: Mermaid ER + FK + soft-refs + role × tool matrix
├── FLOWS.md            # workflow flowcharts (canonical chain + per-flow deltas)
├── FILES.md            # this file
├── GIT.md              # git state across a task lifecycle (worktree model)
├── UI.md               # AskUserQuestion modes + constraints
├── project-metadata.md # config keys + project metadata schema
└── manual/decisions/   # ADRs (e.g., 0002-deterministic-stack-detection)
```
