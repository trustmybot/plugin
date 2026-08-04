# Codex adapter parity declaration

This page is the Codex adapter's required declaration under the
[Platform Adapter Contract](../ADAPTER_CONTRACT.md). It records current
capabilities and enforcement, not planned parity.

**Declaration date:** 2026-08-04

**Implemented scope:** Scope 3, explicitly invoked `tmb-bro` project
understanding and local planning (HAR-1)

**Reference adapter:** Claude Code

The Codex package selects an empty Hook manifest, one explicitly invoked
`tmb-bro` Skill, and an immutable 11-tool MCP allowlist for project inventory,
world-model reads, local planning issues, and Bro-authored planning records.
Server wrappers require an explicit validated project root, fix workflow writes
to the Bro identity, and force remote issue sync off. Task execution, agents,
review, branch/worktree, delivery, remote issue, onboarding, and lifecycle
surfaces remain unavailable. This boundary does not constrain Codex's native
shell, edit, Git, or other non-TMB tool paths.

## Scope-3 MCP surface

The complete allowlist is `runtime_initialize`, `project_inventory`,
`project_scan`, `world_model_get`, `world_model_search`,
`planning_issue_create`, `planning_issue_get`, `planning_issue_list`,
`planning_issue_resume`, `planning_discussion_append`, and
`planning_discussion_list`.

Machine enforcement consists of that exact frozen allowlist, closed schemas,
caller-identity rejection, fixed Bro arguments, canonical project routing, safe
state paths, and local-only issue creation. The Skill controls discovery order,
clarification, approval, and the stop-after-planning behavior. Those Skill
instructions are prompt guidance, not a hard boundary; the hard boundary is the
absence of later-stage TMB tools.

## Capability declaration (Rule 5)

| Capability | Codex value | Evidence and current TMB use |
|---|---|---|
| Deny-capable pre-tool hooks | **Yes, conditional** | `PreToolUse` can deny supported local tool paths. Non-managed and plugin-bundled Hooks are skipped until the user trusts the exact current Hook hash, and some tool paths can bypass the default Hook path. TMB ships no functional Codex Hooks in Scope 3. |
| Per-agent tool restriction | **No documented equivalent** | Custom agents can override session configuration such as sandbox mode, MCP servers, and skills, but the current public contract does not establish a Claude-style per-tool allowlist. TMB therefore cannot claim structural pr-reviewer read-only parity. |
| Structured-question UI | **Surface-dependent; not relied upon** | Interactive Codex surfaces may offer structured input, but no portable plugin-level contract is used by Scope 3. TMB does not claim roundtable question-shape enforcement. |
| Subagent spawn with per-child config | **Yes on supported local clients** | Custom agents can select model, reasoning effort, sandbox mode, MCP servers, skills, and developer instructions. Scope 3 ships no TMB Codex agents or spawn orchestration. |
| Native worktree isolation | **Desktop-only** | Codex-managed worktrees are documented for the ChatGPT desktop app, not as a cross-surface Codex guarantee. Scope 3 accepts a normal or linked worktree as planning input but does not create or orchestrate one. |
| Writable project-state dir | **Yes** | Every Scope-3 tool requires an explicit canonical Git worktree and writes only below its ignored `<project>/.tmb/tmb/` directory. |
| Trusted human-input signal | **No** | The MCP contract gives TMB no cryptographically trusted Human identity. Scope 3 rejects all caller-supplied provenance and exposes no Human-authored write. |

The shared core must branch on these capabilities, never on a literal Codex
host name. A surface-specific capability stays unavailable to shared workflow
logic until the adapter can prove and declare it for that surface.

## Enforcement parity matrix (Rule 4)

Canonical gate behavior and source locations remain owned by
[`ENFORCEMENT.md`](../../prompt-engineering/ENFORCEMENT.md). Scope 3 promotes
only the gates that the narrow server wrapper can enforce. A future mechanism
in any Tier-3 row remains a candidate, not a capability that ships today.

