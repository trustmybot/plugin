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
| [`dist-fresh.sh`](./dist-fresh.sh) | Committed `dist/` out of sync with source; installed esbuild version differing from the one `bun.lock` pins |
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
| [`no-cwd-reads.sh`](./no-cwd-reads.sh) | Code under `scripts/`, `skills/*/scripts/`, `mcp/trajectory-server/src/` (tests excluded) or `tests/lib/` finding the project or a repo from the cwd: in shell `$PWD`, `pwd`, the payload `.cwd`, `tmb_payload_cwd`, `tmb_cmd_cwd` or a `git` with no `-C`; in TypeScript `process.cwd()` or a `spawn` / `spawnSync` / `execFile` / `execFileSync` with no `cwd` — canonicalizing a named dir (the self-location form included) and joining a command's relative paths are exempt (GH 1550, GH 1553). Exemptions live in `cwd-allowlist.tsv` (`path<TAB>substring<TAB>category<TAB>reason`, category one of self-location, canonicalize, join-base, anchored-cd, fallback, test-harness, not-location); an entry with no reason, an unknown category or matching no hit fails. Self-test: `tests/l3-integration/hooks/no-cwd-reads-lint.test.sh` |
| [`enums-doc-fresh.sh`](./enums-doc-fresh.sh) | The generated `audit.event_type` table in `ENUMS.md` or `scripts/hooks/lib/audit-events.txt` differing from `mcp/trajectory-server/src/audit-events.ts` (regenerate with `scripts/maintenance/gen-enums-doc.mjs`) |
| [`labels-stable.sh`](./labels-stable.sh) | Labels drifting from `docs/contributing/LABELS.md` (skips without an authenticated `gh` or with `TMB_L1_OFFLINE=1`) |
| [`stale-framing-prose.sh`](./stale-framing-prose.sh) | Outdated framing prose in docs |

### Prompt-surface hygiene (agents, skills, commands)
| Script | Catches |
|---|---|
| [`agent-line-budget.sh`](./agent-line-budget.sh) | Agent prompt files over their line cap |
| [`agent-cache-ttl.sh`](./agent-cache-ttl.sh) | A shipped agent or agent template whose frontmatter lacks `experimental.cacheTtl`, has a value other than `1h` or `5m`, or gives `swe` anything but `1h`; takes an optional plugin-root argument, and `fixtures/agent-cache-ttl/` holds the failure cases |
| [`agent-task-brief-contract.sh`](./agent-task-brief-contract.sh) | Agent/task-brief contract drift |
| [`agent-template-byte-identity.sh`](./agent-template-byte-identity.sh) | Shipped vs template agent byte mismatch |
| [`command-frontmatter.sh`](./command-frontmatter.sh) | Malformed command frontmatter |
| [`skill-frontmatter.sh`](./skill-frontmatter.sh) | Malformed skill frontmatter |
| [`skill-catalog-sync.sh`](./skill-catalog-sync.sh) | Skill catalog out of sync with skill dirs |
| [`tool-description-budget.sh`](./tool-description-budget.sh) | MCP tool descriptions over budget |
| [`no-citations-in-prompts.sh`](./no-citations-in-prompts.sh) | Issue #s / PR URLs leaking into prompt files |
| [`no-negative-directives.sh`](./no-negative-directives.sh) | Negative ("never…") directives in prompts |
| [`no-kuzu-in-prompts.sh`](./no-kuzu-in-prompts.sh) | `kuzu` (any case) in `CLAUDE.md`, `agents/`, `commands/` or a `skills/` `*.md` — the world model is trajectory-DB tables (allowlist: `no-kuzu-in-prompts.allowlist`, entries `<path><TAB><substring><TAB><reason>`; `--self-test` runs `fixtures/kuzu-in-prompts/`) |
| [`onboard-option-wording.sh`](./onboard-option-wording.sh) | An `/onboard` option `label` / `description` (or `BRANCHING_DESCRIPTIONS` entry) in `onboard.ts` that names an internal (trajectory, DB, hook, shim, PreToolUse, KV, wire, mirror, containment) fails; a description over 15 words warns. `--self-test` runs `fixtures/onboard-option-wording/` |
| [`prompt-explicit-paths.sh`](./prompt-explicit-paths.sh) | A relative `.claude/` path, or `git push` / `switch` / `checkout` / `pull` without `-C`, in an agent, command or skill; takes an optional plugin-root argument, and `tests/l3-integration/hooks/prompt-explicit-paths-lint.test.sh` plants the failure cases |
| [`local-agent-primitives.sh`](./local-agent-primitives.sh) | Local-agent primitive usage |

