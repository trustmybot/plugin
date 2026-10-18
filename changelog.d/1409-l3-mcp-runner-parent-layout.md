### Fixed
- The L3 MCP runner no longer exits silently before its first test when the checkout's parent directory is not a git repository; the live-DB shim's optional ancestor lines are status-neutral under `set -e` (GH 1409).
