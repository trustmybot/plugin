### Removed
- **`/monitor` is gone** (GH 3109): the slash command that fetched a PR's review comments is removed, since bro now triages them on its own. Nothing needs typing: when review comments reach a PR bro owns, through a PR-activity notification, a CI-monitor event, you pointing at the PR, or bro checking a PR it opened, bro loads comment triage itself.
