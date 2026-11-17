### Changed
- **GIT.md drafts the push gate at git's own pre-push hook** (GH 3281): the gate reads what git says is pushed, judges a branch by its net diff against the base, closes a task only after integrate, and applies a repo's policy only once it is confirmed. Planned and not prototyped.