### Source & schema invariants
| Script | Catches |
|---|---|
| [`no-bare-role-compare.sh`](./no-bare-role-compare.sh) | Bare role-string comparisons instead of requireRoles |
| [`gate-read-sql-readonly.sh`](./gate-read-sql-readonly.sh) | SQL handed to `tmb_gate_read` / `tmb_sqlite_ro`, or a data-contract `sql`, that is not read-only (`SELECT`, `WITH`, or a read of `journal_mode` / `user_version` / `table_info`), and a hook calling `sqlite3 -readonly` outside `lib/query-task.sh`; every run self-tests `fixtures/gate-read-sql-readonly/` |
| [`no-raw-sql-interpolation.sh`](./no-raw-sql-interpolation.sh) | Raw SQL string interpolation (allowlist: `no-raw-sql-interpolation.allowlist`, entries `<file>@<function>`, `<file>:<line>` or `<file>`; a missing function fails; every run self-tests `fixtures/no-raw-sql-interpolation/`) |
| [`no-destructive-sql.sh`](./no-destructive-sql.sh) | Destructive SQL statements |
| [`no-direct-sqlite-write.sh`](./no-direct-sqlite-write.sh) | A `sqlite3` write under `scripts/` that bypasses the write library (`scripts/hooks/lib/db-write.sh`) |
| [`sqlite3-needs-timeout.sh`](./sqlite3-needs-timeout.sh) | A `sqlite3` invocation in `scripts/`, `skills/` or `hooks/` shell with no `.timeout` / `busy_timeout` in its command (quoted SQL, `\` continuations and heredoc body included) — the CLI's default busy timeout of 0 fails at once while another session writes; read through `tmb_gate_read` / `tmb_sqlite_ro` / `tmb_db_read_budget`, write through `tmb_db_write`, or pass `-cmd ".timeout ${TMB_DB_WRITE_TIMEOUT_MS:-1500}"` (GH 1624; allowlist `sqlite3-needs-timeout.allowlist`, `path<TAB>substring<TAB>reason`, only for a DB that is not the trajectory DB, a stale or reasonless entry fails; every run self-tests `fixtures/sqlite3-needs-timeout/`) |
| [`sqlite3-fallback-roles.sh`](./sqlite3-fallback-roles.sh) | A `_TMB_FALLBACK_ROLES_<tool>` line in `scripts/lib/sqlite3-fallback.sh` that differs from that tool's `requireRoles` list in `mcp/trajectory-server/src/tools/*.ts` (order included), or names a tool the server does not gate (GH 1624; self-tests against drifted copies every run) |
| [`no-private-db-path.sh`](./no-private-db-path.sh) | A `trajectory.db` literal under `scripts/` outside `scripts/hooks/lib/query-task.sh` — a private copy of the DB-path rule (allowlist: `no-private-db-path.allowlist`) |
| [`no-home-writes.sh`](./no-home-writes.sh) | A write under the home directory from `scripts/` or `mcp/trajectory-server/src/` — project state belongs in `<project>/.claude/<plugin>/`; only `TMB_MODEL_CACHE_DIR` lives outside (allowlist: `no-home-writes.allowlist`; `--self-test` runs `fixtures/no-home-writes/`) |
| [`cli-config-scope.sh`](./cli-config-scope.sh) | A config-changing `claude plugin` / `claude mcp` call (the subcommands and aliases from the CLI's `--help`, listed in the script header) whose last scope flag is not `project`, or one with no scope option at all, in any tracked `*.sh` / `*.mjs` / `*.js` / `*.ts` outside test, `dist/` and `node_modules/` directories — the CLI's defaults reach user scope. Catches path, variable and `command`/`exec`/`VAR=value`-prefixed programs, global options before `plugin`/`mcp`, and variable subcommands (fail closed); read-only calls (`list`, `get`, `details`, `validate`) pass (exempt: `no-home-writes.allowlist`; `--self-test` runs `fixtures/cli-config-scope/`) |
| [`no-tmp-writes.sh`](./no-tmp-writes.sh) | A write to a hard-coded `/tmp`, `/private/tmp` or `/var/tmp` path from `scripts/`, `skills/`, `agents/`, `commands/` or `mcp/trajectory-server/src/` — scratch files go under `$TMPDIR` (reads and `${TMPDIR:-/tmp}` fallbacks are fine; allowlist: `no-tmp-writes.allowlist`; `--self-test` runs `fixtures/no-tmp-writes/`, then every other L1 lint under an empty HOME with `gh`/`glab`/`claude` stubbed and `TMB_L1_OFFLINE=1`, failing on any write under that HOME but the embedding model cache) |
| [`no-bare-mktemp.sh`](./no-bare-mktemp.sh) | A `mktemp` in `tests/` or `scripts/` `*.sh` whose first non-flag argument is not a path template (bare `mktemp`, `mktemp -d`, `mktemp -t X`, `mktemp -d -t X`) or whose template starts at a raw `${TMPDIR…}/` — BSD mktemp ignores `TMPDIR` for those forms and the Bash sandbox denies its default dir, and macOS's `TMPDIR` ends in a slash, so a raw parent yields a `//` that hooks normalise away; use `D=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-<name>.XXXXXX")` (strips every trailing slash) or `$(tmp_footprint_parent)` (GH 1573; allowlist: `no-bare-mktemp.allowlist`, `path<TAB>substring<TAB>reason`, a stale entry fails; `--self-test` runs `fixtures/no-bare-mktemp/`) |
| [`no-module-load-writes.sh`](./no-module-load-writes.sh) | A filesystem write (`mkdirSync`, `writeFileSync`, `appendFileSync`, `rmSync`, `renameSync`, `copyFileSync`, `openSync(..., 'w')`) that runs when a `mcp/trajectory-server/src/` module is imported — at module scope, in a top-level block, or in a top-level `const`/`let` initializer; the entry points `src/index.ts` and `src/codex.ts` are exempt (every run self-tests `fixtures/no-module-load-writes/`; `--self-test` runs only that) |
| [`no-unpinned-scan-in-tests.sh`](./no-unpinned-scan-in-tests.sh) | A `mcp/trajectory-server/src/test/` file (outside `fixtures/`) that references `scan.sh`, `scan_run` or `project_scan` without, outside comments, a `pinScanEnv(` call or a `TRAJECTORY_DB_PATH` assignment — a mention is not a pin; an unpinned scan.sh fork walks up to the live project trajectory DB (`--self-test` runs `fixtures/unpinned-scan/`) |
| [`hook-tests-pin-project.sh`](./hook-tests-pin-project.sh) | A `tests/l3-integration/hooks/*.test.sh` that invokes a hook (`scripts/hooks/<hook>.sh`, `dispatch.sh`, the `lib/query-task.sh` resolver) without setting `CLAUDE_PROJECT_DIR` or `TRAJECTORY_DB_PATH` outside comments — an unpinned hook walks up to the live project trajectory DB (`--self-test` runs `fixtures/hook-tests-pin-project/`) |
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
| [`no-scratch-in-tree.sh`](./no-scratch-in-tree.sh) | A `.tmp-*` dir at the checkout root, on disk or tracked — scratch a test left behind, which a scan could register as a repo; every run self-tests a planted `.tmp-probe/` |
| [`hook-onfailure.sh`](./hook-onfailure.sh) | A deny-capable `hooks/hooks.json` registration (its script prints a deny, exits 2, calls a deny helper from a sourced library, or runs a deny-capable script) without `"onFailure": "block"`; warns when an observe-only one carries it. Prints the derived table; `--self-test` checks the fixtures in `fixtures/hook-onfailure/` |
| [`shellcheck-hooks.sh`](./shellcheck-hooks.sh) | Shellcheck violations in hook scripts |
| [`no-grep-q-in-pipelines.sh`](./no-grep-q-in-pipelines.sh) | A `\| grep -q` (or `--quiet`, `egrep`/`fgrep`/`rg -q`) in a `*.sh` under `tests/`, `scripts/` or `hooks/` that sets pipefail, in any `*/lib/*.sh` under `scripts/` or `tests/` (sourced libraries inherit pipefail from their callers), or in a command string of `tests/l5-l6/l6-chain/chain-manifest.json` (eval'd under pipefail); long options before `-q` (`--fixed-strings -q`), `-e PAT -q` and a line ending in `\|` with grep on the next line are caught too — `grep -q` closes the pipe on the first match, the upstream can die of SIGPIPE and the pipeline fails although the pattern was present; write `cmd \| grep PAT >/dev/null` (`--self-test` runs `fixtures/no-grep-q-in-pipelines/`) |
| [`no-wall-clock-asserts.sh`](./no-wall-clock-asserts.sh) | A test that bounds elapsed wall-clock time: a `$SECONDS` or `date +%s` difference compared with `-lt`/`-le`/`-gt`/`-ge` or in `(( ))` (`*.sh`), or a `Date.now() -` / `performance.now() -` result compared to a numeric literal or passed to `toBeLessThan`-style matchers (`*.ts`/`*.js` under `tests/`, `dashboard/test/`, `mcp/trajectory-server/src/test/`), inline or through a variable assigned from it — such bounds flake under load; assert the timeout path fired instead (GH 1645, GH 1677; allowlist: `no-wall-clock-asserts.allowlist`, `path<TAB>substring<TAB>reason`, a stale entry fails; `--self-test` runs `fixtures/no-wall-clock-asserts/`) |
| [`dir-toolchain.sh`](./dir-toolchain.sh) | Per-directory toolchain expectations |
| [`symlink-targets.sh`](./symlink-targets.sh) | Symlinks pointing at missing targets |
| [`main-guard-files-present.sh`](./main-guard-files-present.sh) | Required main-guard files present |
| [`no-secrets-in-source.sh`](./no-secrets-in-source.sh) | Secrets committed to source |
| [`no-developer-paths.sh`](./no-developer-paths.sh) | Hardcoded developer/local paths |
| [`no-hardcoded-plugin-name.sh`](./no-hardcoded-plugin-name.sh) | Hardcoded plugin name instead of resolution |
| [`issue-sync-test-isolation.sh`](./issue-sync-test-isolation.sh) | Tests not isolating issue-sync side effects |
