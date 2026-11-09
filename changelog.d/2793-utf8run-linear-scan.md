### Fixed
- **commit-msg-lint reads long byte-escape runs fast** (GH 2793): a `$'…'` commit message holding a long run of ASCII byte escapes, such as 10000 `\x41`, took seconds to read, because the reader rescanned the rest of the run at every escape. Each run is now read once; what the lint admits or denies is unchanged.
