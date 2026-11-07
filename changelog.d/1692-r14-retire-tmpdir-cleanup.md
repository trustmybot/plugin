### Removed
- **The dead `tests/lib/tmpdir-cleanup.sh` helper is gone** (GH 1692): it gave shell tests an EXIT-trap `tmpdir_cleanup` that retried removing their scratch directory, and no test sources it now that those suites are node:test.
