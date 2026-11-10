### Fixed
- **The `scripts/lib` README points to the hook engine's shared helpers where they now live** (GH 2702): its link to the hook helpers still targeted `scripts/hooks/lib/`, which after the TypeScript port (GH 1692) holds only generated files. It now links `mcp/trajectory-server/src/hooks/lib/`.
