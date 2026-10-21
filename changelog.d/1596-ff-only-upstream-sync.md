### Fixed
- **You can fast-forward a branch to its own upstream in the main checkout** (GH 1596): `git merge --ff-only origin/main` on `main` (or `git merge --ff-only @{u}`) is now allowed, so syncing your base branch after a PR merges no longer needs a workaround. Other local merges in the main checkout are still blocked, and the block now suggests `git pull --ff-only` for syncing.
