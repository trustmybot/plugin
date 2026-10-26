### Fixed
- **The dispatcher suite passes the no-wall-clock-asserts lint on dev** (GH 1876, GH 1870): `dispatch.test.sh` no longer times the 300-lock-dir sweep; the fork-count asserts (1–2 `find`, at most 1 `rm`) still prove the single pass.
