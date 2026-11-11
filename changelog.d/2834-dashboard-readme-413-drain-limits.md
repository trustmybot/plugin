### Fixed
- **The dashboard README states when an oversized write gets no response** (GH 2834): it said a body over 2 MB gets a 413 once the server discards the rest of the upload, but left out the limits on that discard. It now says the server discards at most 8 MiB in total and waits at most 2 s, then closes the connection without a response, and that config writes follow the same rule.
