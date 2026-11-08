### Changed
- **The post-close README nudge skips generated, fragment and test dirs and caps its list** (GH 1965): the `post-atomic-close-readme` PostToolUse hook no longer flags every dir a closed commit touched.
  - **Skip list.** A dir with a path segment in the new `plugin_config` key `readme_nudge_skip_dirs` is skipped. Unset or malformed, it reads as `dist`, `build`, `changelog.d`, `fixtures`, `test`, `tests`, `__tests__` and `node_modules`.
  - **Missing READMEs only on added files.** A README-less dir is reported only when the commit adds a file there (a rename into it counts), not each time an existing file in it changes.
  - **Cap.** The nudge lists at most 10 dirs, then `and N more`. The `readme_staleness_surfaced` audit row still records every dir.
