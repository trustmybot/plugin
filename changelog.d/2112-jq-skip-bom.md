### Fixed
- **Transcripts that start with a UTF-8 byte-order mark are metered again** (GH 2112): the hooks' JSON stream reader now skips a BOM at the start of its input, as jq does, so swe and code-reviewer spawn stats no longer come out as zeros for such a transcript.
