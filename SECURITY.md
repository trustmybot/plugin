# Security Policy

## Supported Versions

This project is pre-1.0 and ships from a single trunk. Only the latest stable release receives security fixes. RCs (`vX.Y.Z-rc.N`) are not separately supported — fixes land in the next stable cut.

| Version | Supported |
| ------- | --------- |
| Latest stable (`tmb@trustmybot`) | ✅ |
| Latest RC (`tmb-rc@trustmybot`) | ✅ (rolled into next stable) |
| Older releases | ❌ — upgrade |

## Reporting a Vulnerability

**Please do not file public issues for security vulnerabilities.**

Use GitHub's [private vulnerability reporting](https://github.com/trustmybot/plugin/security/advisories/new) — this opens a private advisory thread with the maintainer.

Expected response: acknowledgement within 7 days, fix or disposition within 30 days for confirmed vulnerabilities. Coordinated disclosure timeline negotiated case-by-case.

## Scope

In scope:

- The MCP server (`mcp/trajectory-server/`) and its SQLite handling
- Hook scripts that run during git operations (`scripts/hooks/`)
- Plugin install / marketplace artifacts

Out of scope:

- Bugs in agent prompts producing incorrect behavior — file as a regular issue
- Vulnerabilities in upstream Claude Code itself — report to Anthropic
- Vulnerabilities in user-installed agents/skills not shipped by this plugin
