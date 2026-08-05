---
name: tmb-bro
description: Inspect a Git project with TMB's project-local inventory and world model, clarify a request, and capture an approved local planning issue plus Bro-authored decisions. Use only when the user explicitly invokes $tmb-bro for repository understanding or planning; stop before implementation, task orchestration, review, or delivery.
---

# TMB Bro

Use TMB as a bounded planning aid. Turn the user's intent and the selected Git
worktree into durable local context without starting implementation or changing
remote systems.

## Planning workflow

1. Determine the exact Git worktree the user wants to plan against. Pass its
   absolute top-level path as `project_root` on every TMB call. Do not substitute
   the MCP process working directory.
2. Call `runtime_initialize`. If it rejects the project, surface the named error
   and stop; do not create `.tmb/`, edit `.gitignore`, or choose another project
   implicitly.
3. Call `project_inventory`. If no repository is recorded or the model is stale
   for this request, call `project_scan`, then read the inventory again.
4. Inspect the smallest useful slice of project context:
   - use `world_model_search` to locate relevant areas;
   - use `world_model_get` for the selected subtree;
   - use Codex's normal read-only repository tools when source-level evidence is
     necessary.
5. Separate evidence from assumptions. Ask the user when a missing product,
   scope, or acceptance decision would materially change the plan.
6. Draft a concise objective and a Markdown description containing context,
   scope, exclusions, and verifiable acceptance criteria. Show material choices
   to the user before creating the record when they have not already approved
   them.
7. Call `planning_issue_create`. This creates only a project-local TMB issue;
   remote issue sync stays off even when the Git repository has a remote.
8. Record confirmed decisions or unresolved questions with
   `planning_discussion_append`. Use only `decision`, `question`, or `note`.
9. Return the local issue identifier, the decisions captured, open questions,
   and the explicit stop boundary.

## Resume an existing plan

Use `planning_issue_list` to locate a record and `planning_issue_resume` to read
its description and recent discussion. Continue planning only. Do not interpret
the absence of a task-execution tool as permission to use another TMB surface.

## Failure handling

- If the bundled `trajectory-server` tools are absent, stop and ask the user to
  enable or approve the installed plugin MCP. Do not substitute another TMB
  registry or install dependencies during the workflow.
- Treat every `isError` response as a stop signal. Report its machine-readable
  code and the action the user can take.
- Never retry a rejected state path by weakening project-root or ignore checks.
- If the world model is unavailable, say so and continue only with explicit
  read-only repository inspection; do not claim graph-backed understanding.
- Never provide caller-supplied `agent`, `author`, `verified_human`, role, or
  provenance fields. This adapter fixes all workflow writes to Bro.

## Boundary reference

Read [references/scope-3-boundary.md](references/scope-3-boundary.md) before
answering questions about supported operations, identity guarantees, or parity
with the Claude adapter.
