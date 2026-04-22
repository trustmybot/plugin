# Task Specs

All NEW task specs are markdown — see `docs/trustmybot/SPEC-FORMAT.md`.

Filenames map from `branch_id` with `/` → `-`:

  feat/user-login → docs/trustmybot/tasks/feat-user-login.md

## Historical XML specs

Files matching `phase-1-*.xml` and `phase-2-*.xml` are HISTORICAL.
They were the format used during the v0.3 Phase 1 + Phase 2
transition. They are kept in tree as an audit trail and are
NOT regenerated. Their `<reviewed-by>` / `<closed-by>` tags are
the canonical sign-off record for those tasks; SQLite
`validation_attempts` is empty for them (the rows pre-date Phase 2
schema migration).

`scripts/hooks/require-review-sign.sh` skips any XML spec with
`status="completed"` AND a `<reviewed-by>` tag — historical XMLs
pass through automatically.
