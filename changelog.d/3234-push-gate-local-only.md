### Changed
- **The push gate stops at branch ready when the repo has no remote** (GH 3234): bro used to push and open a PR after every passing review, which failed on a project with no origin. It now skips the push and the PR, tells you the branch is ready to merge locally, and after you say the merge is done removes the worktree and deletes the merged branch, asking before a force delete.
