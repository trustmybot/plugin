---
description: Deterministically populate the file_registry by walking the session dir for git repos, computing md5 + size + last_commit_sha per file. Phase 1 (programmatic) clears the registry-cold gate; Phase 2 (parallel summary fill) runs in the background.
argument-hint: (none)
---

# /scan

Bro orchestrates two phases. **All deterministic logic lives in `scan_run`** — bro's job in Phase 1 is one MCP call; Phase 2 dispatches summary-fill subagents in parallel.

## Auto-fire trigger

Bro runs `/scan` before any `task_create_batch` call when `file_registry` is empty AND the project has source files. The registry-cold gate (server-enforced) returns `forbidden` otherwise.

`/scan` also runs after every `bro_atomic_close` to refresh the registry against the new git state — md5-only drift detection ensures only changed files lose their summary.

## Phase 1 — programmatic (blocking, fast)

```
scan_run(agent='bro', source='user_manual')
```

The server forks `scripts/scan.sh`, which:
1. Discovers git repos under the session dir via `find -name .git` (POSIX). Workspace-pattern projects with multiple inner repos are first-class.
2. For each repo: `git ls-files` (.gitignore-aware), then md5 + size + last_commit_sha per file.
3. Persists into `repos` + `file_registry` (transactional). Drift detection is **md5-only** — rows where md5 matches keep their summary; rows where md5 differs get the summary cleared.
4. Emits `audit_log(from_node='bro', event_type='deep_scan_completed')` so the registry-cold gate clears.
5. Sets `tmb_default_repo` to the first discovered repo if not already set (helps issue_sync resolve `_cwd` correctly).

Returns: `{session_dir, scanned_at, repos[], repos_upserted, files_upserted, files_md5_changed}`.

## Phase 2 — summary fill (parallel, non-blocking)

Bro reads the response from `scan_run`, batches files (~25 per batch), and dispatches background subagents in parallel:

```
For each batch B:
  Agent(
    subagent_type='general-purpose',
    description='Fill file_registry summaries for batch <i>',
    prompt='Read each of these files: <paths>. For each file, write a 1-2 line description of WHAT the file contains and its role in the project. Then call file_registry_update_summaries(updates=[{path, summary}, ...]).',
    run_in_background=true,
  )
```

Phase 2 doesn't block task creation — bro returns to the Human as soon as Phase 1 completes. Summaries land asynchronously over the next ~minute.

## Scope

Allowed:
- `mcp__plugin_tmb_trajectory-server__scan_run`
- `mcp__plugin_tmb_trajectory-server__file_registry_update_summaries` (for Phase 2 subagents)
- `Agent` (for Phase 2 dispatch)

Forbidden during `/scan`:
- `task_create_batch` (this is a maintenance op, not feature work)
- `issue_create` (same)
- `Bash` (server already forks scan.sh; bro doesn't need shell)

## What md5-only drift means

The `last_commit_sha` per file is recorded as **metadata** for diagnostic context. It is NOT used to invalidate registry rows. The only invalidation signal is content_md5 mismatch between scan and previous registry value. This is deliberate — git diff would tell us "what changed in HEAD" but doesn't tell us "what we previously summarized" if the summary was written across multiple commits. The md5 check is the canonical "this file is the same now as when we summarized it" probe.
