### Changed
- **The tool-description budget lint no longer measures a stale build** (GH 2492, GH 2064): it rebuilds the MCP server when `dist/index.js` is missing or older than any file under `mcp/trajectory-server/src/`, instead of only when it is missing, so an out-of-date dist can no longer report a false budget failure.
