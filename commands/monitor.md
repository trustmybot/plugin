---
description: Pull review comments from a GitHub PR or GitLab MR and plan/dispatch SWE work to address them
argument-hint: <PR or MR number>
---

Invoke the `tmb_review` skill (§C "PR/MR comment triage") with PR number: $ARGUMENTS

If $ARGUMENTS is empty, check the current branch — if it has an open PR/MR via `gh pr view` / `glab mr view`, use that. Otherwise ask the user via AskUserQuestion.
