# Contributing to TMB Plugin

Public MIT plugin for Claude Code. Issues, PRs and real-use reports are welcome; bugs you hit *using* the plugin are the most valuable reports. You don't need to run TMB to contribute: git, node and bun are enough.

## Quick start

1. Open or find an issue on `github.com/trustmybot/plugin` (canonical; a GitLab mirror is a backup).
2. Branch off `dev` as `<type>/<issue>-<slug>` (e.g. `fix/45-gitguards-merge`; types `feat fix refactor chore docs test perf`): `git fetch origin dev && git switch -c <branch> origin/dev`. Without Write access, fork the repo and branch in your fork.
3. Make the change with its tests. Locally, run the tests for the paths you touched, `bun run build:tsc` and the L1 lints you touched.
4. `gh pr create --base dev` with `Closes #N` in the description.

A maintainer reviews and merges. Nobody pushes to `dev` or `main` directly: branch protection and `mcp/trajectory-server/src/hooks/git-guards.ts` block it. Merging, tagging, publishing and the L6 release gate are maintainer-only ([RELEASE.md](docs/contributing/RELEASE.md)).

## Branches

| Branch | Role | Channel |
|---|---|---|
| `dev` | integration trunk; every PR lands here | `tmb@trustmybot-dev`, served from `dev-build` |
| `dev-build` | CI-stamped runtime-only copy of `dev`; never edited by hand | |
| `rc` | the `vX.Y.Z-rc.N` tag under validation | `tmb@trustmybot-rc` |
| `main` | stable; version tags live here | `tmb@trustmybot` |

