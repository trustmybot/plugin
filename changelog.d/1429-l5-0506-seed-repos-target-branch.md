### Fixed
- **L5 row 05.06 seeds the policy the server actually reads** (GH 1429): `setup-l5.sh` wrote the drained `plugin_config.pr_target` key, so `task_provision` fell back to `main`; it now upserts `repos.target_branch='dev'`, and the row README and onboarding fixture header describe the `repos` source of truth.
