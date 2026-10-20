# `.opencode/` — placeholder for OpenCode adapter

> **Status: not implemented.** This directory is a placeholder so the repo's structure mirrors the multi-platform pattern (Claude / Codex / Cursor / OpenCode / Gemini). TMB ships Claude Code only.

## What this would be

Once implemented, this directory would hold the OpenCode adapter:

- `plugins/tmb.js` — OpenCode plugin entry point (auto-discovers `./skills/` from repo root)
- An `INSTALL.md` documenting the install path: `claude plugin install tmb@trustmybot --scope project` (or equivalent; see [Recommended scope](../docs/reference/INSTALL.md#recommended-scope-project-or-local))

OpenCode uses native skill auto-discovery, so the manifest is thinner than other platforms.

## When this gets built

When OpenCode adoption justifies a maintained adapter. Tracking issue applies.