| Gate | What it enforces | Canonical evidence | Current tier | Future mechanism | Degradation and compensation |
|---|---|---|---|---|---|
| Activation routine | Injects onboarding and pending-work state at session/prompt boundaries. | Bro matrix | Tier 3 | Session/UserPrompt Hook | `tmb-bro` is explicit-only (`allow_implicit_invocation: false`); no session activation routine ships. |
| First-contact onboarding | Starts onboarding automatically for an uninitialized user. | Bro matrix | Tier 3 | Session/UserPrompt Hook | The Skill can explain missing prerequisites after invocation, but no automatic onboarding workflow ships. |
| Bro source-edit boundary | Prevents the orchestrator from editing implementation files. | Bro matrix | Tier 3 | `PreToolUse` on edits and shell | The Skill says to stop after planning and the TMB allowlist has no source-write tool, but native Codex edits remain outside this guarantee. |
| Project-state ignore setup | Ensures host state is ignored before it can be written. | Bro matrix | **Tier 1** | Codex runtime validation | Every Scope-3 MCP call fails before writes unless `.tmb/` is ignored and contains no tracked state; the adapter never edits `.gitignore`. |
| Branch creation ownership | Keeps task-branch creation with bro rather than SWE. | Bro/SWE matrices | Tier 3 | `PreToolUse` on shell | No Codex bro/SWE workflow or branch orchestration ships. |
| Branch freshness before task work | Requires a task branch to descend from the configured remote base. | Bro/SWE matrices | Tier 3 | `PreToolUse` on shell | No Codex task attach or SWE workflow ships. |
| Worktree creation | Creates task worktrees at the canonical isolated location. | SWE matrix | Tier 3 | Adapter-owned orchestration | Scope 3 validates a supplied worktree for planning but never creates one. |
| Worktree cleanup | Removes the task worktree after a verified close. | Bro matrix | Tier 3 | `PostToolUse` or adapter orchestration | Scope 3 exposes no task close or cleanup workflow. |
| World-model-cold task gate | Blocks task creation until the project model is ready or explicitly waived. | Bro matrix | Tier 3 | Shared `task_create_batch` handler (Tier 1 candidate) | The Skill requests scan-before-planning, but task creation itself is absent, so no task gate is claimed. |
| World-model refresh after close | Refreshes the project model after an atomic task close. | Bro matrix | Tier 3 | `PostToolUse` | Scope 3 exposes project scan but no task close or post-close orchestration. |
| MCP role scoping | Restricts workflow handlers to the roles allowed by the shared contract. | Bro, SWE, pr-reviewer, and consultant matrices | **Tier 1 for the Scope-3 slice; Tier 3 otherwise** | Adapter wrapper plus shared middleware | Public schemas accept no role field; wrappers inject only `bro`, and only Bro-safe planning handlers are reachable. Other workflow roles remain unavailable and unauthenticated. |
| Reviewer session evidence | Requires validation records to name the independent reviewer session. | Bro/pr-reviewer matrices | Tier 3 | Shared `validation_record` handler (Tier 1 candidate) | No validation tool is exposed. |
| Validation MCP-availability evidence | Requires reviewer records to provide the typed `mcp_available` boolean. | Shared `validation_record` handler | Tier 3 | Shared handler validation (Tier 1 candidate) | No validation write is exposed. |
| Verified-Human discussion write | Rejects Human-authored discussion claims without the required verification assertion. | Bro matrix | **Tier 1 for the Scope-3 slice** | Adapter wrapper | The public append schema has no author/provenance fields, rejects attempts to add them, and always writes `author="bro"`; Human-authored writes are unavailable. |
| Remote issue-sync default-off | Prevents remote synchronization unless explicitly enabled. | Bro matrix | **Tier 1** | Adapter wrapper plus shared issue handler | `planning_issue_create` forces project-local `issue_sync="off"`, omits remote linkage fields, and exposes no config or sync tool. |
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
| Session project inventory | Reports repository, task, and world-model state at session start. | Universal matrix | Tier 3 | `SessionStart` Hook | Explicit `$tmb-bro` runs inventory and scan as needed, but no automatic session-start report ships and task state is outside Scope 3. |
| Roundtable capture postcheck | Verifies required capture surfaces after roundtable close. | Universal matrix | Tier 3 | `PostToolUse` | No roundtable workflow is exposed. |
| Atomic task close | Commits close audit, status, and issue state in one transaction. | Universal matrix | Tier 3 | Shared composite handler (Tier 1 candidate) | The shared handler is not exposed; the Scope-3 registry cannot close tasks. |
| SWE retry transaction | Creates retry rationale, replacement task, and audit atomically. | Universal matrix | Tier 3 | Shared composite handler (Tier 1 candidate) | The shared handler is not exposed; the Scope-3 registry cannot retry tasks. |
| Branch-id proposal | Proposes a conventional task-branch identifier from intent. | Universal matrix | Tier 3 | Shared composite handler (Tier 1 candidate) | The shared handler is not exposed; Scope 3 deliberately stops before branch planning. |

