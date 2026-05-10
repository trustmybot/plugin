# Manual smoke

L0–L5 are automated (Docker install-smoke, lint, MCP unit + integration, workflow simulation, dogfood, release canary). Manual smoke is the residue — Claude-side behaviors that have no automated test surface: trigger detection, AskUserQuestion radio rendering, agent spawn isolation, subagent prompt precedence, tone, real worktree creation.

## Files

| File | Purpose |
|---|---|
| [`setup.md`](./setup.md) | **Read this first.** Two test paths explained: Path A (local `claude --plugin-dir`, fast iteration) vs Path B (marketplace `/plugin install tmb@trustmybot-rc`, REQUIRED for RC validation). Plus reset, hot reload, common errors, the Docker install-smoke fallback (Path C). |
| [`scenarios.md`](./scenarios.md) | The 10-item manual-smoke checklist. Walk every item against the install you're validating. |

## When to run

| Trigger | Path | Required? |
|---|---|---|
| Active development on a feature/skill/hook | A (local) | optional, for sanity |
| About to merge a PR that touches install path / schema / agent doctrine | A then C | yes |
| Validating a release candidate before promoting `tmb-rc` → `tmb` (stable) | **B (marketplace RC) — mandatory** | yes |
| About to tag a release | walk Path B + set `MANUAL_DOGFOOD_PASSED=v<X.Y.Z>` | yes (`scripts/release.sh` enforces) |
| Hotfix release that demonstrably can't change Claude-side behavior | skip with `BYPASS_DOGFOOD=1` | no — but document the bypass reason in the release commit |

## Why Path B is mandatory for RC validation

v0.2.0 and v0.3.0 both shipped install-path bugs that broke every stable user. Both were validated locally via Path A and passed. **Path A doesn't exercise the marketplace install lifecycle** (`bun install --ignore-scripts`) where both bugs lived. Path B is the only manual path that catches that bug class.

The companion automated test (Path C — `tests/docker/run-install-smoke.sh`) catches it in CI starting v0.3.1, but manual smoke also requires a real-CC walk because Claude-side behaviors (trigger word, AskUserQuestion, etc.) aren't testable in Docker.

## Why this is in `tests/` and not `docs/`

These ARE tests — they have setup, expected behavior, verification commands, and pass/fail conditions. Just executed by a human instead of `node --test`. Colocating them with the other test artifacts matches the pattern used by Chromium, Kubernetes, VS Code, and other projects with substantial manual-test surfaces.
