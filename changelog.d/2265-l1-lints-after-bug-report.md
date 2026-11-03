### Fixed
- **The no-cwd-reads, tool-families-documented and audit from_node lints pass again** (GH 2265): the bug-report tools left three L1 lints red. The bug-report project-root cwd fallback gets a cwd-allowlist entry, REFERENCE.md states the 81 tools the server registers, and the tmb_recovery skill's `bug_report_filed` audit call names `from_node='bro'`.
