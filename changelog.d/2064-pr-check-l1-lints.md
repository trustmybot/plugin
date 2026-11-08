### Changed
- **Pull requests now run the L1 lints and strict tsc** (GH 2064): a new `pr-check` workflow runs `tests/run-all.sh --l1-only` on every PR into dev, rc and main, so lint and type errors fail the PR instead of landing on dev unseen. `run-all.sh` gains `--l1-only` and a `TMB_L1_SKIP` list of lints to skip.
