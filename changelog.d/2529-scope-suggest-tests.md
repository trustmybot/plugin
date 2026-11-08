### Fixed
- **`scope_suggest` puts test files its search finds in `tests[]`** (GH 2529): a test file matching the objective used to land in `files[]` and `draft.files`; it now goes to `tests[]` with `via: 'search'`, like the tests found through anchors. The tool's schema also stops marking `objective` as required, since a call with only `anchors` already worked.
