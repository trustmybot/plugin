### Fixed
- **The L4 workflow simulations no longer call the claude CLI** (GH 1420): the shared MCP test harness pins TMB_DISABLE_CHEATCODE_HEALTHCHECK=1 for every server it starts, so the sweep's live-CLI guard passes again.
