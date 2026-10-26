# Contributing to TMB Plugin

Public MIT plugin for Claude Code. Issues, PRs, and real-use reports all welcome — the bugs you hit *using* the plugin are the highest-value reports.

## Ways to contribute

There are two paths, depending on whether you've been granted access to the repo. Both land the same way — a GitHub pull request into `dev` that a maintainer reviews and merges.

**Fork + pull request (no access needed).** Anyone can contribute this way, with zero permissions granted:

1. **Fork** `github.com/trustmybot/plugin` to your own account.
2. In your fork, branch off `dev`: `<type>/<issue>-<slug>` (same convention as below).
3. Make the change with tests; `bash tests/run-all.sh` must be green.
4. Open a **cross-repo pull request** from your fork's branch into `trustmybot/plugin`'s `dev`.
5. A maintainer reviews and merges it.

A pull request is a *request* — you're asking a maintainer to pull your commits in, and they fulfil it by merging. You never push into `trustmybot/plugin` yourself, so you need no access to the repo at all.

**Collaborator / org-team Write access (trusted members).** Trusted contributors are granted Write access either by a GitHub collaborator invite or by membership in a GitHub Team on the org. With Write access you branch directly inside `trustmybot/plugin` off `dev` — no fork — then open the pull request from that branch. Org and company teammates typically work this way, since access is managed at the team level, rather than each keeping a personal fork.

Either way you still don't push to `dev` or `main` directly — branch protection and `scripts/hooks/git-guards.sh` block that. The pull request is always the merge path.

**You don't need to run TMB itself to contribute** — plain git plus `bash tests/run-all.sh` (L1–L4) is all the local tooling a change requires.

**Maintainer-only steps.** A contributor (fork or collaborator) cannot:

