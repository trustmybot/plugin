### Changed
- **The code-reviewer spawn no longer denies on a base conflict** (GH 3101): the preflight's `base_conflict` check is gone, so a task commit that conflicts with its PR target gets reviewed once it passes the other four checks. Base conflicts are resolved at merge time, where GitHub and the merge queue already catch them, instead of forcing a merge of the base before any review.
