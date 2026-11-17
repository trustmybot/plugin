### Changed
- **GIT.md and TASKS.md plan what happens when the base moves after a PR is open** (GH 3227): the branch is left alone while the forge can still merge it; otherwise the reviewed commit is rebased and force-pushed to the same PR, and the push gate checks only the commits the push adds.
