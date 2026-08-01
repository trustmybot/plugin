# Codex adapter parity declaration

This page is the Codex adapter's required declaration under the
[Platform Adapter Contract](../ADAPTER_CONTRACT.md). It records current
capabilities and enforcement, not planned parity.

**Declaration date:** 2026-08-01

**Implemented scope:** Scope 2, project-bound `runtime_initialize` only (GH
1157)

**Reference adapter:** Claude Code

The Codex package currently selects an empty Hook manifest and exposes no TMB
workflow tools, agents, or skills. Consequently, every load-bearing workflow
gate is a declared Tier-3 degradation for Scope 2, even where a future Codex
surface could reuse a server-side implementation. The principal compensation
is narrow and specific: the Scope-2 TMB MCP entry point cannot invoke any of
those workflow handlers because it exposes only `runtime_initialize`. This does
not constrain Codex's native shell, edit, Git, or other non-TMB tool paths.

## Capability declaration (Rule 5)

| Capability | Codex value | Evidence and current TMB use |
|---|---|---|
| Deny-capable pre-tool hooks | **Yes, conditional** | `PreToolUse` can deny supported local tool paths. Non-managed and plugin-bundled Hooks are skipped until the user trusts the exact current Hook hash, and some tool paths can bypass the default Hook path. TMB ships no functional Codex Hooks in Scope 2. |
| Per-agent tool restriction | **No documented equivalent** | Custom agents can override session configuration such as sandbox mode, MCP servers, and skills, but the current public contract does not establish a Claude-style per-tool allowlist. TMB therefore cannot claim structural pr-reviewer read-only parity. |
| Structured-question UI | **Surface-dependent; not relied upon** | Interactive Codex surfaces may offer structured input, but no portable plugin-level contract is used by Scope 2. TMB does not claim roundtable question-shape enforcement. |
| Subagent spawn with per-child config | **Yes on supported local clients** | Custom agents can select model, reasoning effort, sandbox mode, MCP servers, skills, and developer instructions. Scope 2 does not ship TMB Codex agents or spawn orchestration. |
| Native worktree isolation | **Desktop-only** | Codex-managed worktrees are documented for the ChatGPT desktop app, not as a cross-surface Codex guarantee. Scope 2 accepts normal and linked Git worktrees but does not create or orchestrate them. |
| Writable project-state dir | **Yes** | `runtime_initialize` requires an explicit canonical Git worktree and writes only below its ignored `<project>/.tmb/tmb/` directory. |
| Trusted human-input signal | **No** | The Codex MCP call contract does not give TMB a cryptographically trusted Human identity. Scope 2 exposes no Human-authored workflow writes. |

The shared core must branch on these capabilities, never on a literal Codex
host name. A surface-specific capability stays unavailable to shared workflow
logic until the adapter can prove and declare it for that surface.

## Enforcement parity matrix (Rule 4)

Canonical gate behavior and source locations remain owned by
[`ENFORCEMENT.md`](../../prompt-engineering/ENFORCEMENT.md). The current tier is
Tier 3 for every row: Scope 2 exposes neither the shared workflow handler nor a
Codex-native enforcement translation. A future mechanism names a promotion
candidate, not a capability that ships today.

