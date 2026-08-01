# TMB Codex adapter

> **Scope 2 status:** packaged runtime initialization only. The Claude workflow, agents, skills, and hooks are not exposed to Codex yet.

The Codex manifest points to two platform-specific components:

- `adapters/codex/.mcp.json` starts the isolated `dist/codex.js` entry point.
- `hooks/codex/hooks.json` is intentionally empty, preventing Codex from auto-loading the existing Claude hook file.

The only MCP tool in this scope is `runtime_initialize`. It requires an explicit absolute Git worktree root whose Git ignore rules exclude `.tmb/` and rejects any already-tracked `.tmb/` state. State is created beneath `<project>/.tmb/tmb/`; the adapter never writes `.claude/`. The SQLite foundation opens immediately, while the optional graph holder remains lazy so graph lock contention cannot block initialization.

The shared database and graph implementations remain the source of truth. Codex-specific packaging and dispatch are thin edge adapters and must not change the existing Claude entry point or tool registry. See [`../docs/contributing/CODEX_PORT.md`](../docs/contributing/CODEX_PORT.md).
