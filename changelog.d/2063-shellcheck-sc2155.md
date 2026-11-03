### Fixed
- **The hook shellcheck lint passes again** (GH 2063): five hook test files exported `TMB_TEST_NODE` in the same statement that ran `node -p`, which shellcheck flags as SC2155 because a failing `node` was masked. They now assign the value first and export it on its own line, so `tests/l1-lint/shellcheck-hooks.sh` exits clean.
