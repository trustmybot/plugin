### Changed
- **PreToolUse Bash and Write gates run concurrently** (GH 1692): the first deny in group order still answers. Their budgets are now the critical path, so the Bash registration drops from 36 s to 19 s and Write from 31 s to 12 s, and the wait for the bash parser stops at 2 s. `TMB_HOOKS_IMPL=bash` keeps them one at a time.
