### Fixed
- **Clearer reason when the doctor skips `verification_recorded_for_closed_tasks`** (GH 1600): the skip reason was `no_v36_timestamp`, a migration detail; it is now `no_verification_runs_recorded`, which says what is actually missing.
