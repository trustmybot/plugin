# /monitor

## Purpose

`/monitor` fetches new review comments from a GitHub PR or GitLab MR and turns them into structured SWE tasks — with Human approval at every dispatch step.

## When to use

- After a reviewer posts comments on your open PR/MR and you want bro to triage and implement them.
- When you want to track which comments have been addressed and which are still pending.

Do not use for routine polling — the trigger is always explicit. No webhooks, no background scanning.

## Syntax

```
/monitor <PR or MR number>
/monitor
```

With a number, fetch starts immediately. Without arguments, bro resolves the PR from the current branch, or asks if it can't determine one.

### Examples

```
/monitor 42
```

```
/monitor
# → bro auto-detects PR from current branch, or prompts for a number
```

## What happens

1. `tmb_review` skill is invoked with the PR number.
2. Prior fetch state is read from `pr_review_runs` — only new comments since last fetch are processed.
3. `pr_comments_get` fetches comments from gh or glab. Bots and resolved threads are filtered out.
4. Each new human comment is persisted to the carrier issue via `discussion_append`.
5. Task-worthy comments are grouped by file or concept into logical tasks.
6. Tasks touching schema, arch docs, or agent files are flagged `(arch-impact)`.
7. One `AskUserQuestion` (multiSelect) presents the plan — you pick which comments to address.
8. SWE is dispatched for each ratified task. Arch-impact tasks trigger `scan_run(source='bro_auto_post_change')` after SWE returns to refresh the world model.
9. `pr_review_runs` is updated with the fetch state for incremental next runs.

For the full phase-by-phase flow, see [`skills/tmb_review/SKILL.md`](../../skills/tmb_review/SKILL.md).

## Cross-references

- **Skill:** `tmb_review` — same flow, invocable directly by bro without the slash command.
- **MCP tools used:** `pr_comments_get`, `discussion_append`, `task_create_batch`, `task_get`.
- **Post-SWE arch refresh:** `scan_run(source='bro_auto_post_change')` — triggered automatically on arch-impact tasks.
- **State tracking:** `pr_review_runs` table — tracks per-PR fetch history for incremental fetches.
