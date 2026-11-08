### Changed
- **PR checks run every L1 lint** (GH 2064, GH 2492): `pr-check.yml` drops its `TMB_L1_SKIP`, so the tool-description-budget lint now gates each pull request too. `TMB_L1_SKIP` itself stays available for local runs.
