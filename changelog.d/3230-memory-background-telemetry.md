### Changed
- **MEMORY.md says when a write may run in the background** (GH 3230): decisions, anything a later step reads back, still reach the DB before the work moves on; telemetry nothing on the hot path reads back may be queued and written in the background.
