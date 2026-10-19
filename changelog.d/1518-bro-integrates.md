### Changed
- **bro prepares the branch and integrates the base after review** (GH 1518): swe starts every task on the ready-to-work branch `task_provision` cut from the up-to-date base. After the pr-reviewer pass, bro runs `integrate.sh` when the base has moved — pushing the re-verified rebased commit, or retrying the task on a fresh branch when the rebase conflicts.
