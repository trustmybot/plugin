# Contributing to TMB Plugin

Thanks for the interest. Public MIT-licensed plugin for Claude Code. Contributions welcome — issues, PRs, dogfood reports, all of it.

## TL;DR

1. Open (or find) a GitHub issue for the change.
2. Branch off `dev` using `<type>/<issue-number>-<slug>` (see Branching).
3. Make the change + update or add tests.
4. `bash tests/run-all.sh` — full suite must be green.
5. Open a PR targeting `dev`. Reference the issue with `Closes #N`.

## Branching

- `main` — release tip. Tags (`v0.1.2`, `v1.0.0`, …) live here.
- `dev` — integration branch. All work-branch PRs land here first.
- Work branches — use `<type>/<issue-number>-<slug>`, e.g. `feat/42-dual-backend-issues`, `fix/45-gitguards-missing-branch`, `docs/27-local-testing`. Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`. Embedding the issue number makes every branch self-documenting and auto-links on PR merge.

Direct commits to `dev` or `main` are blocked by `git-guards.sh`. Always work on a branch.

**Releases** go via a `dev → main` PR (the only branch other than work-branches that can target `main`). The hook in `git-guards.sh` permits exactly this case while still blocking `feature → main` PRs (the v0.1.1 release exception).

## Writing code

- Self-documenting code. Prefer deletion over addition.
- Match existing patterns in the file before introducing new ones.
- TypeScript for the MCP server (`mcp/trajectory-server/`). Bash for hooks.
- Commit messages: emoji + Conventional Commits (see recent `git log`).

## Writing tests

Every code change should add or update tests.

- **MCP server changes** → `mcp/trajectory-server/src/test/<name>.test.ts`. Helper API in `tests/README.md`; key fixture `tempDB()`.
- **Hook changes** → `tests/hooks/<name>.test.sh`. Assertion helpers in `tests/lib/assert.sh`.
- **Agent prompts / skills / docs** — no automated tests yet (known gap). Walk the manual dogfood checklist in [`tests/manual/setup.md`](tests/manual/setup.md) before opening the PR.

## Pre-PR checklist

- [ ] `bash tests/run-all.sh` passes locally (lint + MCP integration + hook suites).
- [ ] Workflow state (issues, tasks, discussions, validation attempts) goes through MCP tools into SQLite — never onto disk.
- [ ] `CHANGELOG.md` updated for user-visible changes.
- [ ] If the edit affects a workflow contract, update every agent template body AND every consuming skill that cites it — not just one. Remember: agent templates are the immutable Lego stud, skills are the bricks. Behavior changes go in skills; identity changes go in templates.
- [ ] If the edit changes a `tmb_*` skill's contract, also update the lint assertions in `tests/lint/` if a contract is involved.
- [ ] If the edit touches the SQLite schema, regenerate the ER diagram in `docs/architecture/ERD.md` and update the `requireRoles` matrix in `mcp/trajectory-server/src/middleware/agent-scope.ts`.
- [ ] PR description names the issue (`Closes #N`).

## Filing an issue

- **Bug**: include plugin version (`jq .version .claude-plugin/plugin.json`), Claude Code version, repro steps, expected vs actual.
- **Feature request**: state the use case first, then the proposed mechanism.
- **Dogfood report**: tell us what broke when you used the plugin — those bugs are the highest priority. Reference the workflow step that tripped (e.g., "onboarding step 2 hung when…").

## Design principles

If you're proposing a big change, check these first.

1. **SQLite is canonical state.** Files are for SE convention (README, CHANGELOG, ADRs) or agent-loaded context (prompts, skills, rules). Workflow state (issues, tasks, discussions, validation attempts) lives in the trajectory DB, never on disk.
2. **No bypass in the workflow.** Every non-trivial code change routes Human → bro → SWE, with bro as the **task gate** (verifies after SWE returns) and pr-reviewer as the **push gate** (fires only at `git push`). The "fast path" is a lighter spec, not skipping a gate. Direct Mode is the single narrow exception (≤3 lines, single file, no API/test/docs change).
3. **Plugin ships ZERO subagents.** Bro is a CLAUDE.md persona on main Claude. SWE, pr-reviewer, and the 4 consultant templates (architect, cto, ceo, pm) live in `templates/agents/` and are copied into `<project>/.claude/agents/` on demand. Domain agents (legal-reviewer, security-reviewer, …) are user-created via the `tmb_agent-creator` skill with explicit Human approval.
4. **Lego layering.** Three layers, never confused: agent file = identity (immutable), `skills:` array on the project copy = capabilities (additive via `tmb_skill-creator`), spawn prompt = task context (per-call). Don't edit the template body to add behavior — extend `skills:`.
5. **Override per project.** Any agent template can be overridden by editing the same-named file in the project's `.claude/agents/`. Local wins. Plugin-shipped protocol skills (`tmb_*` in `plugin/skills/`) are reserved and cannot be name-overridden.
6. **Server-enforced decision chain.** `requireRoles` middleware in `mcp/trajectory-server/src/middleware/agent-scope.ts` rejects calls that violate the chain (e.g. consultants trying to write `task_create_batch`). Doctrine isn't just prompt discipline — it's wire-enforced.

## Multi-platform structure

The repo follows the [`obra/superpowers`](https://github.com/obra/superpowers) pattern: shared `skills/`, `templates/`, and `mcp/` at the root, with thin per-platform manifests in `.<platform>-plugin/` directories. Today only `.claude-plugin/` is implemented; `.codex-plugin/`, `.cursor-plugin/`, `.opencode/`, and `gemini-extension.json` are placeholders. See [`docs/multi-platform.md`](docs/multi-platform.md) for the strategy and what an adapter would do. Adapters get built when there's user demand; until then, contributions should target Claude Code only.

## Code of conduct

Be direct. Disagree explicitly. Don't pad reviews with praise you don't mean. Engineering project, not a social graph.

## License

MIT. By contributing, you agree your contribution is MIT-licensed under the same terms as the rest of the plugin.
