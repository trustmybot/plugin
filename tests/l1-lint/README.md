# L1 — Lint

Fast, free, deterministic guards run before any heavier layer. Each script is a single-purpose check that catches a class of drift — stale versions, broken links, doctrine-doc parity, prompt-surface regressions — in milliseconds. They run together via the L1 step of `tests/run-all.sh`; each is also runnable standalone. `fixtures/` holds sample inputs some checks lint against.

Run one directly:

```bash
bash tests/l1-lint/link-check.sh
```

## Checks by theme

### Version & release integrity
| Script | Catches |
|---|---|
| [`version-sync.sh`](./version-sync.sh) | Version drift across manifest/package files |
| [`changelog-current.sh`](./changelog-current.sh) | CHANGELOG missing the current version; a malformed `changelog.d/` fragment; a feature branch that edits `CHANGELOG.md` alongside a fragment or (after the cut-over) at all, or cites a `GH <n>` with no fragment or entry |
| [`dist-fresh.sh`](./dist-fresh.sh) | Committed `dist/` out of sync with source |
| [`tsc-noemit.sh`](./tsc-noemit.sh) | TypeScript type errors (no emit) |
| [`release-script-safety.sh`](./release-script-safety.sh) | Unsafe patterns in release scripts |
| [`ci-workflow-refs-exist.sh`](./ci-workflow-refs-exist.sh) | CI workflow references that don't resolve |

### Docs & doctrine parity
| Script | Catches |
|---|---|
| [`link-check.sh`](./link-check.sh) | Broken relative markdown links |
| [`enums-stable.sh`](./enums-stable.sh) | Code and `docs/contributing/ENUMS.md` disagreeing, either way, on eight enums (`audit.event_type`, `audit.from_node`, `tasks.status`, `issues.status`, `validation_attempts.verdict`, `discussions.kind`, `milestones.state`, `agent_runs.usage_source`) across `mcp/trajectory-server/src/` and `scripts/`: an undocumented literal, or a documented value no code uses unless its row is marked `reserved` (literal extraction in `enums-stable-extract.pl`; every run self-tests `fixtures/enums-stable/`) |
| [`erd-doc-fresh.sh`](./erd-doc-fresh.sh) | The generated part of `docs/architecture/ERD.md` (mermaid diagram, column tables, foreign keys, search indexes, index list, eval-mode tables) or its `schema_version` token differing from `src/schema.sql`, `src/schema-eval.sql` and `TARGET_SCHEMA_VERSION` (regenerate with `scripts/maintenance/gen-erd-doc.mjs`; every run self-tests a dropped row and a stale version) |
| [`config-keys-doc-fresh.sh`](./config-keys-doc-fresh.sh) | The generated key table in `docs/reference/CONFIG_KEYS.md` differing from the `plugin_config` keys the code reads and writes, or a key with no `KEYS` entry in `scripts/maintenance/gen-config-keys-doc.mjs` (regenerate with that script) |
| [`tool-families-documented.sh`](./tool-families-documented.sh) | A tool module or tool registered in `mcp/trajectory-server/src/tools/index.ts` missing from `mcp/trajectory-server/README.md`, `src/tools/README.md` or the `docs/reference/REFERENCE.md` tool list (or a wrong tool count there) |
| [`hooks-doc-fresh.sh`](./hooks-doc-fresh.sh) | The `docs/reference/REFERENCE.md` hook table and `hooks/hooks.json` disagreeing: a row naming a script missing from `scripts/hooks/` or not registered (a deleted hook leaving a stale row), or a registered hook with no row |
| [`enums-doc-fresh.sh`](./enums-doc-fresh.sh) | The generated `audit.event_type` table in `ENUMS.md` or `scripts/hooks/lib/audit-events.txt` differing from `mcp/trajectory-server/src/audit-events.ts` (regenerate with `scripts/maintenance/gen-enums-doc.mjs`) |
| [`labels-stable.sh`](./labels-stable.sh) | Labels drifting from `docs/contributing/LABELS.md` (skips without an authenticated `gh` or with `TMB_L1_OFFLINE=1`) |
| [`stale-framing-prose.sh`](./stale-framing-prose.sh) | Outdated framing prose in docs |