Prompt-only sequencing and response guidance is intentionally excluded from
hard-gate claims. Scope 3 documents it in the Skill while relying on the server
allowlist for the enforceable stop boundary.

## Identity and spoofing surface (Rule 8)

Codex still supplies no authenticated Human or workflow-role signal. Scope 3
does not pretend otherwise. Instead, the adapter narrows the authority of every
reachable write: schemas omit role and provenance fields, runtime validation
rejects attempts to add them, and server wrappers inject `agent="bro"` and
`author="bro"` before calling shared handlers.

This fixed label is capability scoping, not authentication. It is safe for this
slice because only local Bro planning writes are exposed; a caller cannot select
SWE, reviewer, consultant, or Human authority, and cannot reach task,
validation, remote, or delivery mutations. Project routing is independently
explicit, canonicalized, and contained.

Server-issued spawn/role tokens remain the preferred durable mechanism before a
later Scope exposes multiple workflow roles. No Human-authored write may be
added until the server can verify Human provenance.

## Security deltas (Rule 10)

| Delta from the Claude reference adapter | Exact matrix rows affected | Forced current tier | Current consequence | Required compensation before promotion |
|---|---|---|---|---|
| The `tmb-bro` Skill is explicit-only and no activation Hook ships. | Activation routine; First-contact onboarding; Session project inventory | Tier 3 | Planning behavior begins only when the user invokes `$tmb-bro`; there is no automatic first-contact or pending-work injection. | Add a separately reviewed host mechanism and prove its trust/coverage, or retain explicit invocation. |
| Plugin Hooks are skipped until the user trusts the exact current Hook hash. Changing a Hook invalidates that trust. | Activation routine; First-contact onboarding; Bro source-edit boundary; Branch creation ownership; Branch freshness before task work; Worktree cleanup; World-model refresh after close; Architectural-intent hint; Domain-expert consultant hint; SWE spawn contract; SWE verification before completion; Push requires independent review; Force-push protection; Protected-branch commit policy; Remote issue-id guard; Merged-PR issue closure; Naming advisory; Commit-message advisory; Mechanical code-quality advisory; Session project inventory; Roundtable capture postcheck | Tier 3 | Scope 3 ships an empty Hook manifest; a later Hook cannot be treated as active merely because it is installed. | Installation and upgrade evidence must include the trust ceremony and the untrusted state. |
| Codex documents tool Hooks as a guardrail, not a complete enforcement boundary; hosted or specialized tool paths may not traverse them. | Bro source-edit boundary; Branch creation ownership; Branch freshness before task work; Worktree cleanup; World-model refresh after close; SWE spawn contract; SWE verification before completion; Push requires independent review; Force-push protection; Protected-branch commit policy; Remote issue-id guard; Merged-PR issue closure; Naming advisory; Commit-message advisory; Mechanical code-quality advisory; Roundtable capture postcheck | Tier 3 | A Hook-only port cannot claim complete interception. | Prefer Tier 1 server gates; document uncovered paths and test every claimed local tool path. |
| `PreToolUse` cannot return an ask/escalate decision. Unsupported ask output fails while the tool call continues. | Branch creation ownership; Branch freshness before task work; SWE spawn contract; SWE verification before completion; Push requires independent review; Force-push protection; Protected-branch commit policy; Remote issue-id guard | Tier 3 | A future gate must choose allow or deny in advance. | Default deny for safety-critical ambiguity, or retain Tier 3 with an explicit rationale and recovery path. |
| No documented Claude-style per-tool allowlist exists for custom agents. | SWE/reviewer tool separation; pr-reviewer read-only | Tier 3 | Read-only reviewer independence is not structurally equivalent. | Prove a host-enforced replacement or retain Tier 3; prompt-only restriction is not parity. |
| Native worktrees are documented only for the desktop app. | Worktree creation; Worktree cleanup; SWE isolated execution | Tier 3 | CLI, IDE, cloud, and non-interactive surfaces cannot inherit a desktop-only claim. | Provide adapter-owned orchestration or publish separate, surface-specific declarations. |
| No trusted Human-input signal is available to the MCP server. | Verified-Human discussion write | Tier 1 for the Scope-3 slice; Tier 3 for genuine Human capture | Scope 3 rejects provenance fields and permits only Bro-authored records, so it cannot capture Human authorship at all. | Add server-verifiable Human provenance before exposing Human-authored writes. |
| No server-authenticated role identity is available to the MCP server. | MCP role scoping; Reviewer session evidence; SWE/reviewer tool separation; Consultant workflow-write restriction | Tier 1 for fixed Bro planning; Tier 3 for every other role | Fixed server-side Bro arguments bound the available authority, but no multi-role claim is authenticated. | Add server-issued, verifiable role identity before exposing another workflow role. |

