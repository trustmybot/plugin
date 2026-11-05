# L3 — Integration

Deterministic integration tests that exercise the real wiring — the MCP server as a subprocess over JSON-RPC stdio, and the hook scripts against synthetic events. L3 catches what L2 cannot: schema drift, a missing `agent` param, role-enforcement plumbing, and hook deny/inject behavior at the wire level. Each subdir has its own `run.sh`; both run as part of `tests/run-all.sh`.

| Subdir | Purpose |
|---|---|
| [`mcp/`](./mcp/) | Real server subprocess + JSON-RPC tests — role matrix, schema contract, scope gate, search tools, and per-agent workflow sequences. Shared harness in `harness.mjs`; run via `mcp/run.sh` |
| [`hooks/fixtures/`](./hooks/fixtures/) | Fixtures (goldens, legacy settings, changelog fragments, enums-stable sources) read by the hook suites, which are node:test `mcp/trajectory-server/src/test/*-l3.test.ts` files built on `src/test/hook-sandbox.ts` |

## Hermetic hook tests

- Stub `pgrep` on `PATH` in any test that runs activation-routine or mcp-health-check, so host processes don't change the result (see the stub in [`activation-routine-l3.test.ts`](../../mcp/trajectory-server/src/test/activation-routine-l3.test.ts)).
- Never assert what `sqlite3 -readonly` can open: it varies by sqlite version. Probe it and branch.
- Never reassign `TMPDIR` in a test; use a local `WORK` dir. `run.sh` exports `TMPDIR` for its footprint check, and GNU `mktemp` fails once a test has removed the exported dir. Older tests still assign `TMPDIR` themselves and predate this rule.
- Create temp dirs with an explicit template under `$TMPDIR` and remove them. macOS `mktemp -d` ignores `TMPDIR`, so a leak passes `run.sh`'s footprint check locally and fails on Linux CI.
- Reproduce a footprint failure with a per-test Docker loop (`node:22-bookworm` with sqlite3 and jq, as a non-root user).
