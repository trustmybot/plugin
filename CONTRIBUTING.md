# Contributing to TMB Plugin

Public MIT plugin for Claude Code. Issues, PRs, and real-use reports all welcome — the bugs you hit *using* the plugin are the highest-value reports.

## TL;DR

1. Open or find a **GitHub** issue. `github.com/trustmybot/plugin` is canonical (a GitLab mirror exists as backup).
2. Branch off `dev`: `<type>/<issue>-<slug>` (e.g. `fix/45-gitguards-merge`). Types: `feat fix refactor chore docs test perf`.
3. Make the change **with tests**.
4. `bash tests/run-all.sh` — must be green (L1–L4).
5. `gh pr create --base dev` — reference the issue (`Closes #N`); pick from the existing [labels](docs/contributing/LABELS.md).

Direct commits to `dev` and `main` are blocked by `scripts/hooks/git-guards.sh` + branch protection — always work on a branch and PR.

## Branches & channels

| Branch | Role | Marketplace channel |
|---|---|---|
| `main` | stable tip; version tags live here | `tmb@trustmybot` (catalog `trustmybot/marketplace`) |
| `rc` | fast-forwarded to the `vX.Y.Z-rc.N` tag under validation | `tmb@trustmybot-rc` (catalog `trustmybot/marketplace-rc`) |
| `dev` | integration trunk; all PRs land here first | — (not published) |

## CI (GitHub Actions)

`.github/workflows/release-gate.yml` runs on GitHub's runners:
- **every push / PR to `dev`** → L1–L4 (`tests/run-all.sh`).
- **version tags + manual dispatch** → L1–L4 **+ L6 chain** (`tests/l5-l6/run-l6-chain.sh`) **+ L0 docker install-smoke**.

L6 needs the `CLAUDE_CODE_OAUTH_TOKEN` repo secret; chain logs upload as a run artifact.

## Release

`scripts/maintenance/bump-version.sh <version>` keeps the version in sync across all four manifests.

1. On a branch off `dev`: `bump-version.sh X.Y.Z-rc.N`, add a `## vX.Y.Z-rc.N` CHANGELOG section, PR → `dev`.
2. Tag the rc on `dev` and push → release-gate CI runs the full gate (L1–L4 + L6 + L0). Fast-forward `rc` to the tag.
3. Validate via `tmb@trustmybot-rc` against [`tests/manual/scenarios.md`](tests/manual/scenarios.md) — marketplace install, **not** `--plugin-dir`.
4. Green → PR `dev → main`, merge, then `bash scripts/release.sh` tags the stable `vX.Y.Z` on `main` and cuts the GitHub release. (`release.sh` checks that the manifests and the `## vX.Y.Z` CHANGELOG section agree, and is safe to re-run.)

rc validation is **required** for anything touching install, schema, or doctrine — those are the breakage classes (v0.2.0 / v0.3.0) the rc channel exists to catch. Doc-only changes can skip the rc lap.

## Writing code & tests

- Self-documenting code; prefer deletion over addition; match the file's existing patterns. TypeScript for the MCP server, Bash for hooks. Emoji + Conventional Commit messages.
- Every change ships its test: MCP → `mcp/trajectory-server/src/test/*.test.ts`; hook → `tests/hooks/*.test.sh`; new enforcement → a lint in `tests/lint/`.
- Prompt / skill / doc changes have no automated test — walk [`tests/manual/scenarios.md`](tests/manual/scenarios.md) before opening the PR.

## Pre-PR checklist

- [ ] `bash tests/run-all.sh` green.
- [ ] Tests added or updated.
- [ ] Workflow state (issues, tasks, discussions, validation) goes through MCP tools into SQLite — never onto disk.
- [ ] `CHANGELOG.md` updated for user-visible changes.
- [ ] Schema change → rebuild `docs/architecture/ERD.md` + update the `requireRoles` matrix in `mcp/trajectory-server/src/middleware/agent-scope.ts`.
- [ ] PR names the issue (`Closes #N`).

## Design principles

1. **SQLite is canonical state.** Files are for SE convention (README / CHANGELOG / ADR) or agent context (prompts / skills / rules). Issues, tasks, discussions, and validation live in the trajectory DB.
2. **No bypass.** Every code change runs Human → bro → SWE, with bro as the task gate (verifies SWE's return) and pr-reviewer as the push gate (fires at `git push`). Bro never edits source.
3. **Two-layer agents.** bro is a CLAUDE.md persona; `swe` / `pr-reviewer` ship globally in `agents/`; consultants are templates instantiated per project. A local `.claude/agents/<name>.md` overrides the global.
4. **Lego layering.** Agent file = identity (immutable); the `skills:` array = capabilities (extend via `tmb_skill-creator`); spawn prompt = per-call context. Add behavior through skills, not by editing the template body.
5. **Server-enforced chain.** `requireRoles` in the MCP server rejects out-of-role calls — doctrine is wire-enforced, not prompt discipline.

## Scope

Enterprise features (SSO, RBAC, SOC2, multi-tenant) are deferred until real paying-customer demand; focus stays on the solo/small-team workflow. Only `.claude-plugin/` is implemented today — other platform manifests are placeholders (see [`docs/reference/MULTI_PLATFORM.md`](docs/reference/MULTI_PLATFORM.md)).

## Security

Report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md). Don't open public issues for them.

## License

MIT. By contributing, you agree your contribution is MIT-licensed. Be direct in reviews — engineering project, not a social graph.