## Evidence basis

### Scope-3 verification record (2026-08-04)

| Surface | Host | Installed source | Explicit `$tmb-bro` result | Ordinary-prompt result |
|---|---|---|---|---|
| Codex CLI 0.146.0 | macOS arm64 (Darwin 25.5.0) | Local Codex marketplace cache built from this worktree | Plugin installation and installed-cache discovery succeeded; Codex listed the bundled `trajectory-server` MCP. The live model turn was interrupted after repeated WebSocket/HTTPS request timeouts before the first tool call, so no live end-to-end behavior is claimed. | Not run after the transport failure; implicit non-activation is covered by the explicit-only Skill policy assertion and installed-cache tests. |

The automated cold-cache test below is the release-blocking evidence for this
Scope: it boots the copied installed artifact without source `node_modules`,
asserts the exact Skill and MCP allowlist, exercises the local planning flow,
and verifies remote sync remains off. Live CLI/IDE/Desktop/cloud evidence must
be reported separately and must not be inferred from this row.

- [OpenAI Codex plugin Skills](https://developers.openai.com/codex/plugins/skills):
  explicit `$skill` invocation, per-Skill `agents/openai.yaml`, and MCP
  dependencies.
- [OpenAI Codex Skills](https://developers.openai.com/codex/skills): Skill
  discovery, progressive disclosure, and explicit invocation semantics.
- [OpenAI Codex Hooks](https://learn.chatgpt.com/docs/hooks): Hook trust,
  supported tool paths, deny behavior, unsupported ask decisions, and the
  guardrail boundary.
- [OpenAI Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents):
  custom-agent configuration and inherited permissions.
- [OpenAI Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees):
  desktop-only managed worktree availability.
- [`hooks/codex/hooks.json`](../../../hooks/codex/hooks.json): the current empty
  Codex Hook selection.
- [`CODEX_PORT.md`](../../contributing/CODEX_PORT.md): implemented Scope-3
  boundary and isolation requirements.

This declaration must be updated in the same pull request that changes a Codex
capability, exposes another workflow surface, or adds a functional Codex Hook.
Because this file is adapter doctrine, that pull request requires maintainer
review and must not be auto-merged; see
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#platform-adapters).
