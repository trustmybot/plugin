### Changed
- **The L5/L6 sandbox stubs run on Node, not bash** (GH 1692): the `curl`, `gh`, `git-remote-http`, `git-remote-https`, `glab` and `wget` stubs in `tests/l5-l6/lib/stubs/` are now `#!/usr/bin/env node` scripts with the same names, stderr text and exit code 1, and `tests/l5-l6/lib/sandbox.test.ts` pins each stub's exact output with `TMB_TEST_REMOTE` set and unset.