- One concern per branch. Delete it on merge (`--delete-branch`).
- All integration goes through PRs; never `git merge` into `dev` or `main` locally.
- `dev` merges through the merge queue once checks are green; GitHub auto-merge is off. Prompt-surface PRs (`agents/`, `skills/`, `commands/`, `templates/`, `CLAUDE.md`) also need a maintainer's review of the PR itself.
- Prompt engineering follows [`docs/prompt-engineering/`](docs/prompt-engineering/README.md): move every rule a check can decide into the [deterministic layer](docs/prompt-engineering/DETERMINISTIC_LAYER.md), and grade every new or changed prompt A on the [judgment-layer rubric](docs/prompt-engineering/JUDGMENT_LAYER.md#grading-a-prompt). While a batch of issues is worked autonomously, prompt surfaces freeze: prefer a hook, MCP or schema fix, or file an issue for maintainer review.

## CI

- `pr-check.yml` runs L1 and the dashboard tests on every PR.
- `.github/workflows/dev-build.yml` reruns L1 on every push to `dev` (its `l1` job), so a merge that breaks an L1 rule turns `dev` red; its `stamp` job publishes the dev build and is not a gate.
- The full L1–L4 sweep, L6 and L0 run only at the rc release gate ([RELEASE.md](docs/contributing/RELEASE.md#release-gate)). CI-only breakage surfaces there.

## Issues & PRs

- Every issue and PR carries a milestone: the release expected to ship it. Re-milestone it if it slips.
- A PR that resolves an issue says `Closes #N` in its description; a mention in a comment does not link. A PR with no issue says so in one line.
- GitHub's auto-close does not fire on `dev`, so whoever merges closes the issue with a comment naming the PR and commit (e.g. "Fixed in #530 @ `af89a30`").

### Filing an issue

- Use an issue form (Bug, Improvement, Feature, Research); blank issues are disabled. Every issue carries one type, one priority and one area ([LABELS.md](docs/contributing/LABELS.md)); triage adds `needs-triage` until it does.
- Validate a defect against `dev`, not the installed plugin, which lags it: replay it on the `dev` source with an isolated `HOME`/`TMPDIR`, search `git log origin/dev` for a fix, and classify it VALID, FIXED_ON_DEV, FALSE_ALARM or NEEDS_DECISION with file:line or commit evidence.
- When an agent breaks a documented workflow rule, file an issue titled `workflow-violation: …` naming the rule, what happened, and a fix that moves the rule into a hook or the MCP server.

## Writing code & tests

- Self-documenting code; prefer deletion over addition; match the file's patterns. Emoji + Conventional Commit messages. Prose lines are not hard-wrapped.
- No new shell: hooks, scripts and tools are TypeScript unless nothing else can run (GH 1692).
- Every change ships its test: MCP → `mcp/trajectory-server/src/test/*.test.ts`; hook → a node:test suite `mcp/trajectory-server/src/test/<name>-l3.test.ts` ([tests/README.md](tests/README.md)); new deterministic check → a lint in `tests/l1-lint/`. Prompt and doc changes rely on review and the rc gate.
- Run MCP unit tests with `cd mcp/trajectory-server && bun run test`, never bare `bun test` (bun's runner cannot load `node:sqlite`).
- A task's `verification[]` exercises the layer guarding what it touches: hooks → their `*-l3.test.ts` suites; migrations and destructive SQL → the L1 lints; `scripts/` or `mcp/trajectory-server/src/` → the whole `tests/l1-lint/` loop. Use at most one L3 runner per task (the gate has one `verification_timeout_s` budget).
- A migration task's `files[]` covers every test asserting the schema version or table set and every reader of a changed key or column. A schema change also rebuilds `docs/architecture/ERD.md` and sets the tool's `requireRoles(...)` list.
- Workflow state (issues, tasks, discussions, validation) goes through MCP tools into SQLite, never onto disk.
- DB vocabularies live in [ENUMS.md](docs/contributing/ENUMS.md): a new value goes in the code and that doc in the same PR (`enums-stable.test.mjs`).
- Rules about developing TMB stay in these dev docs and tests; shipped surfaces carry only what a user's project needs ([PHILOSOPHY.md §2](docs/architecture/PHILOSOPHY.md#2-dev-vs-user-runtime-boundary)).

### Naming: one stem per feature

Every surface of a feature uses one stem in its own case: `skills/tmb_<stem>/`, `<stem>_<verb>` MCP tools and audit events, `<stem>[-<verb>]` source and test files, `TMB_<STEM>_*` env vars. `cheatcode` is the model (`tmb_cheatcode`, `cheatcode_*`, `src/tools/cheatcode-*.ts`). Pick a short, vivid stem the codebase doesn't already use generically, and scope a rename to the feature's identifiers, never a blanket replace. `skill-frontmatter.test.mjs` and `skill-catalog-sync.test.mjs` hold skill names; review holds the rest.

### File headers

A new `*.ts`, `*.tsx` or `*.sh` file opens with a one-line comment saying what it is for; the world model shows that line as the file's purpose.

```ts
// Ranks cheatcode hits by embedding similarity and recency.
```

Not a changelog line, a banner or the file name restated. `purpose-header.test.mjs` checks new files under `src/`, `mcp/*/src/`, `dashboard/web/`, `dashboard/server/`, `scripts/` and `skills/*/scripts/`; tests, fixtures, `dist/`, `.d.ts` and generated files are exempt.

### Changelog fragments

A user-visible change adds one file under [`changelog.d/`](changelog.d/README.md) and never edits `CHANGELOG.md` (`changelog-current.test.mjs` fails that outside a version bump). At release, `bump-version.ts` folds the fragments into the version's section.

### Generated files

Never edit these by hand. All but the last are git-ignored and built by `bun run build:payload` (worktrees and the test runner build first):

| File | Generated by |
|---|---|
| `mcp/trajectory-server/dist/**` | `npm run build` in `mcp/trajectory-server` |
| `scripts/hooks/lib/audit-events.txt` | `npm run build` (`gen-enums-doc.mjs --txt`) |
| `scripts/hooks/lib/data-contracts.json` | `emit-data-contracts.mjs` |
| `dashboard/dist/**` | `bun run build` in `dashboard` |
| the `audit.event_type` section of `docs/contributing/ENUMS.md` (committed) | `gen-enums-doc.mjs --doc`; rerun and commit after a merge changes `audit-events.ts` |

## Security and license

Report vulnerabilities privately per [`SECURITY.md`](SECURITY.md), never in a public issue. Contributions are MIT-licensed.
