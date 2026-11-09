### Changed
- **pr-check no longer runs the full L1–L4 sweep** (GH 2805): its `suite` job is gone, so pull requests run only the `l1` and `dashboard` jobs. The full `tests/run-all.ts` sweep runs only in release-gate at rc. CONTRIBUTING.md and tests/README.md say so, and the `pr-check-full-suite` L1 lint now fails if a full-sweep job comes back to pr-check.
