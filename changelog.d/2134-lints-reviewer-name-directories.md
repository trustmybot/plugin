### Fixed
- **`legacy-reviewer-name` and `no-directories-table-refs` pass on `dev` again** (GH 2134): the research question about the v50 to v51 rename is allowlisted, and the two bundles that inline the historical migrations, `dashboard/dist/server.mjs` and `mcp/trajectory-server/dist/run-scan.js`, are exempt by exact path, so a new file or any other bundle still fails.
