### Added
- **The trajectory DB can record close-lint runs** (GH 2570): new `lint_runs` and `lint_run_results` tables hold each run of the repo's close lints, keyed by task and commit, with a fingerprint over the files the lints read. They mirror `verification_runs`, and the swe close gate and `integrate` write them. The trajectory DB moves to schema v69 on the next session start.
