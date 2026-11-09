### Fixed
- **The schema comment on `tasks.repo` now says it holds a registered repo name** (GH 2736): it described the column as a relative path such as "repos/backend", but it is a foreign key to `repos(name)`, the repo root's basename as listed by `repos_list`.
