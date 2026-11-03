### Fixed
- **The `bundle-whitespace-safety` lint passes again** (GH 2273): `.gitattributes` now marks the generated `mcp/trajectory-server/dist/cli.js` bundle `-whitespace` like the other bundles, so git no longer flags whitespace inside it.
