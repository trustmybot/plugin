### Fixed
- **Renaming a repo keeps its pull requests** (GH 2572): `repo_rename` left the synced `prs` rows under the old repo name, so the dashboard's PR tiles lost them and the next PR sync fetched them all again. It now moves them with the repo's other rows in the same transaction and reports the count under `rows_by_table.prs`.
