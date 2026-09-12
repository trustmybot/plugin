# L2 — MCP handler unit tests

L2 tests live with their package at `mcp/trajectory-server/src/test/*.test.ts`,
following the TypeScript package convention of colocating tests with source.

The exception is `codex-hooks.test.mjs`: the Scope 5 Hook policy is a
repository-root, zero-dependency ESM runtime rather than part of the MCP
package, so its pure policy and dispatcher tests stay in this L2 directory.

Run via the L2 step of `tests/run-all.sh`:

```bash
(cd mcp/trajectory-server && bun run build && node --experimental-sqlite --test dist/test/*.test.js)
```

Run the Codex Hook policy tests directly with:

```bash
node --test tests/l2-mcp-unit/codex-hooks.test.mjs
```
