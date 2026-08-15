# Codex MCP tool reference

The Codex entry point exposes 15 tools. It keeps the 13-tool planning surface
from Scope 3 and adds two tools for the fixed project-level Agent files. It does
not expose the Claude registry.

## Planning tools

| Area | Tools |
|---|---|
| Runtime | `runtime_initialize` |
| Project context | `project_inventory`, `project_scan` |
| World model | `world_model_get`, `world_model_search` |
| Label taxonomy | `planning_label_taxonomy_get`, `planning_label_taxonomy_set` |
| Local Issues | `planning_issue_create`, `planning_issue_get`, `planning_issue_list`, `planning_issue_resume` |
| Planning discussions | `planning_discussion_append`, `planning_discussion_list` |

All planning schemas require `project_root`, reject caller-provided identity and
provenance, and stay within the local planning contract described in
[`CODEX_PORT.md`](../../contributing/CODEX_PORT.md). Issue creation always keeps
remote synchronization off.

## `agent_materialization_get`

Inspects the two managed Agent targets without creating `.tmb`, `.codex`, or an
Agent file.

Input:

```json
{
  "project_root": "/absolute/canonical/git/worktree"
}
```

The schema is closed. The project root must be the canonical Git top-level, and
the existing `.tmb/` path must already satisfy the Scope-3 ignore and tracking
checks.

Example `data` payload inside the standard `{ "ok": true, "data": ... }`
envelope:

```json
{
  "project_root": "/absolute/canonical/git/worktree",
  "template_set_version": 1,
  "overall_status": "current",
  "agents": [
    {
      "agent_id": "tmb_swe",
      "target_path": ".codex/agents/tmb_swe.toml",
      "status": "current",
      "expected_template_version": 1,
      "expected_body_sha256": "<sha256>",
      "current_content_sha256": "<sha256>"
    },
    {
      "agent_id": "tmb_pr_reviewer",
      "target_path": ".codex/agents/tmb_pr_reviewer.toml",
      "status": "current",
      "expected_template_version": 1,
      "expected_body_sha256": "<sha256>",
      "current_content_sha256": "<sha256>"
    }
  ]
}
```

Per-file status is `absent`, `current`, or `conflict`. The overall status may
also be `mixed` when one file is absent and the other is current. A conflict
entry contains `conflict_reason="content_mismatch"` but omits both the current
content hash and the file body. Unsafe path types return an error instead of a
status result.

## `agent_materialization_set`

Converges both fixed targets toward present or absent. Calling this tool
directly is an advanced explicit operation; `$tmb:tmb-agent-setup` provides the
normal preview and confirmation flow.

Input:

```json
{
  "project_root": "/absolute/canonical/git/worktree",
  "desired_state": "present"
}
```

`desired_state` accepts only `present` or `absent`. The schema accepts no target
path, Agent name, content, identity, or provenance field.

Example `data` payload inside the standard success envelope:

```json
{
  "project_root": "/absolute/canonical/git/worktree",
  "desired_state": "present",
  "changed": [
    ".codex/agents/tmb_swe.toml",
    ".codex/agents/tmb_pr_reviewer.toml"
  ],
  "unchanged": [],
  "overall_status": "current",
  "restart_required": true
}
```

`changed` and `unchanged` follow catalog order and together cover both targets.
When `changed` is empty, `restart_required` is false. The setter leaves the
Agent directory and third-party files in place during removal.

## Ownership and conflicts

A target is managed only when its complete UTF-8 bytes match the current
catalog entry. The catalog fixes the ownership header, LF line endings, body,
template version, and hashes. BOMs, CRLF, comments, whitespace changes, old
templates, and user edits are all conflicts in Scope 4.

Preflight conflict blocks both targets. Present uses exclusive, no-follow file
creation. Absent rechecks the current bytes immediately before unlinking. The
implementation rejects symlinks, non-directory parent paths, and non-regular
targets.

## Errors

The tools use the existing Codex MCP envelope:

```json
{
  "ok": false,
  "error": {
    "code": "agent_materialization_conflict",
    "message": "A managed Agent target conflicts with the current template.",
    "details": {}
  }
}
```

| Code | Meaning |
|---|---|
| `agent_materialization_conflict` | At least one regular target does not match the current catalog. No managed target changed during preflight. |
| `unsafe_codex_agents_path` | A parent or target is a symlink, has the wrong type, or cannot be verified safely. |
| `agent_materialization_io_failed` | A file operation failed before any managed target changed. |
| `agent_materialization_partial` | At least one managed target changed before a later conflict, unsafe path, I/O failure, or failed postflight. |

A partial error includes `desired_state`, `cause_code`, `changed`,
`restart_required=true`, and the final known state of both targets. `unknown`
is used when a target cannot be checked safely after the failure.

Project-root and schema failures continue to use the existing stable codes,
including `missing_project_root`, `invalid_arguments`,
`unsupported_identity_claim`, `project_root_not_absolute`,
`project_root_not_git_toplevel`, and `project_state_not_ignored`.

## Deliberate limits

Scope 4 is a single-user, single-process setup contract. It has no historical
template catalog, force option, lock, rollback, fsync, crash recovery, or
dynamic Marketplace identity. These limits are documented behavior, not
features implied by the Agent ownership header.
