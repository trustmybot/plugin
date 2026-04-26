# Contributing to TMB Plugin

Thanks for the interest. Public MIT-licensed plugin for Claude Code. Contributions welcome — issues, PRs, dogfood reports, all of it.

## TL;DR

1. Open (or find) a GitHub issue for the change.
2. Branch off `dev` using `<type>/<issue-number>-<slug>` (see Branching).
3. Make the change + update or add tests.
4. `bash tests/run-all.sh` — full suite must be green.
5. Open a PR targeting `dev`. Reference the issue with `Closes #N`.

## Branching

- `main` — stable release tip. Tags (`v0.3.1`, `v1.0.0`, …) live here. **Marketplace channel: `tmb`.**
- `rc` — release-candidate channel. Fast-forwarded to whichever `vX.Y.Z-rc.N` tag is currently being validated. **Marketplace channel: `tmb-rc`.**
- `dev` — integration branch. All work-branch PRs land here first. Not directly published to marketplace; promoted to `rc` for testing, then to `main` for stable.
- Work branches — use `<type>/<issue-number>-<slug>`, e.g. `feat/42-dual-backend-issues`, `fix/45-gitguards-missing-branch`. Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`. Embedding the issue number makes every branch self-documenting and auto-links on PR merge.

Direct commits to `dev` or `main` are blocked by `git-guards.sh`. Always work on a branch.

**Releases** go via `dev → main` PR. **Risky changes go through `rc` first** (see "Release ritual" below). The `git-guards.sh` hook permits dev → main as the only non-work-branch path to main.

## Two marketplace channels

Users choose their risk tolerance:

| Channel | Install command | What it tracks | Audience |
|---|---|---|---|
| **stable** | `/plugin install tmb@trustmybot` | `main` branch (latest tag) | Production users — only validated releases |
| **release candidate** | `/plugin install tmb-rc@trustmybot` | `rc` branch (currently-testing RC tag) | Beta testers, contributors validating risky changes pre-promotion |

Defined in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).

The `rc` branch is **fast-forwarded** to a new RC tag for each validation cycle. CC re-fetches on `/plugin update`, so `tmb-rc` users always get the current RC. When an RC graduates to stable, `main` advances; `rc` stays at the validated commit (which is now equivalent to main).

### Release ritual

Two paths depending on risk:

#### Path 1 — Hotfix (low risk, urgent)

For bug fixes that don't change behavior (security, doctrine-preserving fixes, install-path repairs):

1. On a work branch off `dev`, bump `version` in `.claude-plugin/plugin.json`, `mcp/trajectory-server/package.json`, and root `package.json`. Add `## v<X.Y.Z>` section at the top of `CHANGELOG.md`. Commit + PR into `dev`.
2. PR `dev → main`, merge.
3. ```bash
   git checkout main && git pull origin main
   bash scripts/release.sh
   ```

Stable users (`tmb@trustmybot`) auto-update on next `/plugin update`.

#### Path 2 — Release candidate (any risky change — required for cold-start, install path, doctrine, schema)

When a change could plausibly break users (the v0.2.0/v0.3.0 install-path class, schema migrations, doctrine flips), validate via `tmb-rc` channel before promoting to stable:

1. **Develop on dev as usual.** When ready to test in marketplace, on `dev`:
   ```bash
   # Cut RC tag
   git tag -a v0.4.0-rc.1 -m "v0.4.0 release candidate 1"
   git push origin v0.4.0-rc.1

   # Fast-forward rc branch to the RC tag
   git checkout rc && git reset --hard v0.4.0-rc.1
   git push --force-with-lease origin rc
   git checkout dev
   ```
2. **Install + test from `tmb-rc` channel:**
   ```
   /plugin update tmb-rc@trustmybot   # CC re-fetches the rc branch HEAD
   ```
3. **If broken** → fix on `dev`, cut `v0.4.0-rc.2`, fast-forward `rc`, re-test. Iterate.
4. **If green** → promote: PR `dev → main`, merge, then run `bash scripts/release.sh` to tag `v0.4.0` on main.
5. After stable release, `tmb-rc` users get the same code that stable users get (rc branch caught up to main). The `rc` branch stays at the validated commit until the next RC cycle starts.

`scripts/release.sh` reads the version from `plugin.json`, validates that all 3 manifest versions agree, requires a matching `## v<version>` section in `CHANGELOG.md`, and asks for `y/N` confirmation at each step. It tags `main` HEAD, pushes the tag, creates a GitHub release with the CHANGELOG section as the body, and runs the L6 release canary. Re-running after a step succeeds is safe — already-done steps are skipped. The script also refuses to re-tag a published release (force-pushing tags would corrupt downstream caches; the only path forward is bump version + ship a new tag).

