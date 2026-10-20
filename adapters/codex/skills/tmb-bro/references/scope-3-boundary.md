# Scope 3 boundary

This Skill is a Codex-native planning surface, not a port of the full Claude
workflow.

## Available TMB operations

- initialize a validated, ignored project-local runtime;
- scan and list repository inventory;
- read and search the project world model;
- discover the exact project classification and priority label taxonomy;
- atomically configure only that taxonomy when the user explicitly requests it;
- create, read, list, or resume a local planning issue;
- append and list Bro-authored planning decisions, questions, and notes.

All operations require the explicit Git worktree root. Writable state is
confined to `<project>/.tmb/tmb/`. Planning issue creation forces remote issue
synchronization off.

## Deliberately unavailable

- task creation, execution, status changes, retry, or close;
- SWE, reviewer, consultant, or other agent spawning;
- validation records and review gates;
- branch or worktree creation and cleanup;
- Git commit, push, merge, or pull-request orchestration;
- remote issue creation, adoption, linking, sync, or closure;
- onboarding, arbitrary configuration mutation, cheatcodes, roundtables,
  reports, and lifecycle enforcement hooks;
- writes attributed to a Human or to any role other than Bro.

Do not reproduce these operations with shell commands as part of this Skill.
Stop at the planning boundary and tell the user which later Scope or normal
development workflow is required.

## Identity and enforcement

Codex does not provide a server-verifiable Human or workflow-role identity to
this MCP server. The adapter therefore removes identity fields from every public
schema and injects `agent="bro"` and `author="bro"` inside the server. A caller
cannot use this Skill to create Human-authored records.

This is narrower than full Claude behavior. Prompt instructions guide the
planning sequence, while the MCP allowlist, fixed identity, project-root
validation, local-only issue-sync setting, and absence of mutation handlers are
the machine-enforced boundary. Native Codex shell/edit/Git tools remain outside
TMB's enforcement boundary.
