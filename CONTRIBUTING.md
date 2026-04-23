# Contributing to TMB Plugin

Thanks for the interest. This is a public MIT-licensed plugin for Claude Code. Contributions welcome — issues, PRs, dogfood reports, all of it.

## TL;DR

1. Fork + branch off `dev` (never `main` — see branching model below).
2. Make your change + write or update tests.
3. `bash tests/run-all.sh` — full suite must be green.
4. Open a PR targeting `dev`.
5. PR Reviewer gate + green CI required before merge.

## Branching

- `main` — release tip. Tags (`v0.3.0`, `v0.3.1`, etc.) live here.
- `dev` — integration branch. All PRs land here first.
- `feat/*`, `fix/*`, `refactor/*`, etc. — work branches off `dev`. Push freely; feature-branch pushes aren't gated.

Direct commits to `dev` or `main` are blocked by `git-guards.sh`. Always work on a feature branch.

## Writing code

- Self-documenting code. Prefer deletion over addition.
- Match existing patterns in the file before introducing new ones.
- TypeScript for the MCP server (`mcp/trajectory-server/`). bash for hooks.
- Commit messages: emoji + Conventional Commits (see recent `git log` for examples).

## Writing tests

Every code change should add or update tests.

- **MCP server changes** → `mcp/trajectory-server/src/test/<name>.test.ts`. See `tests/README.md` for the helper API.
- **Hook changes** → `tests/hooks/<name>.test.sh`. See the same README.
- **Agent prompts / skills / docs** — no automated tests yet (gap). Walk the manual dogfood checklist in [`docs/local-testing.md`](docs/local-testing.md) before PR.

## Pre-PR checklist

- [ ] `bash tests/run-all.sh` passes locally.
- [ ] No new references to `docs/trustmybot/tasks/` or `GOALS.md`/`DISCUSSION.md`/`BLUEPRINT.md` (those are SQLite, not files — see CHANGELOG v0.3.1).
- [ ] CHANGELOG.md updated for user-visible changes.
- [ ] Agent prompt edits: if the change affects workflow (not just prose cleanup), update all agents that cite the changed contract, not just one.
- [ ] PR description names which phase / issue you're addressing.

## Filing an issue

- **Bug**: include plugin version (`cat .claude-plugin/plugin.json | jq .version`), Claude Code version, repro steps, expected vs actual.
- **Feature request**: state the use case first, then the proposed mechanism.
- **Dogfood report**: tell us what broke when you used the plugin — those bugs are the highest priority. Reference the workflow step that tripped (e.g., "onboarding step 2 hung when...").

## Design principles (short)

If you're proposing a big change, check these first:

1. **SQLite is canonical state.** Files are either SE convention (README, CHANGELOG, ADRs) or agent context (prompts, skills). Workflow state (tasks, discussions, goals) lives in DB, never files.
2. **No bypass in the workflow.** Every code change routes through architect → SWE → pr-reviewer. The "fast path" is a lighter task spec, not skipping a role.
3. **Plugin is an agent factory.** Workflow agents ship (gatekeeper, prompt-engineer, architect, swe, pr-reviewer). Domain agents (ceo, cto, etc.) seed into the user's project and are theirs to own.
4. **Two-tier with override.** Plugin-shipped agents at `plugin/agents/` are overrideable per-project via `.claude/agents/<name>.md`. Local wins.

## Code of conduct

Be direct. Disagree explicitly. Don't pad reviews with praise you don't mean. This is an engineering project, not a social graph.

## License

MIT. By contributing, you agree your contribution is MIT-licensed under the same terms as the rest of the plugin.
