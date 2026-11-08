### Fixed
- **`diffDownstream` counts a repeated path once** (GH 1988): a path listed twice in the change set was processed twice, so its symbols showed up twice in `changed` and `added`. The last entry for a path now wins, as in a path-to-content map.
- **The world model's git probes accept a relative repo path** (GH 2004): `runGit` passed the repo path both as `git -C` and as the working directory, so a relative path resolved twice and git ran in the wrong place. It now resolves the path once and uses that for both.
