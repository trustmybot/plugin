### Fixed
- **The retired-hook-path lint passes on dev again** (GH 2373): a small-hooks L3 test built its fixture path as the literal `scripts/hooks/extra.sh`, which the lint reads as a retired hook path. The test now joins the path from its segments, so the lint no longer flags it and the test's assertions are unchanged.