| Gate | What it enforces | Canonical evidence | Current tier | Future mechanism | Degradation and compensation |
|---|---|---|---|---|---|
| Activation routine | Injects onboarding and pending-work state at session/prompt boundaries. | Bro matrix | Tier 3 | Session/UserPrompt Hook | No Codex activation routine ships; the package documents its explicit single-call entry point. |
| First-contact onboarding | Starts onboarding automatically for an uninitialized user. | Bro matrix | Tier 3 | Session/UserPrompt Hook | No Codex bro persona or onboarding workflow ships. |
| Bro source-edit boundary | Prevents the orchestrator from editing implementation files. | Bro matrix | Tier 3 | `PreToolUse` on edits and shell | No Codex bro exists, and TMB exposes no workflow edit tools. Native Codex edits remain outside this guarantee. |
| Project-state ignore setup | Ensures host state is ignored before it can be written. | Bro matrix | Tier 3 | Session Hook | Codex never edits `.gitignore`; `runtime_initialize` fails before writes unless `.tmb/` is already ignored and untracked. |
| Branch creation ownership | Keeps task-branch creation with bro rather than SWE. | Bro/SWE matrices | Tier 3 | `PreToolUse` on shell | No Codex bro/SWE workflow or branch orchestration ships. |
| Branch freshness before task work | Requires a task branch to descend from the configured remote base. | Bro/SWE matrices | Tier 3 | `PreToolUse` on shell | No Codex task attach or SWE workflow ships. |
| Worktree creation | Creates task worktrees at the canonical isolated location. | SWE matrix | Tier 3 | Adapter-owned orchestration | Desktop-managed worktrees are not a cross-surface guarantee; Scope 2 only validates a worktree supplied by the caller. |
| Worktree cleanup | Removes the task worktree after a verified close. | Bro matrix | Tier 3 | `PostToolUse` or adapter orchestration | Scope 2 exposes no task close or cleanup workflow. |
| World-model-cold task gate | Blocks task creation until the project model is ready or explicitly waived. | Bro matrix | Tier 3 | Shared `task_create_batch` handler (Tier 1 candidate) | The shared handler is not exposed; the single-tool Codex registry cannot create tasks. |
| World-model refresh after close | Refreshes the project model after an atomic task close. | Bro matrix | Tier 3 | `PostToolUse` | Scope 2 exposes neither close nor scan orchestration. |
| MCP role scoping | Restricts workflow handlers to the roles allowed by the shared contract. | Bro, SWE, pr-reviewer, and consultant matrices | Tier 3 | Shared `requireRoles` middleware (Tier 1 candidate) | No role-bearing handler is exposed, and caller-supplied identity would remain spoofable. |
| Reviewer session evidence | Requires validation records to name the independent reviewer session. | Bro/pr-reviewer matrices | Tier 3 | Shared `validation_record` handler (Tier 1 candidate) | No validation tool is exposed. |
| Validation MCP-availability evidence | Requires reviewer records to provide the typed `mcp_available` boolean. | Shared `validation_record` handler | Tier 3 | Shared handler validation (Tier 1 candidate) | No validation write is exposed. |
| Verified-Human discussion write | Rejects Human-authored discussion claims without the required verification assertion. | Bro matrix | Tier 3 | Shared discussion handler plus trusted identity (Tier 1 candidate) | No discussion tool is exposed, and the current boolean assertion is not a trusted Human signal. |
| Remote issue-sync default-off | Prevents remote synchronization unless explicitly enabled. | Bro matrix | Tier 3 | Shared config and sync backend (Tier 1 candidate) | No issue-sync tool is exposed. |
| Roundtable state transitions | Rejects invalid roundtable lifecycle transitions. | Bro matrix | Tier 3 | Shared roundtable handlers (Tier 1 candidate) | No roundtable tool is exposed. |
| Roundtable question shape | Requires the discrete Human-question shape during roundtable voting. | Bro matrix | Tier 3 | No portable mechanism declared | No roundtable tool or trusted structured-question contract is exposed. |
| Task decision audit | Requires task creation to carry its preceding decision evidence. | Bro matrix | Tier 3 | Shared task handler (Tier 1 candidate) | No task-creation tool is exposed. |
| Architectural-intent hint | Surfaces consultant guidance for architecture-shaped prompts. | Bro matrix | Tier 3 | `UserPromptSubmit` Hook | No Codex consultant workflow ships. |
| Domain-expert consultant hint | Suggests a specialist when a prompt requests domain judgment. | Universal matrix | Tier 3 | `UserPromptSubmit` Hook | No Codex consultant workflow ships. |
| SWE spawn contract | Requires a real task with a non-empty spec before SWE starts. | SWE matrix | Tier 3 | `PreToolUse` on agent spawn | No TMB Codex agents or task-spawn path ships. |
| SWE verification before completion | Runs typed verification before a task can become completed. | SWE matrix | Tier 3 | Shared status gate preferred; otherwise `PreToolUse` | No task-status tool is exposed. |
| SWE isolated execution | Keeps implementation work in an isolated task worktree. | SWE matrix | Tier 3 | Adapter-owned orchestration | Desktop-only worktree support is insufficient for a cross-surface guarantee. |
| SWE/reviewer tool separation | Keeps implementer and reviewer workflow writes structurally separate. | SWE/pr-reviewer matrices | Tier 3 | Shared role middleware plus host-enforced agent restrictions | No TMB Codex agents or role-bearing tools ship; role identity is not trusted. |
| Consultant workflow-write restriction | Prevents consultants from mutating task, issue, or validation state. | Consultant matrix | Tier 3 | Shared `requireRoles` middleware (Tier 1 candidate) | No consultant agent or workflow handler is exposed. |
| pr-reviewer read-only | Prevents the reviewer from editing the diff it judges. | pr-reviewer matrix | Tier 3 | Host-enforced read-only agent surface | No documented Claude-style per-tool allowlist equivalent and no Codex reviewer ships. |
| Push requires independent review | Blocks protected-branch push until every relevant commit has passing review evidence. | pr-reviewer/universal matrices | Tier 3 | `PreToolUse` on shell | No Codex push workflow ships; a future Hook remains subject to trust and coverage deltas. |
| Force-push protection | Refuses force-pushes to protected branches. | Universal matrix | Tier 3 | `PreToolUse` on shell | No functional Codex Hook ships; repository branch protection is external compensation. |
| Protected-branch commit policy | Refuses direct commits and local integration on protected branches. | Universal matrix | Tier 3 | `PreToolUse` on shell | No functional Codex Hook ships; repository branch protection is external compensation. |
| Remote issue-id guard | Prevents remote writes from citing a mismatched local issue identifier. | Universal matrix | Tier 3 | `PreToolUse` on shell | No Codex remote-issue workflow ships. |
| Merged-PR issue closure | Synchronizes local and remote issue closure after a successful PR merge. | Universal matrix | Tier 3 | `PostToolUse` on merge or server-backed remote integration | No Codex merge/issue-close workflow ships; maintainers retain the repository lifecycle duty. |
| Naming advisory | Reports path and identifier naming violations before source writes. | Universal matrix | Tier 3 | `PreToolUse` on edits and shell | The advisory is absent from the Codex package. |
| Commit-message advisory | Reports non-conforming commit subjects before commit. | Universal matrix | Tier 3 | `PreToolUse` on shell | The advisory is absent from the Codex package. |
| Mechanical code-quality advisory | Reports known mechanical implementation hazards before writes. | Universal matrix | Tier 3 | `PreToolUse` on edits | The advisory is absent from the Codex package. |
| Session project inventory | Reports repository, task, and world-model state at session start. | Universal matrix | Tier 3 | `SessionStart` Hook | `runtime_initialize` reports runtime paths and schema only; it is not a project prescan. |
| Roundtable capture postcheck | Verifies required capture surfaces after roundtable close. | Universal matrix | Tier 3 | `PostToolUse` | No roundtable workflow is exposed. |
| Atomic task close | Commits close audit, status, and issue state in one transaction. | Universal matrix | Tier 3 | Shared composite handler (Tier 1 candidate) | The shared handler is not exposed; the single-tool registry cannot close tasks. |
| SWE retry transaction | Creates retry rationale, replacement task, and audit atomically. | Universal matrix | Tier 3 | Shared composite handler (Tier 1 candidate) | The shared handler is not exposed; the single-tool registry cannot retry tasks. |
| Branch-id proposal | Proposes a conventional task-branch identifier from intent. | Universal matrix | Tier 3 | Shared composite handler (Tier 1 candidate) | The shared handler is not exposed; the single-tool registry cannot plan branches. |

