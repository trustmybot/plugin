# L2 — MCP handler unit tests

L2 tests live with their package at `mcp/trajectory-server/src/test/*.test.ts`,
following the TypeScript package convention of colocating tests with source.

Run via the L2 step of `tests/run-all.sh`:

```bash
(cd mcp/trajectory-server && bun run build && node --experimental-sqlite --test dist/test/*.test.js)
```
