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

### Branching & merging

1. **Feature branches come from `dev`** and are named by git convention (`feat/`, `fix/`, `docs/`, `chore/`, `test/` + slug). One concern per branch.
2. **Nothing merges to `main` except `dev`** — and only when `dev` carries an rc tag whose release-gate CI passed (Phases B–C of Release). Promotion is a **merge commit** (Phase D). *Exception:* docs-only changes that need no functionality test may merge to `main` directly — and must be mirrored back to `dev` in the same sitting so the branches never drift.
3. **Typical feature workflow:** branch from `dev` → implement → local L0–L4 green → PR → `dev`. If your branch is the **last one planned before a release**, also run the local L6 chain — at that point you're in the Release workflow (Phase B); follow it.
4. **All integration goes through GitHub PRs** — `gh pr create` / `gh pr merge`. Never `git merge` locally, never push directly to `dev` or `main`.
5. **Merge policy by surface:** code / docs / tests PRs auto-merge once checks are green. Prompt-surface PRs (`agents/`, `skills/`, `commands/`, `templates/`, `CLAUDE.md`) never auto-merge — a maintainer reviews the PR itself.
6. **CI-affecting changes** (workflows, gate scripts, L5/L6 harness) must pass a full release-gate `workflow_dispatch` on the feature branch *before* merge — `dev` stays green at all times; a tag-triggered gate is never the first time CI sees your change.
7. **Delete branches on merge** (`--delete-branch`); a stale branch is a future wrong-base.
8. **Prompt engineering follows [`docs/prompt-engineering/DETERMINISM.md`](docs/prompt-engineering/DETERMINISM.md)** — grade every new or changed prompt against its rubric; nothing ships below **A-**.

## CI (GitHub Actions)

`.github/workflows/release-gate.yml` is **not** wired to dev pushes or PRs — it runs only on:
- **rc tags (`vX.Y.Z-rc.N`) + manual dispatch** → L1–L4 **+ L6 chain** (`tests/l5-l6/run-l6-chain.sh`) **+ L0 docker install-smoke**. Stable tags do not fire the gate; the stable cut consumes the promoted rc's verdict.

Per-PR validation to `dev` is the **local L0–L4 sweep (`tests/run-all.sh`) + pr-reviewer** — there is no automatic PR-CI on `dev`. CI-affecting changes additionally run a `workflow_dispatch` release-gate on the feature branch before merge (rule 6 above).

L6 needs the `CLAUDE_CODE_OAUTH_TOKEN` repo secret; chain logs upload as a run artifact.

## Issues & PRs

### Milestones

- Every issue and every PR carries a milestone — the release expected to ship it. Assign at creation; re-milestone if it slips (never leave one unmilestoned).
- Milestone hygiene is part of the release ritual: Phase A isn't done while the milestone has open items — close them, move them, or ship them.

### Issue ↔ PR linkage

- A PR that resolves an issue (the normal case) declares it with a closing keyword in the PR **description** — `Closes #N` / `Fixes #N` — so GitHub links the two bidirectionally. Comment-mentions don't create links; use the description.
- PRs merge into `dev`, where GitHub's auto-close does not fire. Whoever merges closes the issue manually with a comment naming the PR and landing commit (e.g. "Fixed in #530 @ `af89a30`"). The issue is closed only after its PR is merged, never before.
- A PR with no issue (release mechanics, typo-class fixes) says so in its description in one line.

## Release

`scripts/maintenance/bump-version.sh <version>` keeps the version in sync across all three manifests.

**Phase A — candidate**
1. Land everything intended for the release on `dev` via the normal PR flow (auto-merge policy applies).
2. Bump PR on a branch off `dev`: `bump-version.sh X.Y.Z-rc.N` + a `## vX.Y.Z-rc.N` CHANGELOG section → PR → `dev`.

