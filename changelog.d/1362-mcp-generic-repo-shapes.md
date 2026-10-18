### Fixed
- **MCP server no longer assumes this repository's layout** (GH 1362): the close-time scope listing groups extra paths by top-level directory, `parent_branch_id` accepts the repo's target, protected or existing branches instead of a fixed `dev`/`main`/`master` set, and the `dev` fallbacks resolve the repo's real default branch.
