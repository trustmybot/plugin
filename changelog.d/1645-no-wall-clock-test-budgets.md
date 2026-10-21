### Fixed
- **Task closes no longer fail on a busy machine** (GH 1645): two unit tests in the close gate asserted absolute wall-clock budgets (onboard pre-scan under 2 s, scan timeout under 3 s) and failed nondeterministically under load. They now assert only the behavior they cover, so an unrelated task's close is not blocked by host load.
