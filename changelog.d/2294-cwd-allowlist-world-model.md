### Fixed
- **The cwd-read lint passes again** (GH 2294): `tests/l1-lint/no-cwd-reads.sh` failed on the `process.cwd()` default in `resolveWorldModelRepo` that the world-model repo fallback (GH 1968) added. That read happens only when a world-model tool call names no repo, so it is now listed in `tests/l1-lint/cwd-allowlist.tsv` as a `fallback`. Internal test lint only; no behaviour change.
