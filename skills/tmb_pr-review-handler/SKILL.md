---
name: tmb_pr-review-handler
description: Fetches new PR/MR comments via pr_comments_get, classifies task-worthy vs informational, groups into tasks, flags arch-impact, presents plan via AskUserQuestion, dispatches SWE per ratified task, triggers tmb_refresh-architecture post-SWE on arch-impact tasks. Loaded by /monitor or explicit bro invocation.
agent: bro
allowed-tools: Task, Bash, mcp__plugin_tmb_trajectory-server__pr_comments_get, mcp__plugin_tmb_trajectory-server__discussion_append, mcp__plugin_tmb_trajectory-server__task_create_batch, mcp__plugin_tmb_trajectory-server__task_get, AskUserQuestion
---

# PR/MR Review Handler

## When to invoke

Loaded by `/monitor <N>` slash command or when bro detects a PR/MR review request.

## Phase 1 — Resolve PR number

If `$ARGUMENTS` is provided, use it as the PR number directly.

Otherwise: run `git rev-parse --abbrev-ref HEAD` to get the current branch, then:
- GitHub: `gh pr view --json number` to resolve the open PR for this branch.
- GitLab: `glab mr list --source-branch <branch> --json` to find the MR.

If no PR is found either way, ask via AskUserQuestion: "Which PR/MR number to monitor?" (text input).

## Phase 2 — Read prior fetch state

```sql
SELECT last_fetched_at, last_comment_id
FROM pr_review_runs
WHERE pr_number = <N>
ORDER BY id DESC
LIMIT 1;
```

Pass `since=<last_fetched_at>` to `pr_comments_get` if a prior run exists.

## Phase 3 — Fetch new comments

Call `pr_comments_get(agent='bro', pr_number=<N>, since=<last_fetched_at or omit>)`.

If `comments` is empty, respond: "No new comments on PR #N since last fetch." and stop.

## Phase 4 — Persist to discussions

For each comment, call:
```
discussion_append(agent='bro', issue_id=<carrier>, author=<commenter>,
  kind='note', body="[PR #N comment by <author>] <body>")
```

Carrier issue resolution: look up the current branch → issue by branch_id in tasks table. If none found, ask via AskUserQuestion: "Which issue is this PR linked to?" (text input for issue ID).

## Phase 5 — Classify comments

Informational (skip from task planning):
- Body matches: `^(LGTM|👍|\+1|thanks|nice work|nit:)` (case-insensitive)
- Human `author_kind='bot'` (already classified by `pr_comments_get`)
- Already resolved (`is_resolved: true`)

Task-worthy:
- Contains code suggestion fences (```suggestion)
- Contains "should be", "this is wrong", "please change", "consider ", "fix ", "you need to"
- Direct asks ending with `?`
- `author_kind='human'` with substantive body (>30 chars, not matched by informational patterns)

## Phase 6 — Group into tasks

Group task-worthy comments by:
1. Same `file_path` → merge into one task per file
2. Related concept (same keywords or explicit reference) → same task
3. Otherwise → one task per comment

For each group, compose:
- `title`: concise action title (≤72 chars)
- `description`: full comment bodies + file/line references
- `success_criteria`: "Address all reviewer comments in this group"

## Phase 7 — Flag arch-impact

A task is arch-impact if its `## Files` would touch any of:
- `docs/trustmybot/architecture/auto/`
- `mcp/trajectory-server/src/schema.sql`
- `.claude-plugin/plugin.json`
- `templates/agents/` or `agents/` (agent file add/remove)
- New top-level directory under `plugin/`

Append `(arch-impact)` to the task title in the AUQ option.

## Phase 8 — Present plan via AskUserQuestion

```
AskUserQuestion(
  title: "PR #<N> review",
  question: "Which review comments to address now? (subset OK)",
  multiSelect: true,
  options: [
    { label: "<task title> [(arch-impact)]", value: "<group_id>" },
    ...
  ]
)
```

If no task-worthy comments remain after filtering, respond: "All comments are informational — nothing to dispatch." and stop.

## Phase 9 — Dispatch ratified tasks

For each selected group:
1. `task_create_batch(agent='bro', issue_id=<carrier>, tasks=[<spec>])`
2. Spawn SWE subagent with the task.
3. On SWE completion: if arch-impact was flagged for this task, invoke `tmb_refresh-architecture` skill before continuing.

## Phase 10 — Update pr_review_runs

After all SWE runs complete, the `pr_comments_get` call already wrote a `pr_review_runs` row. To update `tasks_created`:

```sql
UPDATE pr_review_runs
SET tasks_created = <M>
WHERE id = (SELECT MAX(id) FROM pr_review_runs WHERE pr_number = <N>);
```

Run via Bash with sqlite3 against `$TRAJECTORY_DB_PATH`, or call any available MCP write tool.
