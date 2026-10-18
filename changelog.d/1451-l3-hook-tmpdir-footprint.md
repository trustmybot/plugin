### Fixed
- **L3 hook suite no longer fails the release-gate TMPDIR footprint check** (GH 1451): four hook tests (cmd-analysis, git-guards, git-push-guard-first-push, roundtable-slash-detect) left mktemp directories behind on Linux; each now removes the directories it creates.
