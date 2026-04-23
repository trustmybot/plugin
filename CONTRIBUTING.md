# Contributing to TMB Plugin

Thanks for the interest. Public MIT-licensed plugin for Claude Code. Contributions welcome — issues, PRs, dogfood reports, all of it.

## TL;DR

1. Open (or find) a GitHub issue for the change.
2. Branch off `dev` using `<type>/<issue-number>-<slug>` (see Branching).
3. Make the change + update or add tests.
4. `bash tests/run-all.sh` — full suite must be green.
5. Open a PR targeting `dev`. Reference the issue with `Closes #N`.

## Branching

- `main` — release tip. Tags (`v0.3.2`, `v1.0.0`, …) live here.
- `dev` — integration branch. All PRs land here first.
- Work branches — use `<type>/<issue-number>-<slug>`, e.g. `feat/42-dual-backend-issues`, `fix/45-gitguards-missing-branch`, `docs/27-local-testing`. Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`. Embedding the issue number makes every branch self-documenting and auto-links on PR merge.

Direct commits to `dev` or `main` are blocked by `git-guards.sh`. Always work on a branch.

## Writing code

- Self-documenting code. Prefer deletion over addition.
- Match existing patterns in the file before introducing new ones.
- TypeScript for the MCP server (`mcp/trajectory-server/`). Bash for hooks.
- Commit messages: emoji + Conventional Commits (see recent `git log`).

## Writing tests

Every code change should add or update tests.

- **MCP server changes** → `mcp/trajectory-server/src/test/<name>.test.ts`. Helper API in `tests/README.md`; key fixture `tempDB()`.
- **Hook changes** → `tests/hooks/<name>.test.sh`. Assertion helpers in `tests/lib/assert.sh`.
- **Agent prompts / skills / docs** — no automated tests yet (known gap). Walk the manual dogfood checklist in [`docs/local-testing.md`](docs/local-testing.md) before opening the PR.

## Pre-PR checklist

- [ ] `bash tests/run-all.sh` passes locally.
- [ ] Workflow state (issues, tasks, discussions, validation attempts) goes through MCP tools into SQLite — never onto disk.
- [ ] `CHANGELOG.md` updated for user-visible changes.
- [ ] If the edit affects a workflow contract, update every agent prompt that cites it — not just one.
- [ ] PR description names the issue (`Closes #N`).

## Filing an issue

- **Bug**: include plugin version (`jq .version .claude-plugin/plugin.json`), Claude Code version, repro steps, expected vs actual.
- **Feature request**: state the use case first, then the proposed mechanism.
- **Dogfood report**: tell us what broke when you used the plugin — those bugs are the highest priority. Reference the workflow step that tripped (e.g., "onboarding step 2 hung when…").

## Design principles

If you're proposing a big change, check these first.

1. **SQLite is canonical state.** Files are for SE convention (README, CHANGELOG, ADRs) or agent-loaded context (prompts, skills, rules). Workflow state (issues, tasks, discussions, validation attempts) lives in the trajectory DB, never on disk.
2. **No bypass in the workflow.** Every code change routes gatekeeper → architect → swe → pr-reviewer. The "fast path" is a lighter task spec, not skipping a role.
3. **Plugin is an agent factory.** Four workflow agents ship (gatekeeper, architect, swe, pr-reviewer). Domain agents (ceo, cto, pm, legal-reviewer, …) are user-created on-demand via the `agent-creator` skill with explicit Human approval.
4. **Override per project.** Any plugin-shipped agent can be overridden by creating a same-named file in the project's `.claude/agents/`. Local wins.

## Code of conduct

Be direct. Disagree explicitly. Don't pad reviews with praise you don't mean. Engineering project, not a social graph.

## License

MIT. By contributing, you agree your contribution is MIT-licensed under the same terms as the rest of the plugin.
