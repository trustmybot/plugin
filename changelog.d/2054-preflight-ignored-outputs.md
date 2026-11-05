### Fixed
- **The code-reviewer preflight's `stale_doc_ref` check no longer counts a path the commit's own `.gitignore` files ignore as removed** (GH 2054): untracking build output that the commit's `.gitignore` covers is not a deletion, so docs that mention it no longer block the review. A plain deletion still denies, and when the ignore check fails the path still counts as removed.
