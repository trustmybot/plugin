### Fixed
- **L5 row 06.01-swe-retry runs again** (GH 1430): its setup seeded the failure feedback as a `concern` discussion, which the v29 kind CHECK rejects, so the row was skipped on every L5 run; it now seeds the feedback as a `note`.
