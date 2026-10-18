### Added
- **`issue_update` changes an issue's milestone, labels and objective after creation** (GH 1351, GH 1260): the local row no longer drifts from GitHub when a milestone or label changes; the change is mirrored to the linked gh/glab issue, and `issue_adopt_remote` now copies the remote's milestone and labels into empty local columns.
