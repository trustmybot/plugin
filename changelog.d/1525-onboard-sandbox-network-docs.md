### Changed
- **`/onboard` and the config-key reference now describe the sandbox network allow-list** (GH 1525): Round 5 of `/onboard` says that answering **yes** to `sandbox_enforcement` also limits Bash network access to GitHub, npm and the hosts of the repo's HTTPS remotes, and `docs/reference/CONFIG_KEYS.md` lists `allowed_domains` in the `sandbox_settings` record.
