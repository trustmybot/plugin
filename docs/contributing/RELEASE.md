# Releasing

Maintainer-only: dev builds, the release gate, and cutting rc and stable releases. Contributors need none of this; see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Dev builds

Every push to `dev` runs `.github/workflows/dev-build.yml`. Its `stamp` job stamps the manifests with `X.Y.Z-dev.<n>.gh<PR>` (e.g. `1.2.0-dev.7.gh1594`) and force-pushes the runtime-only result to `dev-build`, which `tmb@trustmybot-dev` serves. `scripts/maintenance/runtime-payload.ts` prunes every tracked path outside its runtime allowlist before the build commit, keeping `.github/` because a `GITHUB_TOKEN` push may not change workflow files.

- `X.Y.Z` is the release `dev` is heading for: the lowest open `vX.Y.Z` milestone above the latest stable tag, else that release with the minor bumped. The build fails if it is not above the latest release.
- `<n>` counts first-parent commits on `dev` since the latest stable release (rc tags don't count): one per merged PR, reset at each release. `n` orders builds.
- `gh<PR>` names the PR whose merge produced the build. It is a label, not an order; a direct dispatch omits it.

**Is a fix in my build?** Your build has it when its `n` is at least the `n` of the build that shipped the fix's PR (same `X.Y.Z`).

**Dev channel or rc?** The dev channel serves merged work as it lands, checked only per PR. Cut an rc when you have a candidate to ship; only an rc goes through the release gate. To switch channels or upgrade, see [INSTALL.md](../reference/INSTALL.md) and [UPGRADE.md](../reference/UPGRADE.md); each dev build also comments its version and upgrade commands on its PR.

## Release gate

`.github/workflows/release-gate.yml` runs L1–L4, the L6 chain (`tests/l5-l6/run-l6-chain.ts`) and the L0 install smoke (Linux in Docker, macOS and Windows host-native). It runs only on rc tags (`vX.Y.Z-rc.N`) and manual dispatch from `rc` or `main`; its `ref-guard` job refuses any other ref, and no `dev` PR or merge waits for it. Stable tags do not fire it: the stable cut consumes the promoted rc's verdict. L6 needs the `CLAUDE_CODE_OAUTH_TOKEN` repo secret, which forks cannot read; chain logs upload as a run artifact.

## Release steps

`node --experimental-strip-types scripts/maintenance/bump-version.ts <version>` keeps the version in sync across the Claude manifest, workspace package, MCP package and lockfile, and writes the version's CHANGELOG section from the `changelog.d/` fragments.

**Phase A — candidate**
1. Land everything for the release on `dev` through normal PRs, and empty the milestone: close, move or ship every open item. A contributor's PR never sets a prerelease suffix; release identity is the maintainer's call.
2. Bump PR off `dev`: `bump-version.ts X.Y.Z-rc.N` → PR → `dev`.

**Phase B — local pre-flight**
3. Run the local L6 chain (`node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts`) on the exact `dev` tree you will tag. 15/15 green clears you to tag; it keeps the CI gate from going red but is not the sign-off (step 8). Fast-forward `rc` to that commit, dispatch the gate from it (`gh workflow run release-gate.yml --ref rc`), and tag only on green; the tag push reuses the green same-SHA verdict (within 48h).
4. On a failed step, reproduce with the matching L5 row (`tests/l5-l6/run-l5.ts <row>`), fix on `dev` through the normal flow, then resume with `run-l6-chain.ts --from <step>`. A step that needs the network is made hermetic (a fixture env var or file), never re-rolled until it passes.
5. A fix confined to test fixtures, scorers or docs lets the resumed pass stand. A fix that touched runtime (`mcp/`, `scripts/`, schema, `agents/`, `skills/`, `commands/`, `CLAUDE.md`) needs one full fresh chain, because the steps before the failure ran on pre-fix code.

**Phase C — rc**
6. Tag `vX.Y.Z-rc.N` on that commit and push; this fires the release gate. `rc` already points at it (step 3).
7. Publish to the rc channel: `node --experimental-strip-types scripts/publish-rc-channel.ts` waits for `release-payload.yml` to push `payload/vX.Y.Z-rc.N`, then points `trustmybot/marketplace-rc` at it. It refuses non-rc versions and is idempotent; `--dry-run` previews, `--yes` skips the prompt.
8. The CI release gate on the tagged tree is the sole sign-off. If it goes red, re-pin the rc channel to the previous rc (`publish-rc-channel.ts <prev> --yes`) and delete the rc tag.

**Phase D — stable**
9. Final bump PR (`X.Y.Z`) → `dev`.
10. The stable tag must be functionally identical to the latest green rc. Permitted deltas: version manifests, CHANGELOG, `docs/`, README-class files, `tests/`, `.github/workflows/`. Anything that ships (plugin code, prompts, hooks, MCP server, schema) invalidates the rc: cut `rc.N+1` and repeat Phases B–C.
11. Promotion PR `dev → main` as a merge commit; merge. Only `dev` merges to `main`, and only carrying a green rc gate. Docs-only changes may merge to `main` directly if mirrored to `dev` in the same sitting.
12. `git checkout main && git pull`, then `node --experimental-strip-types scripts/release.ts`: it tags `v<plugin.json version>`, pushes the tag, cuts the GitHub release from the CHANGELOG section and runs the Docker install canary. Each step asks y/N and skips if done; it refuses off `main`, on a dirty tree, or on a version/CHANGELOG mismatch.
13. On each stable tag, `release-payload.yml` pushes the runtime-only build as `payload/vX.Y.Z` and force-pushes it to `stable-build`. The stable catalog (`trustmybot/marketplace`) moves from `ref: "main"` to `ref: "stable-build"` by the manual repin in GH 1888; until then promotion updates it through `main`.
14. `release.ts` step 6 re-pins the rc channel to the stable build (`publish-rc-channel.ts --stable-repin --yes <version>`), so rc installs converge on the release between rc cycles. Rerun it by hand without `--yes` if it was skipped or failed.
15. A red canary means fix forward at once: the release is already public. Diagnose before announcing; never delete the tag.
