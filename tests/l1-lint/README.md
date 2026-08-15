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
| [`changelog-current.sh`](./changelog-current.sh) | CHANGELOG missing the current version |
| [`dist-fresh.sh`](./dist-fresh.sh) | Committed `dist/` out of sync with source |
| [`tsc-noemit.sh`](./tsc-noemit.sh) | TypeScript type errors (no emit) |
| [`release-script-safety.sh`](./release-script-safety.sh) | Unsafe patterns in release scripts |
| [`ci-workflow-refs-exist.sh`](./ci-workflow-refs-exist.sh) | CI workflow references that don't resolve |

### Docs & doctrine parity
| Script | Catches |
|---|---|
| [`link-check.sh`](./link-check.sh) | Broken relative markdown links |
| [`enums-stable.sh`](./enums-stable.sh) | Enum values drifting from `docs/contributing/ENUMS.md` |
| [`labels-stable.sh`](./labels-stable.sh) | Labels drifting from `docs/contributing/LABELS.md` |
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
| [`no-raw-sql-interpolation.sh`](./no-raw-sql-interpolation.sh) | Raw SQL string interpolation (allowlist: `no-raw-sql-interpolation.allowlist`) |
| [`no-destructive-sql.sh`](./no-destructive-sql.sh) | Destructive SQL statements |
| [`no-audit-log-kind.sh`](./no-audit-log-kind.sh) | Disallowed audit-log `kind` usage |
| [`no-audit-log-without-from-node.sh`](./no-audit-log-without-from-node.sh) | Audit-log writes missing `from_node` |
| [`no-directories-table-refs.sh`](./no-directories-table-refs.sh) | References to the retired directories table |
| [`no-file-registry-refs.sh`](./no-file-registry-refs.sh) | References to the retired file registry |
| [`rag-schema-invariants.sh`](./rag-schema-invariants.sh) | RAG/embedding schema invariants |
| [`manifest-shape.sh`](./manifest-shape.sh) | Plugin manifest shape |
| [`codex-scope4-contract.sh`](./codex-scope4-contract.sh) | Exact Codex Agent catalog, sandbox defaults, MCP isolation, and 15-tool surface |
| [`valid-permission-decisions.sh`](./valid-permission-decisions.sh) | Invalid hook permission decisions |

### Hooks, toolchain & secrets
| Script | Catches |
|---|---|
| [`hooks-executable.sh`](./hooks-executable.sh) | Hook scripts missing the executable bit |
| [`shellcheck-hooks.sh`](./shellcheck-hooks.sh) | Shellcheck violations in hook scripts |
| [`dir-toolchain.sh`](./dir-toolchain.sh) | Per-directory toolchain expectations |
| [`kuzu-trusted-dep.sh`](./kuzu-trusted-dep.sh) | kuzu trusted-dependency declaration |
| [`symlink-targets.sh`](./symlink-targets.sh) | Symlinks pointing at missing targets |
| [`main-guard-files-present.sh`](./main-guard-files-present.sh) | Required main-guard files present |
| [`no-secrets-in-source.sh`](./no-secrets-in-source.sh) | Secrets committed to source |
| [`no-developer-paths.sh`](./no-developer-paths.sh) | Hardcoded developer/local paths |
| [`no-hardcoded-plugin-name.sh`](./no-hardcoded-plugin-name.sh) | Hardcoded plugin name instead of resolution |
| [`issue-sync-test-isolation.sh`](./issue-sync-test-isolation.sh) | Tests not isolating issue-sync side effects |
