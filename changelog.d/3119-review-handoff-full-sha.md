### Fixed

- **The review handoff names the full commit SHA** (GH 3119, GH 3090, GH 3141): a short `commit_sha` given at task completion is now stored as the full SHA it resolves to in the task's worktree or repo, and `review_handoff` upgrades a short SHA stored earlier, so the reviewer spawn and its record carry the exact commit the push gate checks. `task_brief` now also says whether the task is prompt-bearing and which no-code class it has, and the task-close parity recording includes the no-code class column.
