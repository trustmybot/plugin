### Changed
- **No-code tasks verify only what they touch** (GH 3160): the planning skill now tells bro that a no-code task's verification list holds only the greps and lints that cover the files it changes, not the full test suite, so docs and prompt closes no longer time out.
