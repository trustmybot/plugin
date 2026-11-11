### Fixed
- **The trajectory-server test suites pass again after the review-before-close change** (GH 2952): tests that close a task now record a passing review first, the completion-report and reviewer-note checks are tested where they now run (the review handoff), and the code-reviewer spawn gate test expects its current deny message.
