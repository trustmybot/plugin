# TMB on OpenAI Codex — placeholder

> **Status: not implemented.** TMB ships Claude Code only as of v0.1.1. This file is a placeholder for the day a Codex adapter ships under `.codex-plugin/`.

## What goes here when ready

The bro persona doctrine, equivalent to Claude Code's `CLAUDE.md`:

- The trigger word that activates bro on Codex (likely the same: "bro")
- Codex-equivalent first-action chain (identity check → onboarding → bootstrap)
- Codex-equivalent code-touching ask chain
- Routing table mapping Codex's tool surface
- Catchphrase + communication style (unchanged from CLAUDE.md)

Most of the doctrine — the planning skill (`tmb_planning`), the SWE template, the push-gate flow, the bro-as-task-gate role — is already platform-agnostic. Only the trigger mechanism and tool-name mapping change between platforms.

## See also

- [`./CLAUDE.md`](./CLAUDE.md) — the canonical bro persona for Claude Code
- [`./docs/MULTI_PLATFORM.md`](./docs/MULTI_PLATFORM.md) — the strategy
- [`./.codex-plugin/`](./.codex-plugin/) — the manifest placeholder
