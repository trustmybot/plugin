# TMB on OpenAI Codex

> **Current scope:** explicit, project-local Bro planning only.

Invoke `$tmb-bro` when you want Codex to inspect a selected Git worktree, build
or query TMB's project inventory and world model, clarify a request, and save an
approved local planning issue with decision records. The Skill is deliberately
not injected implicitly.

Before issue creation, the Skill reads the project's exact classification and
priority taxonomy. Generic projects keep the `Feature` + `Priority: Medium`
default; configured projects require an explicit choice from their own labels.
When the user explicitly asks to configure those labels, the bounded
`planning_label_taxonomy_set` tool atomically replaces both project-local arrays;
no arbitrary configuration surface is exposed.

Every MCP call requires the absolute Git worktree root. TMB rejects a non-root,
unignored, tracked, or unsafe `.tmb/` state path before writing and confines all
state to `<project>/.tmb/tmb/`. Codex never adopts or modifies `.claude/` state.
Planning issue creation forces remote synchronization off even when the project
has a configured Git remote.

Scope 3 stops after planning. It does not expose task execution or status
mutation, agent spawning, review records, branch/worktree orchestration, Git
commit/push/merge, pull-request operations, remote issue mutation, onboarding,
or lifecycle enforcement Hooks. The empty Codex Hook manifest remains an
explicit degradation: native Codex shell, edit, and Git paths are outside TMB's
Scope-3 enforcement boundary.

The exact 13-tool MCP allowlist and contribution boundary are documented in
[`docs/contributing/CODEX_PORT.md`](docs/contributing/CODEX_PORT.md). Capability,
identity, and security deltas are declared in
[`docs/adapters/codex/PARITY.md`](docs/adapters/codex/PARITY.md).
