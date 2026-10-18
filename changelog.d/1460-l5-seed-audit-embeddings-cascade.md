### Fixed
- **L5/L6 seeds leave no dangling audit embeddings** (GH 1460): the chain seed and both row-05 setup scripts deleted the `deep_scan_completed` audit row through the sqlite3 CLI, where foreign keys are off, so the backfilled `audit_embeddings` row survived and the trajectory doctor reported an unhealthy foreign-key check; each now deletes the matching embeddings first.
