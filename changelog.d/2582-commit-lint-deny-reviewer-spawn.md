### Changed
- **commit-msg-lint denies a bad commit subject** (GH 2582): a `git commit -m` (`--amend` included) whose subject is not `<emoji> <type>(<scope>): <msg>` within 72 characters is now denied instead of warned about. The deny names the rule broken, the subject seen and the expected form. The emoji must be one emoji or a `:shortcode:`, `research` joins the types, and length counts code points in every locale. `--fixup`, `--squash`, `--no-edit`, `--merge` and commits with no visible message still pass, and `TMB_SKIP_COMMIT_MSG_LINT=1` still lifts the lint.

### Added
- **`bro_atomic_close` returns the code-reviewer spawn** (GH 2582): called with `session_id`, it returns `reviewer_spawn` {`prompt`, `effort`, `subagent_type`}, an Agent call the spawn gates accept as is: every review anchor as `name=value` plus one line, at the assigned reviewer effort. Without `session_id` it returns `reviewer_spawn_unavailable: 'session_id'`.
