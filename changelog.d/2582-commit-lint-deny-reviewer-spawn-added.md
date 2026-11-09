### Added
- **`bro_atomic_close` returns the code-reviewer spawn** (GH 2582): called with `session_id`, it returns `reviewer_spawn` {`prompt`, `effort`, `subagent_type`}, an Agent call the spawn gates accept as is: every review anchor as `name=value` plus one line, at the assigned reviewer effort. Without `session_id` it returns `reviewer_spawn_unavailable: 'session_id'`.
