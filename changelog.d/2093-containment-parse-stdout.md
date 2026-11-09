### Fixed
- **The containment-guard L3 test no longer fails when a hook writes to stderr under load** (GH 2093): the test now parses the hook decision from stdout only and checks stderr is empty as its own assertion, which names the stream and its text.
