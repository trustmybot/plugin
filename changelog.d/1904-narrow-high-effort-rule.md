### Changed
- **swe runs at `high` effort only where a miss fails open** (GH 1904): planning raises effort for enforcement logic that can deny, a schema or migration, or prompt-bearing work; editing a DB-layer, write-handler or hook file without changing what it admits or denies now stays `medium`.