**Phase B — local pre-flight**
3. Run the full local L6 chain (`bash tests/l5-l6/run-l6-chain.sh`) on the exact `dev` tree you intend to tag. **15/15 green clears you to cut the rc tag** — this is pre-flight to keep the tagged CI gate from going red, not the sign-off itself (that's Phase C, step 8).
4. On any step failure: reproduce and debug with the matching L5 row (`bash tests/l5-l6/run-l5.sh <row>`), fix on `dev` through the normal flow, then **resume the chain from the failed step** (`run-l6-chain.sh --from <step>`). Iterate until the chain completes.
5. Whether the resumed 15/15 clears you to tag depends on what the fix touched:
   - Fix confined to **test fixtures, scorers, or docs** → the resumed pass stands; tag.
   - Fix touched **runtime** (`mcp/`, `scripts/hooks/`, schema, `agents/`, `skills/`, `commands/`, `CLAUDE.md`) → finish with **one full fresh chain**, because steps before the failure ran on pre-fix code and their green doesn't transfer.

**Phase C — rc**
6. Tag `vX.Y.Z-rc.N` on `dev`, push — this fires the CI release-gate (L1–L4 + L6 + L0) that is the sign-off (step 8). Fast-forward the `rc` branch to the tag.
7. **Publish to the rc channel**: run `bash scripts/publish-rc-channel.sh` — it clones `trustmybot/marketplace-rc`, points `plugins[].source.ref` at the new rc tag, writes the channel README if missing, and pushes. Installs of `tmb@trustmybot-rc` now serve the rc. (Refuses non-rc versions; verifies the tag is on origin first; idempotent; `--dry-run` previews, `--yes` skips the prompt.)
8. The CI release-gate (L1–L4 + L6 + L0) on the exact tree you tag is the gate — the automated layers are the sole sign-off.

**Phase D — stable**
9. Final bump PR (`X.Y.Z`) → `dev`.
10. **Functional-identity rule**: the stable tag must be functionally identical to the latest green rc. Permitted deltas after the rc: version manifests, CHANGELOG, `docs/`, README-class files. Anything else — plugin code, prompts, hooks, MCP server, schema, CI workflows — invalidates the rc: cut `rc.N+1` and repeat Phases B–C.
11. Promotion PR `dev → main` as a **merge commit**; merge.
12. `git checkout main && git pull`, then `bash scripts/release.sh` — it tags `v<plugin.json version>` on `main` HEAD, pushes the tag, cuts the GitHub release from the matching CHANGELOG section, and runs the Docker install canary. Each step asks y/N and skips if already done (safe to re-run); it refuses off-`main`, on a dirty tree, or on a version/CHANGELOG mismatch.
13. The stable catalog (`trustmybot/marketplace`) pins `ref: "main"` — promotion updates it automatically; no catalog edit.
14. **Re-pin the rc channel to the stable tag**: `release.sh` step 6 does this automatically — it runs `bash scripts/publish-rc-channel.sh --stable-repin --yes <version>`, which points `trustmybot/marketplace-rc`'s `plugins[].source.ref` at the new `vX.Y.Z` so rc-channel installs converge on the released build between rc cycles (idempotent; fail-forward — the release is already public). Manual fallback if the step was skipped or failed: `bash scripts/publish-rc-channel.sh --stable-repin <version>`.
15. **Canary red = fix-forward immediately** — the release is already public. Diagnose before announcing; never delete the tag.

## Writing code & tests

- Self-documenting code; prefer deletion over addition; match the file's existing patterns. TypeScript for the MCP server, Bash for hooks. Emoji + Conventional Commit messages.
- Every change ships its test: MCP → `mcp/trajectory-server/src/test/*.test.ts`; hook → `tests/l3-integration/hooks/*.test.sh`; new enforcement → a lint in `tests/l1-lint/`.
- Prompt / skill / doc changes have no automated test — they rely on the CI release-gate (L0–L6) and PR review for sign-off.

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
