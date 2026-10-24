### Fixed
- **`shellcheck-hooks` passes on dev again** (GH 1708): `lock_adb` and `rows_after` in `tests/l3-integration/hooks/dispatch.test.sh` looped on a variable they never read, so shellcheck reported SC2034 after GH 1677 removed the other loops that used it. Both loops now use the discard name `_`. Their polling is unchanged.
