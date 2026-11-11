### Changed
- **Specs verify the tests for the paths a task touches, and the full suite runs in CI** (GH 2497): a spec's `verification[]` now lists the tests for the touched paths plus the repo's type check or lint, and leaves the full suite to CI when the repo's CI workflows run it before merge. A repo with no such CI keeps its full suite in `verification[]`.
