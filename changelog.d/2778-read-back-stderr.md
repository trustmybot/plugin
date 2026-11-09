### Fixed
- **Issue sync read-back failures now say why** (GH 2778): when the `gh` or `glab` read-back after creating a remote issue exits non-zero, the `verify_failed` message now ends in `read_back_non_zero_exit: <first stderr line>` (at most 200 characters), such as `HTTP 401: Bad credentials`, instead of a bare `read_back_non_zero_exit`.
