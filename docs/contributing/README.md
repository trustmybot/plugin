# docs/contributing/

Controlled-vocabulary registries — the source-of-truth names that hooks branch on, skills assert on, and bro routes by. Consult these before adding or renaming an enum value, a label, or a feature stem; a silent rename here breaks downstream code without a compile error.

| File | Purpose |
|---|---|
| [`ENUMS.md`](./ENUMS.md) | Source of truth for every controlled vocabulary (status, kind, role, …) in the trajectory DB |
| [`LABELS.md`](./LABELS.md) | The shared issue-label set used by GitHub, Linear, and the local `issue_labels` table |
| [`CHANGELOG_AND_REBASES.md`](./CHANGELOG_AND_REBASES.md) | How a branch records its change (`changelog.d/` fragments) and how generated files survive a rebase (the `tmb-regen` merge driver + `regen-generated.sh`) |
| [`NAMING.md`](./NAMING.md) | The one-stem-per-feature rule — every surface implementing/testing/documenting a feature uses the same name |
