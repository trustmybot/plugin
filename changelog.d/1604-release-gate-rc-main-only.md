### Changed
- **Dev merges no longer wait on the release gate** (GH 1604): CONTRIBUTING drops the feature-branch and post-merge `dev` dispatches of release-gate. CI-affecting PRs to `dev` are validated by the local sweep, pr-reviewer and any PR checks; release-gate runs only when cutting an rc, and `main` still needs a green rc gate.
