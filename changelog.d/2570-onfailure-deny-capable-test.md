### Fixed
- **The router-budgets tests pass again on dev** (GH 2570): they now expect `"onFailure": "block"` on every routed hook group that holds a gate able to deny, such as the PostToolUse Write/Edit group that runs `swe-edit-lint`, so gates fail closed. They share one check of which gates can deny with the hook-onfailure test.
