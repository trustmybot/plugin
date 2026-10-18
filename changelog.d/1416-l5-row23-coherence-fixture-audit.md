### Fixed
- **L5 row 23-bulk-cleanup scores again** (GH 1416): its coherence scorer counted the fixture-seeded deep_scan_completed audit row as a bro write; the audit assertion now excludes that row.
