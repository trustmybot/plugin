### Fixed
- **The world model shows which gates each router entry runs** (GH 2185). A router entry in the L1 hook index is now named `<Event>#<pos>:<first gate>`, lists its gates and has one `runs` edge per gate. The extractor version is bumped, so the next scan re-parses every file once.
