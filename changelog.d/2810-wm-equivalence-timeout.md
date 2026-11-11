### Fixed
- **The world-model equivalence replay no longer times out under heavy machine load** (GH 2810): the replay over the plugin's own history now runs one test per replayed commit, each with its own time limit, so a slow machine can't time out the whole replay at once.
