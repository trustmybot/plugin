# Manual tests (Layer 3 — human-run)

The automated layers (`tests/mcp-integration/`, `mcp/trajectory-server/src/test/`, `tests/hooks/`, `tests/lint/`) cover schema, protocol, role enforcement, per-agent workflows, and hook behavior. None of them can validate what depends on real LLM judgment: routing quality, prompt drift, UX, whether bro actually decides to spawn architect for a code-touching ask.

That's what this directory is for. Everything here is run by a human, in an interactive Claude Code session, against a disposable scratch project.

## Files

| File | Purpose |
|---|---|
| [`setup.md`](./setup.md) | Environment setup — install modes (A/B), DB verification commands, hot reload, reset-between-tests, common pitfalls |
| [`scenarios.md`](./scenarios.md) | Test catalog — 30+ scenarios mapped to [`docs/architecture/FLOWS.md`](../../docs/architecture/FLOWS.md), each with trigger prompt + expected agent chain + expected MCP calls + verification SQL |

## How to use

1. Follow [`setup.md`](./setup.md) to launch a scratch session.
2. Walk [`scenarios.md`](./scenarios.md) — one scenario at a time. Each has 8 sections: prerequisites, trigger prompt, expected agent chain, expected MCP tool calls, expected hooks, expected user-visible output, expected DB state, verification SQL + pass checkbox.
3. Reset between scenarios with `rm -rf .claude/tmb/` in the scratch project.
4. For any scenario that deviates from expected, file a GitHub issue quoting the scenario ID and the observed output.

## When to run

- **Before tagging a release** — walk at minimum every scenario in the "blocker" set (currently: 1.1, 2.1, 3.1, 6.1, 8.1).
- **After changing an agent prompt** — re-run scenarios that exercise that agent.
- **After changing `first-run-onboarding` or `tmb_reonboard`** — re-run Flow 1.
- **When an automated test passes but something still feels wrong** — likely a symptom the automated layers don't cover. Walk the relevant scenario.

## Why this is in `tests/` and not `docs/`

The scenarios ARE tests — they have trigger prompts, expected outputs, verification commands, and pass/fail checkboxes. They're just executed by a human instead of `node --test`. Colocating them with the other test artifacts matches the pattern used by Chromium, Kubernetes, VS Code, and other projects with substantial manual-test surfaces.

The conceptual framework — why three layers, when to add a test to which layer — lives at [`tests/README.md`](../README.md) alongside the operational how-to. That's the doc to read for rationale; this one is the doc to read when running Layer 3 specifically.