Prompt-only style and response-format guidance is intentionally excluded from
this enforcement table because it is not a hard gate. It must be documented
separately if a later Scope ports the bro persona.

## Identity and spoofing surface (Rule 8)

Scope 2 has no TMB role identity. The only exposed operation is
`runtime_initialize`, and its explicit `project_root` selects a state boundary;
it does not authenticate a Human, bro, SWE, or reviewer.

The shared workflow handlers currently receive a caller-supplied role field.
If those handlers were exposed unchanged, a caller able to invoke the MCP tool
could claim another role. `requireRoles` would enforce the claimed role's
permissions but could not prove who supplied the claim. Similarly,
`verified_human: true` is a protocol assertion, not a trusted host signal.

Current compensation:

- Scope 2 exposes none of the role-bearing workflow handlers.
- Project routing is explicit, canonicalized, and contained, limiting the
  initialization operation to the selected worktree's ignored state directory.
- Later Scopes must document their identity channel before exposing role-bearing
  tools. Server-issued spawn tokens remain the preferred durable mechanism.

No later adapter scope may describe role isolation or Human verification as a
hard guarantee while identity remains caller-asserted.

## Security deltas (Rule 10)

| Delta from the Claude reference adapter | Exact matrix rows affected | Forced current tier | Current consequence | Required compensation before promotion |
|---|---|---|---|---|
| Plugin Hooks are skipped until the user trusts the exact current Hook hash. Changing a Hook invalidates that trust. | Activation routine; First-contact onboarding; Bro source-edit boundary; Project-state ignore setup; Branch creation ownership; Branch freshness before task work; Worktree cleanup; World-model refresh after close; Architectural-intent hint; Domain-expert consultant hint; SWE spawn contract; SWE verification before completion; Push requires independent review; Force-push protection; Protected-branch commit policy; Remote issue-id guard; Merged-PR issue closure; Naming advisory; Commit-message advisory; Mechanical code-quality advisory; Session project inventory; Roundtable capture postcheck | Tier 3 | Scope 2 ships an empty Hook manifest; a later Hook cannot be treated as active merely because it is installed. | Installation and upgrade evidence must include the trust ceremony and the untrusted state. |
| Codex documents tool Hooks as a guardrail, not a complete enforcement boundary; hosted or specialized tool paths may not traverse them. | Bro source-edit boundary; Branch creation ownership; Branch freshness before task work; Worktree cleanup; World-model refresh after close; SWE spawn contract; SWE verification before completion; Push requires independent review; Force-push protection; Protected-branch commit policy; Remote issue-id guard; Merged-PR issue closure; Naming advisory; Commit-message advisory; Mechanical code-quality advisory; Roundtable capture postcheck | Tier 3 | A Hook-only port cannot claim complete interception. | Prefer Tier 1 server gates; document uncovered paths and test every claimed local tool path. |
| `PreToolUse` cannot return an ask/escalate decision. Unsupported ask output fails while the tool call continues. | Branch creation ownership; Branch freshness before task work; SWE spawn contract; SWE verification before completion; Push requires independent review; Force-push protection; Protected-branch commit policy; Remote issue-id guard | Tier 3 | A future gate must choose allow or deny in advance. | Default deny for safety-critical ambiguity, or retain Tier 3 with an explicit rationale and recovery path. |
| No documented Claude-style per-tool allowlist exists for custom agents. | SWE/reviewer tool separation; pr-reviewer read-only | Tier 3 | Read-only reviewer independence is not structurally equivalent. | Prove a host-enforced replacement or retain Tier 3; prompt-only restriction is not parity. |
| Native worktrees are documented only for the desktop app. | Worktree creation; Worktree cleanup; SWE isolated execution | Tier 3 | CLI, IDE, cloud, and non-interactive surfaces cannot inherit a desktop-only claim. | Provide adapter-owned orchestration or publish separate, surface-specific declarations. |
| No trusted Human-input signal is available to the MCP server. | Verified-Human discussion write | Tier 3 | A caller could spoof Human provenance if the workflow tool were exposed. | Add server-verifiable Human provenance or keep the affected tool unavailable and the degradation explicit. |
| No server-authenticated role identity is available to the MCP server. | MCP role scoping; Reviewer session evidence; SWE/reviewer tool separation; Consultant workflow-write restriction | Tier 3 | A caller could claim another workflow role if role-bearing tools were exposed. | Add server-issued, verifiable role identity or keep role-bearing tools unavailable. |

## Evidence basis

- [OpenAI Codex Hooks](https://learn.chatgpt.com/docs/hooks): Hook trust,
  supported tool paths, deny behavior, unsupported ask decisions, and the
  guardrail boundary.
- [OpenAI Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents):
  custom-agent configuration and inherited permissions.
- [OpenAI Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees):
  desktop-only managed worktree availability.
- [`hooks/codex/hooks.json`](../../../hooks/codex/hooks.json): the current empty
  Codex Hook selection.
- [`CODEX_PORT.md`](../../contributing/CODEX_PORT.md): implemented Scope-2
  boundary and isolation requirements.

This declaration must be updated in the same pull request that changes a Codex
capability, exposes another workflow surface, or adds a functional Codex Hook.
Because this file is adapter doctrine, that pull request requires maintainer
review and must not be auto-merged; see
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#platform-adapters).
