# L3 — Integration

Deterministic integration tests that exercise the real wiring — the MCP server as a subprocess over JSON-RPC stdio, and the hook scripts against synthetic events. L3 catches what L2 cannot: schema drift, a missing `agent` param, role-enforcement plumbing, and hook deny/inject behavior at the wire level. Each subdir has its own `run.sh`; both run as part of `tests/run-all.sh`.

| Subdir | Purpose |
|---|---|
| [`mcp/`](./mcp/) | Real server subprocess + JSON-RPC tests — role matrix, schema contract, scope gate, search tools, and per-agent workflow sequences. Shared harness in `harness.mjs`; run via `mcp/run.sh` |
| [`hooks/`](./hooks/) | Hook-script tests — one `*.test.sh` per hook asserting deny/inject/pass-through behavior (git guards, swe gates, sandbox isolation, cheatcode flow, …). Run via `hooks/run.sh`; shared fixtures in `hooks/fixtures/` |