### Prompt-surface hygiene (agents, skills, commands)
| Script | Catches |
|---|---|
| [`agent-line-budget.sh`](./agent-line-budget.sh) | Agent prompt files over their line cap |
| [`agent-task-brief-contract.sh`](./agent-task-brief-contract.sh) | Agent/task-brief contract drift |
| [`agent-template-byte-identity.sh`](./agent-template-byte-identity.sh) | Shipped vs template agent byte mismatch |
| [`command-frontmatter.sh`](./command-frontmatter.sh) | Malformed command frontmatter |
| [`skill-frontmatter.sh`](./skill-frontmatter.sh) | Malformed skill frontmatter |
| [`skill-catalog-sync.sh`](./skill-catalog-sync.sh) | Skill catalog out of sync with skill dirs |
| [`tool-description-budget.sh`](./tool-description-budget.sh) | MCP tool descriptions over budget |
| [`no-citations-in-prompts.sh`](./no-citations-in-prompts.sh) | Issue #s / PR URLs leaking into prompt files |
| [`no-negative-directives.sh`](./no-negative-directives.sh) | Negative ("never…") directives in prompts |
| [`local-agent-primitives.sh`](./local-agent-primitives.sh) | Local-agent primitive usage |

### Source & schema invariants
| Script | Catches |
|---|---|
| [`no-bare-role-compare.sh`](./no-bare-role-compare.sh) | Bare role-string comparisons instead of requireRoles |
| [`gate-read-sql-readonly.sh`](./gate-read-sql-readonly.sh) | SQL handed to `tmb_gate_read` / `tmb_sqlite_ro`, or a data-contract `sql`, that is not read-only (`SELECT`, `WITH`, or a read of `journal_mode` / `user_version` / `table_info`), and a hook calling `sqlite3 -readonly` outside `lib/query-task.sh`; every run self-tests `fixtures/gate-read-sql-readonly/` |
| [`no-raw-sql-interpolation.sh`](./no-raw-sql-interpolation.sh) | Raw SQL string interpolation (allowlist: `no-raw-sql-interpolation.allowlist`, entries `<file>@<function>`, `<file>:<line>` or `<file>`; a missing function fails; every run self-tests `fixtures/no-raw-sql-interpolation/`) |
| [`no-destructive-sql.sh`](./no-destructive-sql.sh) | Destructive SQL statements |
| [`no-direct-sqlite-write.sh`](./no-direct-sqlite-write.sh) | A `sqlite3` write under `scripts/` that bypasses the write library (`scripts/hooks/lib/db-write.sh`) |
| [`no-private-db-path.sh`](./no-private-db-path.sh) | A `trajectory.db` literal under `scripts/` outside `scripts/hooks/lib/query-task.sh` — a private copy of the DB-path rule (allowlist: `no-private-db-path.allowlist`) |
| [`no-home-writes.sh`](./no-home-writes.sh) | A write under the home directory from `scripts/` or `mcp/trajectory-server/src/` — project state belongs in `<project>/.claude/<plugin>/`; only `TMB_MODEL_CACHE_DIR` lives outside (allowlist: `no-home-writes.allowlist`; `--self-test` runs `fixtures/no-home-writes/`) |
| [`no-tmp-writes.sh`](./no-tmp-writes.sh) | A write to a hard-coded `/tmp`, `/private/tmp` or `/var/tmp` path from `scripts/`, `skills/`, `agents/`, `commands/` or `mcp/trajectory-server/src/` — scratch files go under `$TMPDIR` (reads and `${TMPDIR:-/tmp}` fallbacks are fine; allowlist: `no-tmp-writes.allowlist`; `--self-test` runs `fixtures/no-tmp-writes/`, then every other L1 lint under an empty HOME with `gh`/`glab`/`claude` stubbed and `TMB_L1_OFFLINE=1`, failing on any write under that HOME but the embedding model cache) |
| [`no-module-load-writes.sh`](./no-module-load-writes.sh) | A filesystem write (`mkdirSync`, `writeFileSync`, `appendFileSync`, `rmSync`, `renameSync`, `copyFileSync`, `openSync(..., 'w')`) that runs when a `mcp/trajectory-server/src/` module is imported — at module scope, in a top-level block, or in a top-level `const`/`let` initializer; the entry points `src/index.ts` and `src/codex.ts` are exempt (every run self-tests `fixtures/no-module-load-writes/`; `--self-test` runs only that) |
| [`no-unpinned-scan-in-tests.sh`](./no-unpinned-scan-in-tests.sh) | A `mcp/trajectory-server/src/test/` file (outside `fixtures/`) that references `scan.sh`, `scan_run` or `project_scan` without `TRAJECTORY_DB_PATH` or `pinScanEnv` — an unpinned scan.sh fork walks up to the live project trajectory DB (`--self-test` runs `fixtures/unpinned-scan/`) |
| [`no-datetime-now-in-hooks.sh`](./no-datetime-now-in-hooks.sh) | `datetime('now')` timestamps under `scripts/` and in `mcp/trajectory-server/src/` `*.ts` / `*.sql` (exempt: `migrateV*` bodies in `db.ts` and the `src/test/` fixtures) — use `tmb_now_iso`, `nowISO()` or `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| [`no-audit-log-kind.sh`](./no-audit-log-kind.sh) | Disallowed audit-log `kind` usage |
| [`no-audit-log-without-from-node.sh`](./no-audit-log-without-from-node.sh) | Audit-log writes missing `from_node` |
| [`no-directories-table-refs.sh`](./no-directories-table-refs.sh) | References to the retired directories table |
| [`no-file-registry-refs.sh`](./no-file-registry-refs.sh) | References to the retired file registry |
| [`rag-schema-invariants.sh`](./rag-schema-invariants.sh) | RAG/embedding schema invariants |
| [`manifest-shape.sh`](./manifest-shape.sh) | Plugin manifest shape; `claude plugin validate --strict` findings when the `claude` CLI is on PATH and the run is not offline (`TMB_L1_OFFLINE` / `TMB_FORBID_LIVE_SYNC`) |
| [`codex-scope4-contract.sh`](./codex-scope4-contract.sh) | Exact Codex Agent catalog, sandbox defaults, MCP isolation, and 15-tool surface |
| [`valid-permission-decisions.sh`](./valid-permission-decisions.sh) | Invalid hook permission decisions |

### Hooks, toolchain & secrets
| Script | Catches |
|---|---|
| [`hooks-executable.sh`](./hooks-executable.sh) | Hook scripts missing the executable bit |
| [`hook-onfailure.sh`](./hook-onfailure.sh) | A deny-capable `hooks/hooks.json` registration (its script prints a deny, exits 2, calls a deny helper from a sourced library, or runs a deny-capable script) without `"onFailure": "block"`; warns when an observe-only one carries it. Prints the derived table; `--self-test` checks the fixtures in `fixtures/hook-onfailure/` |
| [`shellcheck-hooks.sh`](./shellcheck-hooks.sh) | Shellcheck violations in hook scripts |
| [`no-grep-q-in-pipelines.sh`](./no-grep-q-in-pipelines.sh) | A `\| grep -q` (or `--quiet`, `egrep`/`fgrep`/`rg -q`) in a `*.sh` under `tests/`, `scripts/` or `hooks/` that sets pipefail, or in any `*.sh` under `scripts/hooks/lib/` or `tests/lib/` (sourced libraries inherit pipefail from their callers) — `grep -q` closes the pipe on the first match, the upstream can die of SIGPIPE and the pipeline fails although the pattern was present; write `cmd \| grep PAT >/dev/null` (`--self-test` runs `fixtures/no-grep-q-in-pipelines/`) |
| [`dir-toolchain.sh`](./dir-toolchain.sh) | Per-directory toolchain expectations |
| [`kuzu-trusted-dep.sh`](./kuzu-trusted-dep.sh) | kuzu trusted-dependency declaration |
| [`symlink-targets.sh`](./symlink-targets.sh) | Symlinks pointing at missing targets |
| [`main-guard-files-present.sh`](./main-guard-files-present.sh) | Required main-guard files present |
| [`no-secrets-in-source.sh`](./no-secrets-in-source.sh) | Secrets committed to source |
| [`no-developer-paths.sh`](./no-developer-paths.sh) | Hardcoded developer/local paths |
| [`no-hardcoded-plugin-name.sh`](./no-hardcoded-plugin-name.sh) | Hardcoded plugin name instead of resolution |
| [`issue-sync-test-isolation.sh`](./issue-sync-test-isolation.sh) | Tests not isolating issue-sync side effects |
