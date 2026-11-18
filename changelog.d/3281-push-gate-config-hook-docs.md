### Changed
- **GIT.md names the push gate's hook in the repo's local git config** (GH 3281): git runs it beside the project's own hooks, so TMB touches no hooks folder; a leftover hook admits every push, and a git older than 2.54 keeps today's judge.
