### Fixed
- **The L1 lint meta checks now cover lints ported to node:test** (GH 2432): the run-all self-check that every `tests/l1-lint` lint is wired into `tests/run-all.sh`, and the `no-tmp-writes` self-test that runs the L1 lints under an isolated HOME, both globbed only `*.sh`, so they skipped every `*.test.mjs` lint. Both now include `tests/l1-lint/*.test.mjs`.
