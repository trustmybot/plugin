### Fixed
- The l3-runners test no longer writes to `/tmp` (GH 2420): `tests/lib/tmp-footprint.mjs` watches `TMB_TMP_FOOTPRINT_ROOT` (default `/tmp`, so runners are unchanged) and names that root in its messages, and `l3-runners.test.ts` points it at a dir in its sandbox, so the test passes inside the Bash sandbox, which refused its `/tmp` write with EPERM.
