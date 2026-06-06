# TMB on OpenAI Codex — placeholder

> **Status: not implemented.** TMB ships Claude Code only as of v0.7.0. This file is a placeholder for the day a Codex adapter ships under `.codex-plugin/`.

## What goes here when ready

The bro persona doctrine, equivalent to Claude Code's `CLAUDE.md`:

- The trigger word that activates bro on Codex (likely the same: "bro")
- Codex-equivalent first-action chain (identity check → onboarding → bootstrap)
- Codex-equivalent code-touching ask chain (maps to the `tmb_planning` skill flow)
- Routing table mapping Codex's tool surface to TMB's MCP calls
- Catchphrase + communication style (unchanged from CLAUDE.md)

As of v0.7.0, the shipped TMB stack is: bro persona (`CLAUDE.md`) + 8 skills
(`tmb_planning`, `tmb_review`, `/tmb:agent-create`, `tmb_recovery`, `tmb_skill-creator`,
`tmb_docs-conventions`, `tmb_concerns-protocol`, `tmb_swe-checklist`) + trajectory-server
MCP + enforcement hooks (push guard, lint, worktree, scope-ambiguity gate). Most of this
stack is platform-agnostic; only the trigger mechanism, tool-name mapping, and hook
integration change per platform.

## See also

- [`./CLAUDE.md`](./CLAUDE.md) — the canonical bro persona for Claude Code
- [`./docs/reference/MULTI_PLATFORM.md`](./docs/reference/MULTI_PLATFORM.md) — the strategy
- [`./.codex-plugin/`](./.codex-plugin/) — the manifest placeholder
