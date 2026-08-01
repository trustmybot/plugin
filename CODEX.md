# TMB on OpenAI Codex

> **Current scope:** project-bound runtime initialization only.

The Codex package currently exposes `runtime_initialize` through its bundled MCP server. It does not yet expose the bro workflow, Claude agents, skills, or lifecycle hooks.

Call `runtime_initialize` with the absolute Git worktree root after confirming the repository ignores `.tmb/` and does not track files below it. The adapter creates or reuses state only under `<project>/.tmb/tmb/`. It proves the SQLite schema during the call and leaves the optional graph holder unopened so graph lock contention cannot block the MCP process.

Implementation boundaries are documented in [`docs/contributing/CODEX_PORT.md`](docs/contributing/CODEX_PORT.md),
and current capability and enforcement differences are declared in
[`docs/adapters/codex/PARITY.md`](docs/adapters/codex/PARITY.md).
