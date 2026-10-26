### Changed
- **swe no longer ends a run silently on a hook block** (GH 1914): when a hook deny names an allowed form, swe reruns the call that way and carries on; otherwise it closes the task `failed` and quotes the exact hook output in its final message, so every run ends through `task_update_status`.
