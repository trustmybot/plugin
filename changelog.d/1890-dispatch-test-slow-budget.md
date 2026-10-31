### Fixed
- **The L3 hook suite no longer kills `dispatch.test.sh` at its timeout** (GH 1890): the file runs about 126-140s against the runner's 120s default, so it reported FAIL without a failing assertion. It now has the 240s slow-file budget.
