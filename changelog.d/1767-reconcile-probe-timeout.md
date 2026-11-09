### Fixed
- **The cheatcode reconcile probe-gating test no longer fails under full-suite load** (GH 1767): its shim `claude` probe ran with the production 4-second timeout, so a slow run marked the cheatcode `broken` instead of `active`. The suite now sets `TMB_CHEATCODE_HEALTHCHECK_TIMEOUT` to 30 seconds and restores the previous value afterwards. The production timeout is unchanged.