#### Why both paths exist

Path 1 is for fixes that don't need cold-start verification (e.g. doc-only releases). Path 2 is for everything else — especially anything touching install behavior, schema, or agent doctrine. **The v0.2.0 and v0.3.0 breakages happened because we shipped install-path changes via Path 1 with no real-world install verification.** Going forward, anything in those categories MUST go through `tmb-rc` first.

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
3. **Two-layer agent model.** Bro is a CLAUDE.md persona on main Claude. **Workflow backbone** (`swe`, `pr-reviewer`) ships globally in `agents/` and is always available — onboarding does NOT copy it into the project. **Consultants** (`architect`, `cto`, `ceo`, `pm`) ship as templates in `templates/agents/` and are instantiated per-project on demand. Domain agents (legal-reviewer, security-reviewer, …) are user-created via `tmb_agent-creator` with explicit Human approval. Resolution rule for backbone agents: `if <project>/.claude/agents/<name>.md exists → local; else → global`.
4. **Lego layering.** Three layers, never confused: agent file = identity (immutable), `skills:` array on the project copy = capabilities (additive via `tmb_skill-creator`), spawn prompt = task context (per-call). Don't edit the template body to add behavior — extend `skills:`.
5. **Override per project.** Any agent template can be overridden by editing the same-named file in the project's `.claude/agents/`. Local wins. Plugin-shipped protocol skills (`tmb_*` in `plugin/skills/`) are reserved and cannot be name-overridden.
6. **Server-enforced decision chain.** `requireRoles` middleware in `mcp/trajectory-server/src/middleware/agent-scope.ts` rejects calls that violate the chain (e.g. consultants trying to write `task_create_batch`). Doctrine isn't just prompt discipline — it's wire-enforced.

## Performance

The plugin's overhead vs pure Claude Code on the same ask should land in this band:

| Ask shape | Pure Claude | TMB target | Acceptable ceiling |
|---|---|---|---|
| Trivial single-file (typo, comment) | ~10s | ~10–20s (Direct Mode) | 30s |
| Simple task (single feature) | ~30s | ~2–3 min | 5 min |
| Difficult task (architecture change + ADR) | ~2 min | ~5–8 min | 12 min |
| Multi-task batch | n/a | ≤ 1.5× single-task per task | 2× per task |

**Doctrine — what's safe to trim, what isn't.** When proposing a perf change, classify the cost into one of three tiers:

- **Tier 1 — pure waste, trim aggressively.** Sequential MCP writes that could batch in one assistant response; eager skill loading that fires on every spawn but is needed in <30% of spawns; forced chain-of-thought blocks for tasks that don't benefit; redundant approval prompts.
- **Tier 2 — design overhead, trim with care.** Per-task gate spawns (justified for difficult-triage, not for every typo — hence the push-gate vs task-gate split); worktree creation; forced subagent cold-start when bro could just edit (hence Direct Mode).
- **Tier 3 — load-bearing overhead, do NOT trim.** The trajectory DB writes (the audit trail IS the product); `requireRoles` enforcement (~1ms, structural protection); worktree isolation (prevents cross-task corruption); the push gate (only structural defence against pushing unreviewed commits).

**Re-evaluate** when (a) a SWE or pr-reviewer cold-start in a Layer 3 dogfood takes >2× the previous baseline, (b) a user reports a chain >12 min for a simple-triage task, (c) a new gate / hook / skill fires on the per-task path, (d) CC platform changes subagent cold-start cost, or (e) a new platform adapter (Codex, Cursor, …) gets implemented — re-baseline on that platform.

Historical perf-cycle records live in git history (PR #63 baseline, PR #64 optimizations) and the changelog, not in a separate doc.

## Multi-platform structure

The repo follows the [`obra/superpowers`](https://github.com/obra/superpowers) pattern: shared `skills/`, `templates/`, and `mcp/` at the root, with thin per-platform manifests in `.<platform>-plugin/` directories. Today only `.claude-plugin/` is implemented; `.codex-plugin/`, `.cursor-plugin/`, `.opencode/`, and `gemini-extension.json` are placeholders. See [`docs/multi-platform.md`](docs/multi-platform.md) for the strategy and what an adapter would do. Adapters get built when there's user demand; until then, contributions should target Claude Code only.

## Code of conduct

Be direct. Disagree explicitly. Don't pad reviews with praise you don't mean. Engineering project, not a social graph.

## License

MIT. By contributing, you agree your contribution is MIT-licensed under the same terms as the rest of the plugin.