- Merge a pull request into `dev` or `main`.
- Run the L6 release-gate — it needs the `CLAUDE_CODE_OAUTH_TOKEN` repo secret (forks can't read repo secrets), and it fires only on rc tags plus manual `workflow_dispatch` from `rc` or `main`.
- Tag a release, publish to a marketplace channel, or cut a GitHub release.

## Platform adapters

Adapters for other agent platforms (Codex, Cursor, OpenCode, Gemini CLI) are welcome — the shared core is deliberately host-neutral so an adapter is edge work, not a fork.

[`docs/adapters/ADAPTER_CONTRACT.md`](docs/adapters/ADAPTER_CONTRACT.md) is the binding standard for that work: read it before writing any adapter code, and walk its conformance checklist in your PR description.

Two things trip up first-time adapter PRs: the full Claude Code suite must stay green on every adapter change (a red reference suite means the adapter reached into shared code), and adapter-doctrine PRs — the contract itself, parity matrices, capability declarations — are merged by a maintainer, never auto-merged.

## TL;DR

1. Open or find a **GitHub** issue. `github.com/trustmybot/plugin` is canonical (a GitLab mirror exists as backup).
2. Branch off `dev`: `<type>/<issue>-<slug>` (e.g. `fix/45-gitguards-merge`). Types: `feat fix refactor chore docs test perf`. Working from a fork? Branch off `dev` in your fork (see [Ways to contribute](#ways-to-contribute)).
3. Make the change **with tests**.
4. `bash tests/run-all.sh` — must be green (L1–L4).
5. `gh pr create --base dev` — reference the issue (`Closes #N`); pick from the existing [labels](docs/contributing/LABELS.md).

Direct commits to `dev` and `main` are blocked by `scripts/hooks/git-guards.sh` + branch protection — always work on a branch and PR.

## Branches & channels

| Branch | Role | Marketplace channel |
|---|---|---|
| `main` | stable tip; version tags live here | `tmb@trustmybot` (catalog `trustmybot/marketplace`) |
| `rc` | fast-forwarded to the `vX.Y.Z-rc.N` tag under validation | `tmb@trustmybot-rc` (catalog `trustmybot/marketplace-rc`) |
| `dev` | integration trunk; all PRs land here first | `tmb@trustmybot-dev` (catalog `trustmybot/marketplace-dev`, ref `dev-build`) |
| `dev-build` | CI-stamped, runtime-only copy of `dev` ([Dev builds](#dev-builds)): `scripts/maintenance/runtime-payload.ts` prunes every tracked path outside its runtime allowlist (tests, sources, `dist/test`, sourcemaps, docs) before the build commit, keeping `.github/` because a `GITHUB_TOKEN` push may not change workflow files; never edited by hand | served to `tmb@trustmybot-dev` |

### Dev builds

Every push to `dev` runs `.github/workflows/dev-build.yml`, which stamps the manifests with a version of the form `X.Y.Z-dev.<n>.gh<PR>` (e.g. `1.2.0-dev.7.gh1594`) and force-pushes the result to `dev-build`:

- `X.Y.Z` is the release `dev` is heading for: the lowest open `vX.Y.Z` milestone above the latest stable release (the highest stable `vX.Y.Z` tag), else that release with the minor bumped. It must be above the latest release; the build fails otherwise.
- `<n>` counts the commits merged to `dev` since the latest stable release (first-parent commits on `dev` not yet in that release; rc tags don't count), so it grows by one per merged PR and resets after each release. `n` orders builds.
- `gh<PR>` names the PR whose merge produced the build. It is a label only; it says nothing about order. A direct dispatch with no PR omits it.

**Is a fix in my build?** Find the build that shipped the fix's PR (its `gh<PR>` label, or the dev-build commit `Built from <sha>`), and compare `n`: your build has the fix when its `n` is ≥ that build's `n` (same `X.Y.Z`).

**Dev channel or rc?** Use the dev channel to try merged work as it lands; it is unvalidated beyond the per-PR checks. Cut an rc (Release, Phase B) when you have a candidate you intend to ship — only an rc goes through the release gate.

**Switching to the dev channel:**

From the project root, at local scope ([INSTALL.md — Recommended scope](docs/reference/INSTALL.md#recommended-scope-project-or-local)):

```
claude plugin marketplace add trustmybot/marketplace-dev --scope local
claude plugin disable tmb@trustmybot --scope local
claude plugin install tmb@trustmybot-dev --scope local
```

Then restart Claude Code. Keep only one TMB copy enabled — two enabled copies silently drop one copy's hooks ([UPGRADE.md — Two enabled TMB copies](docs/reference/UPGRADE.md#two-enabled-tmb-copies--gates-silently-missing)).

**Upgrading to the latest dev build:**

```
claude plugin marketplace update trustmybot-dev
claude plugin update tmb@trustmybot-dev --scope local
```

Then restart Claude Code. Each dev build comments its version and these commands on the PR that produced it.

### Branching & merging

1. **Feature branches come from `dev`** and are named by git convention (`feat/`, `fix/`, `docs/`, `chore/`, `test/` + slug). One concern per branch. Fetch in the same step you branch: `git fetch origin dev && git switch -c <branch> origin/dev`. A stale `origin/dev` makes `dist/` and CHANGELOG conflict at merge, and since local merges are blocked the only fix is redoing the work on a fresh branch.
2. **Nothing merges to `main` except `dev`** — and only when `dev` carries an rc tag whose release-gate CI passed (Phases B–C of Release). Promotion is a **merge commit** (Phase D). *Exception:* docs-only changes that need no functionality test may merge to `main` directly — and must be mirrored back to `dev` in the same sitting so the branches never drift.
3. **Typical feature workflow:** branch from `dev` → implement → local L0–L4 green → PR → `dev`. If your branch is the **last one planned before a release**, also run the local L6 chain — at that point you're in the Release workflow (Phase B); follow it.
4. **All integration goes through GitHub PRs** — `gh pr create` / `gh pr merge`. Never `git merge` locally, never push directly to `dev` or `main`. Rule 5's merge-on-green is carried out by hand: GitHub auto-merge is disabled on this repo, so `--auto` merges at once instead of waiting. Wait for green checks, then merge without `--auto`.
5. **Merge policy by surface:** code / docs / tests PRs auto-merge once checks are green. Prompt-surface PRs (`agents/`, `skills/`, `commands/`, `templates/`, `CLAUDE.md`) never auto-merge — a maintainer reviews the PR itself.
6. **CI-affecting changes** (workflows, gate scripts, L5/L6 harness) are validated like any other PR: the local sweep (`tests/run-all.sh` for the tiers they touch) + pr-reviewer + any PR checks. Never dispatch release-gate on a feature branch or on `dev` (its `ref-guard` job refuses any ref but `rc` and `main`), and no `dev` merge waits for it. CI-only breakage surfaces at rc time, when release-gate runs on the rc candidate.
7. **Delete branches on merge** (`--delete-branch`); a stale branch is a future wrong-base.
8. **Prompt engineering follows [`docs/prompt-engineering/DETERMINISM.md`](docs/prompt-engineering/DETERMINISM.md)** — grade every new or changed prompt against its rubric; nothing ships below **A-**.
9. **Prompt surfaces freeze during autonomous batches.** While a batch of issues is being worked autonomously, `agents/`, `skills/`, `commands/`, `templates/` and `CLAUDE.md` are frozen: prefer a hook, MCP or schema fix; if only a prompt change will do, file an issue for maintainer review instead.

## CI (GitHub Actions)

`.github/workflows/release-gate.yml` is **not** wired to dev pushes or PRs — it runs only on:
- **rc tags (`vX.Y.Z-rc.N`) + manual dispatch from `rc` or `main`** → L1–L4 **+ L6 chain** (`tests/l5-l6/run-l6-chain.sh`) **+ L0 docker install-smoke**. Stable tags do not fire the gate; the stable cut consumes the promoted rc's verdict.

`.github/workflows/dev-build.yml` runs on every push to `dev` (and on dispatch from `dev`): it stamps the dev-build version and force-pushes to the `dev-build` branch ([Dev builds](#dev-builds)). It publishes; it is not a gate.

Release-gate is **rc/main-only**: it runs for an rc (the rc tag push, or a dispatch from `rc` before tagging — Release, Phase B) or a dispatch from `main`, and `main` takes only a `dev` carrying a green rc gate. It never runs for `dev` PRs or `dev` merges. Per-PR validation to `dev` is the **local L0–L4 sweep (`tests/run-all.sh`) + pr-reviewer + any PR checks** (rule 6 above).

L6 needs the `CLAUDE_CODE_OAUTH_TOKEN` repo secret; chain logs upload as a run artifact.

## Issues & PRs

### Milestones

- Every issue and every PR carries a milestone — the release expected to ship it. Assign at creation; re-milestone if it slips (never leave one unmilestoned).
- Milestone hygiene is part of the release ritual: Phase A isn't done while the milestone has open items — close them, move them, or ship them.

### Issue ↔ PR linkage

- A PR that resolves an issue (the normal case) declares it with a closing keyword in the PR **description** — `Closes #N` / `Fixes #N` — so GitHub links the two bidirectionally. Comment-mentions don't create links; use the description.
- PRs merge into `dev`, where GitHub's auto-close does not fire. Whoever merges closes the issue manually with a comment naming the PR and landing commit (e.g. "Fixed in #530 @ `af89a30`"). The issue is closed only after its PR is merged, never before.
- A PR with no issue (release mechanics, typo-class fixes) says so in its description in one line.

### Filing an issue

- Open it from one of the issue forms (Bug, Improvement, Feature, Research); blank issues are disabled. The form sets the type and asks for the area.
- Every issue carries exactly one type, one priority and one area. The triage workflow adds `needs-triage` until it does. The labels and the rule live in [`docs/contributing/LABELS.md`](docs/contributing/LABELS.md); this taxonomy governs TMB development only.

### Filing issues

- **Validate every new defect against `dev`, not the installed plugin cache** (which lags `dev`). Replay it against the `dev` source with an isolated `HOME`/`TMPDIR`, search `git log origin/dev` for an existing fix, and check open local tasks. Classify it VALID, FIXED_ON_DEV, FALSE_ALARM or NEEDS_DECISION, with file:line or commit evidence.
- **Workflow breaches get an issue.** When any agent (bro included) breaks a documented workflow rule, file an issue whose title starts `workflow-violation:`, naming the rule, what happened, and a fix that moves enforcement into a hook or the MCP server.

## Release

`scripts/maintenance/bump-version.sh <version>` keeps the version in sync across the Claude manifest, Codex manifest, workspace package, MCP package, and lockfile.

**Phase A — candidate**
1. Land everything intended for the release on `dev` via the normal PR flow (auto-merge policy applies). A contributor's feature PR never sets a `-rc.N` or other prerelease suffix in a version bump; release identity is the maintainer's call.
2. Bump PR on a branch off `dev`: `bump-version.sh X.Y.Z-rc.N` + a `## vX.Y.Z-rc.N` CHANGELOG section → PR → `dev`.

**Phase B — local pre-flight**
3. Run the full local L6 chain (`bash tests/l5-l6/run-l6-chain.sh`) on the exact `dev` tree you intend to tag. **15/15 green clears you to cut the rc tag** — this is pre-flight to keep the tagged CI gate from going red, not the sign-off itself (that's Phase C, step 8). Then fast-forward `rc` to that same `dev` commit, dispatch the gate from it (`gh workflow run release-gate.yml --ref rc`), and tag that commit only on green; the tag push inherits the green same-SHA verdict (within 48h) instead of re-running it.
4. On any step failure: reproduce and debug with the matching L5 row (`bash tests/l5-l6/run-l5.sh <row>`), fix on `dev` through the normal flow, then **resume the chain from the failed step** (`run-l6-chain.sh --from <step>`). Iterate until the chain completes. An L6 step that needs the network is made hermetic (a fixture env var or fixture file), never re-rolled until it passes.
5. Whether the resumed 15/15 clears you to tag depends on what the fix touched:
   - Fix confined to **test fixtures, scorers, or docs** → the resumed pass stands; tag.
   - Fix touched **runtime** (`mcp/`, `scripts/hooks/`, schema, `agents/`, `skills/`, `commands/`, `CLAUDE.md`) → finish with **one full fresh chain**, because steps before the failure ran on pre-fix code and their green doesn't transfer.

**Phase C — rc**
6. Tag `vX.Y.Z-rc.N` on `dev`, push — this fires the CI release-gate (L1–L4 + L6 + L0) that is the sign-off (step 8). `rc` already points at it (step 3).
7. **Publish to the rc channel**: run `bash scripts/publish-rc-channel.sh` — it clones `trustmybot/marketplace-rc`, points `plugins[].source.ref` at the new rc tag, writes the channel README if missing, and pushes. Installs of `tmb@trustmybot-rc` now serve the rc. (Refuses non-rc versions; verifies the tag is on origin first; idempotent; `--dry-run` previews, `--yes` skips the prompt.)
8. The CI release-gate (L1–L4 + L6 + L0) on the exact tree you tag is the gate — the automated layers are the sole sign-off. If it goes red, re-pin the rc channel to the previous rc (`bash scripts/publish-rc-channel.sh <prev> --yes`) and delete the rc tag.

**Phase D — stable**
9. Final bump PR (`X.Y.Z`) → `dev`.
10. **Functional-identity rule**: the stable tag must be functionally identical to the latest green rc — identical in what users install. Permitted deltas after the rc (non-shipping surfaces): version manifests, CHANGELOG, `docs/`, README-class files, `tests/`, `.github/workflows/`. Anything that ships — plugin code, prompts, hooks, MCP server, schema — invalidates the rc: cut `rc.N+1` and repeat Phases B–C.
11. Promotion PR `dev → main` as a **merge commit**; merge.
12. `git checkout main && git pull`, then `bash scripts/release.sh` — it tags `v<plugin.json version>` on `main` HEAD, pushes the tag, cuts the GitHub release from the matching CHANGELOG section, and runs the Docker install canary. Each step asks y/N and skips if already done (safe to re-run); it refuses off-`main`, on a dirty tree, or on a version/CHANGELOG mismatch.
13. The stable catalog (`trustmybot/marketplace`) pins `ref: "main"` — promotion updates it automatically; no catalog edit.
14. **Re-pin the rc channel to the stable tag**: `release.sh` step 6 does this automatically — it runs `bash scripts/publish-rc-channel.sh --stable-repin --yes <version>`, which points `trustmybot/marketplace-rc`'s `plugins[].source.ref` at the new `vX.Y.Z` so rc-channel installs converge on the released build between rc cycles (idempotent; fail-forward — the release is already public). Manual fallback if the step was skipped or failed: `bash scripts/publish-rc-channel.sh --stable-repin <version>`.
15. **Canary red = fix-forward immediately** — the release is already public. Diagnose before announcing; never delete the tag.

## Writing code & tests

- Self-documenting code; prefer deletion over addition; match the file's existing patterns. Emoji + Conventional Commit messages.
- Don't write new shell: hooks, scripts and tools are TypeScript unless nothing else can run (GH 1692).
- Every change ships its test: MCP → `mcp/trajectory-server/src/test/*.test.ts`; hook → `tests/l3-integration/hooks/*.test.sh`; new enforcement → a lint in `tests/l1-lint/`.
- Prompt / skill / doc changes have no automated test — they rely on PR review, then the rc-time CI release-gate (L0–L6), for sign-off.
- A task's `verification[]` exercises the layer that guards the surface it touches: hooks → the L3 hooks runner; migrations and destructive SQL → the L1 lints; `scripts/` or `mcp/trajectory-server/src/` → the whole `tests/l1-lint/` loop, not a hand-picked subset; MCP `dist/` → `dist-fresh`. Use at most one L3 runner per task, because the verification gate has one time budget (`verification_timeout_s`).
- MCP unit tests run via `cd mcp/trajectory-server && bun run test`, never bare `bun test` (bun's runner cannot load `node:sqlite`).
- Verify the committed bundle with `git show <sha>:mcp/trajectory-server/dist/<file>.js` before any probe that rebuilds, since a rebuild overwrites the working-tree copy.
- A migration task's `files[]` covers every test that asserts the schema version or table set, the whole `mcp/trajectory-server/dist/` dir, and every reader of a changed key or column.
- Prose and comment lines are not hard-wrapped at 80 columns.

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
6. **Dev rules stay in dev docs.** Rules about developing TMB itself (release flow, L0–L6 harness, milestones, contributor workflow) live in `CONTRIBUTING.md`, `docs/`, the test-level READMEs and the tests themselves. Shipped surfaces (`CLAUDE.md`, `agents/`, `skills/`, `commands/`, `hooks/`, `templates/`) carry only what a user's project needs; TMB's own developers use TMB like any other user. See [`PHILOSOPHY.md` §3](docs/architecture/PHILOSOPHY.md#3-dev-vs-user-runtime-boundary).

## Scope

Enterprise features (SSO, RBAC, SOC2, multi-tenant) are deferred until real paying-customer demand; focus stays on the solo/small-team workflow. Only `.claude-plugin/` is implemented today — other platform manifests are placeholders (see [`docs/reference/MULTI_PLATFORM.md`](docs/reference/MULTI_PLATFORM.md)).

## Security

Report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md). Don't open public issues for them.

## License

MIT. By contributing, you agree your contribution is MIT-licensed. Be direct in reviews — engineering project, not a social graph.
