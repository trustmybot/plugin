### Changed
- **Hook parity suites compare with recordings** (GH 1692): each parity suite now reads the bash side from `tests/fixtures/hook-golden/<gate>.json` instead of spawning `scripts/hooks/<gate>.sh`, so the corpus still has something to compare the TypeScript gates with once the scripts are deleted. Re-record with `TMB_HOOK_GOLDEN=record`; `scripts/hooks/README.md` has the command.
