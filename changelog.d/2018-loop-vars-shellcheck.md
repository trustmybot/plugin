### Fixed
- **The shellcheck hook lint passes again on dev** (GH 2018): the loop-variable fixpoint in `cmd-analysis.sh` (`_tmb_cmd_loop_vars`) bound a pass counter it never read, so `tests/l1-lint/shellcheck-hooks.sh` failed with SC2034. The loop now binds `_`, with no shellcheck directive added.
